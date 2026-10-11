#!/usr/bin/env python3
"""Edge-side private report sync. Rendering stays entirely on Proxmox."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading


def extract(archive, output):
    total = 0
    seen = set()
    with tarfile.open(archive, 'r:gz') as bundle:
        for entry in bundle:
            name = PurePosixPath(entry.name)
            if (not entry.isfile() or name.is_absolute() or '..' in name.parts or not name.parts
                    or any(part.startswith('.') for part in name.parts) or entry.name in seen):
                raise ValueError('unsafe report entry')
            seen.add(entry.name); total += entry.size
            if total > 128 * 1024 ** 2 or len(seen) > 4096:
                raise ValueError('report exceeds extraction limits')
            target = Path(output).joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with bundle.extractfile(entry) as source, target.open('xb') as destination:
                shutil.copyfileobj(source, destination)
            target.chmod(0o600)
    if not (Path(output) / 'index.html').is_file() or not (Path(output) / 'diagrams/summary/relationships.real.large.png').is_file():
        raise ValueError('report or diagram missing')


def sync(args):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+', args.host):
        raise ValueError('invalid report host')
    if not 1 <= args.port <= 65535:
        raise ValueError('invalid report port')
    key = Path(args.identity_file)
    if key.stat().st_mode & 0o077:
        raise ValueError('report key must be private')
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ssh = ['ssh', '-F', '/dev/null', '-T', '-p', str(args.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'UserKnownHostsFile=' + str(Path(args.known_hosts).resolve()), '-i', str(key.resolve()), args.host]
    with (target.parent / '.schemaspy-sync.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = json.loads(subprocess.check_output(ssh + ['status'], timeout=20))
        if not isinstance(status, dict) or not re.fullmatch(r'[0-9a-f]{64}', str(status.get('sha256', ''))) or not isinstance(status.get('bytes'), int) or not 0 < status['bytes'] <= 64 * 1024 ** 2:
            raise ValueError('invalid report manifest')
        receipt = target.parent / '.schemaspy-synced.json'
        try:
            old = json.loads(receipt.read_text())
        except (OSError, ValueError):
            old = {}
        if old.get('sha256') == status['sha256'] and (target / 'index.html').is_file():
            return False
        with tempfile.TemporaryDirectory(prefix='.schemaspy-sync-', dir=target.parent) as work:
            archive = Path(work) / 'report.tar.gz'
            with archive.open('wb') as output:
                process = subprocess.Popen(ssh + ['report'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                deadline = threading.Timer(60, process.kill); deadline.start()
                try:
                    received = 0
                    while block := process.stdout.read(65536):
                        received += len(block)
                        if received > status['bytes']:
                            raise ValueError('report exceeds manifest size')
                        output.write(block)
                    if process.wait(timeout=10) or received != status['bytes']:
                        raise ValueError('report transfer failed')
                finally:
                    deadline.cancel()
                    if process.poll() is None:
                        process.kill(); process.wait()
                    process.stdout.close()
            with archive.open('rb') as source:
                digest = hashlib.sha256()
                for block in iter(lambda: source.read(65536), b''):
                    digest.update(block)
                if digest.hexdigest() != status['sha256']:
                    raise ValueError('report changed during transfer; retry next poll')
            stage = Path(work) / 'report'; stage.mkdir(mode=0o700); extract(archive, stage)
            previous = target.with_name(target.name + '.previous')
            if previous.exists():
                shutil.rmtree(previous)
            if target.exists():
                target.rename(previous)
            try:
                stage.rename(target)
            except Exception:
                if previous.exists():
                    previous.rename(target)
                raise
            receipt.write_text(json.dumps(status)); receipt.chmod(0o600)
            if previous.exists():
                shutil.rmtree(previous)
        return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=2222)
    parser.add_argument('--identity-file', required=True)
    parser.add_argument('--known-hosts', required=True)
    parser.add_argument('--output', required=True)
    try:
        print('SchemaSpy report synchronized.' if sync(parser.parse_args()) else 'SchemaSpy report is current.')
    except Exception:
        raise SystemExit('SchemaSpy sync failed; last published snapshot retained. Check the private report connection.')
