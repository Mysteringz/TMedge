#!/usr/bin/env python3
"""Proxmox-only ZIP worker and forced SSH commands. No shell, SQL input or arbitrary paths."""
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import unquote, urlsplit
import zipfile

TTL = 24 * 3600
ID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
TABLE = re.compile(r'training\.[a-z_][a-z0-9_]{0,62}')
CONFIG = '/etc/crowdaware-ml-exports/config.json'


class ExportError(Exception):
    pass


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def save(root, identifier, value):
    temporary = root / (identifier + '.json.tmp')
    temporary.write_text(json.dumps(value)); temporary.chmod(0o600)
    temporary.replace(root / (identifier + '.json'))


def tables(encoded):
    if len(encoded) > 8192:
        raise ExportError('invalid')
    try:
        value = json.loads(base64.b64decode(encoded, validate=True))
    except (ValueError, UnicodeError):
        raise ExportError('invalid')
    if (not isinstance(value, list) or not 1 <= len(value) <= 32
            or any(not isinstance(name, str) or not TABLE.fullmatch(name) for name in value)
            or len(set(value)) != len(value)):
        raise ExportError('invalid')
    return value


def database(config):
    path = Path(config['reader_url_file'])
    if path.stat().st_mode & 0o077:
        raise ExportError('configuration')
    url = urlsplit(path.read_text().strip())
    if (url.scheme not in ('postgres', 'postgresql') or url.username != 'crowdaware_reader'
            or url.path != '/crowdaware_training' or not url.hostname or not url.password or url.query or url.fragment):
        raise ExportError('configuration')
    return {'PATH': '/usr/bin:/bin', 'PGHOST': url.hostname, 'PGPORT': str(url.port or 5432),
            'PGDATABASE': 'crowdaware_training', 'PGUSER': 'crowdaware_reader', 'PGPASSWORD': unquote(url.password),
            'PGCONNECT_TIMEOUT': '10', 'PGAPPNAME': 'ml-data-remote-export',
            'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=7200000'}


def load_config(path):
    source = Path(path)
    if source.stat().st_mode & 0o077:
        raise ExportError('configuration')
    config = json.loads(source.read_text())
    allowed = {'root', 'reader_url_file', 'pg_dump', 'max_bytes', 'reserve_bytes'}
    if not isinstance(config, dict) or set(config) - allowed:
        raise ExportError('configuration')
    for name in ['root', 'reader_url_file', 'pg_dump']:
        if not isinstance(config.get(name), str) or not Path(config[name]).is_absolute():
            raise ExportError('configuration')
    for name, fallback in [('max_bytes', 16 * 1024 ** 3), ('reserve_bytes', 2 * 1024 ** 3)]:
        value = config.get(name, fallback)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= 2 ** 53 - 1:
            raise ExportError('configuration')
    root = Path(config['root'])
    if root.is_symlink() or not root.is_dir() or root.stat().st_mode & 0o077:
        raise ExportError('configuration')
    return config


def free_bytes(root):
    space = os.statvfs(root)
    return space.f_bavail * space.f_frsize


class Meter:
    def __init__(self, target, root, limit, maximum, reserve, progress):
        self.target, self.root = target, root
        self.limit, self.maximum, self.reserve = limit, maximum, reserve
        self.progress = progress
        self.size = self.checked = 0

    def write(self, data):
        size = max(self.size, self.target.tell() + len(data))
        if size > self.maximum:
            raise ExportError('too_large')
        if size > self.limit:
            raise ExportError('disk_full')
        result = self.target.write(data)
        self.size = size
        if self.size - self.checked > 16 * 1024 ** 2:
            self.target.flush(); self.checked = self.size
            if free_bytes(self.root) < self.reserve:
                raise ExportError('disk_full')
        self.progress(self.size)
        return result

    def tell(self):
        return self.target.tell()

    def seek(self, offset, whence=0):
        return self.target.seek(offset, whence)

    def flush(self):
        self.target.flush()


def generate(config, identifier, selection, maximum, reserve):
    root = Path(config['root']); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    maximum = min(maximum, config.get('max_bytes', 16 * 1024 ** 3))
    reserve = max(reserve, config.get('reserve_bytes', 2 * 1024 ** 3))
    with (root / '.generate.lock').open('a') as global_lock:
        try:
            fcntl.flock(global_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ExportError('busy')
        with (root / (identifier + '.lock')).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if (root / (identifier + '.json')).exists() or (root / (identifier + '.zip')).exists():
                raise ExportError('exists')
            env = database(config)
            available = free_bytes(root) - reserve
            if available < 256 * 1024 ** 2:
                raise ExportError('disk_full')
            started = time.monotonic()
            state = {'id': identifier, 'state': 'processing', 'tables': selection, 'bytes': 0, 'sha256': None,
                     'createdAt': int(time.time() * 1000), 'expiresAt': int((time.time() + TTL) * 1000)}
            save(root, identifier, state); emit({'state': 'processing', 'bytes': 0})
            last = time.monotonic()

            def progress(size):
                nonlocal last
                if time.monotonic() - started > 7200:
                    raise ExportError('interrupted')
                state['bytes'] = size
                if time.monotonic() - last >= 5:
                    save(root, identifier, state)
                    emit({'state': 'processing', 'bytes': size})
                    last = time.monotonic()

            child = None; timeout = None
            part = root / (identifier + '.part')
            try:
                command = [config['pg_dump'], '--format=plain', '--no-owner', '--no-privileges', '--no-password',
                           '--strict-names', '--lock-wait-timeout=10s']
                for name in selection:
                    command += ['--table', 'training."' + name[9:] + '"']
                child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
                def kill_stuck_dump():
                    if child.poll() is None:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                timeout = threading.Timer(7200, kill_stuck_dump); timeout.start()
                with part.open('xb') as destination:
                    part.chmod(0o600)
                    meter = Meter(destination, root, min(maximum, available), maximum, reserve, progress)
                    with zipfile.ZipFile(meter, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=6) as archive:
                        manifest = {'format': 'PostgreSQL plain SQL', 'tables': selection,
                                    'createdAt': datetime.now(timezone.utc).isoformat(),
                                    'note': 'Selected tables only. Foreign-key dependencies outside the selection are not included. Restore into a separate database with matching schema dependencies.'}
                        archive.writestr('manifest.json', json.dumps(manifest, indent=2))
                        with archive.open('dataset.sql', 'w', force_zip64=True) as sql:
                            sql.write(b'CREATE SCHEMA IF NOT EXISTS training;\n')
                            while block := child.stdout.read(65536):
                                sql.write(block)
                        if child.wait(timeout=15):
                            raise ExportError('database')
                        timeout.cancel()
                digest = hashlib.sha256()
                with part.open('rb') as source:
                    while block := source.read(1024 ** 2):
                        digest.update(block); progress(part.stat().st_size)
                state.update(state='completed', bytes=part.stat().st_size, sha256=digest.hexdigest(),
                             expiresAt=int((time.time() + TTL) * 1000))
                part.replace(root / (identifier + '.zip'))
                save(root, identifier, state)
                emit({key: state[key] for key in ['state', 'bytes', 'sha256', 'expiresAt']})
            except BaseException as error:
                state.update(state='failed', error=str(error) if isinstance(error, ExportError) else 'interrupted',
                             expiresAt=int((time.time() + TTL) * 1000))
                part.unlink(missing_ok=True); (root / (identifier + '.zip')).unlink(missing_ok=True)
                save(root, identifier, state)
                raise
            finally:
                if timeout:
                    timeout.cancel()
                if child:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL); child.wait()
                    child.stdout.close()


def download(config, identifier, start, length, output):
    root = Path(config['root'])
    # A shared lock leases the archive for this entire stream, even beyond its expiry.
    with (root / (identifier + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        state = json.loads((root / (identifier + '.json')).read_text())
        archive = root / (identifier + '.zip')
        if (state.get('state') != 'completed' or state.get('expiresAt', 0) <= time.time() * 1000
                or archive.is_symlink() or archive.stat().st_size != state.get('bytes')):
            raise ExportError('unavailable')
        if start < 0 or length < 1 or start + length > state['bytes']:
            raise ExportError('invalid')
        with archive.open('rb') as source:
            source.seek(start)
            while length:
                block = source.read(min(65536, length))
                if not block:
                    raise ExportError('unavailable')
                output.write(block); length -= len(block)


def cleanup(config, now=None):
    root = Path(config['root'])
    now = time.time() * 1000 if now is None else now
    deleted = 0
    for path in root.glob('*.json'):
        identifier = path.stem
        if not ID.fullmatch(identifier):
            continue
        try:
            with (root / (identifier + '.lock')).open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                state = json.loads(path.read_text())
                if state.get('expiresAt', now + 1) > now:
                    continue
                for suffix in ['.zip', '.part', '.json', '.json.tmp']:
                    (root / (identifier + suffix)).unlink(missing_ok=True)
                deleted += 1
        except (OSError, ValueError):
            continue
    return deleted


def dispatch(config, command, output):
    args = shlex.split(command)
    if not 2 <= len(args) <= 5 or not ID.fullmatch(args[1]):
        raise ExportError('invalid')
    operation, identifier = args[:2]
    if operation == 'generate' and len(args) == 5:
        maximum, reserve = int(args[3]), int(args[4])
        if maximum < 1 or reserve < 1:
            raise ExportError('invalid')
        generate(config, identifier, tables(args[2]), maximum, reserve)
    elif operation == 'download' and len(args) == 4:
        download(config, identifier, int(args[2]), int(args[3]), output)
    else:
        raise ExportError('invalid')


def interrupted(_signal, _frame):
    raise ExportError('interrupted')


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGHUP, interrupted)
    try:
        config = load_config(CONFIG)
        if sys.argv[1:] == ['cleanup']:
            print('Expired Proxmox exports removed:', cleanup(config))
        elif sys.argv[1:]:
            raise ExportError('invalid')
        else:
            dispatch(config, os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdout.buffer)
    except BaseException as error:
        # Download stdout is binary. Never mix diagnostics into a partial ZIP stream.
        if os.environ.get('SSH_ORIGINAL_COMMAND', '').startswith('generate '):
            try:
                emit({'state': 'failed', 'error': str(error) if isinstance(error, ExportError) else 'interrupted'})
            except OSError:
                pass
        raise SystemExit(1)
