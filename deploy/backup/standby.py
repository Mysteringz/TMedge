#!/usr/bin/env python3
"""Refresh private standby state and promote only primary-verified releases."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tarfile
import tempfile
import time

PRIVATE = Path('/etc/tmedge-backup')
DATA = Path('/var/lib/tmedge')
STATE_MAP = {
    'opt/tmedge-shared/.env': Path('/opt/tmedge-shared/.env'),
    'opt/tmedge-shared/ai-knowledge.md': Path('/opt/tmedge-shared/ai-knowledge.md'),
    'var/lib/tmedge/adoption/nodes.json': DATA / 'adoption/nodes.json',
    'var/lib/tmedge/session-revocations.json': DATA / 'session-revocations.json',
    'var/lib/tmedge/student-token-revocations.json': DATA / 'student-token-revocations.json',
    'var/lib/tmedge/algo/users.json': DATA / 'algo/users.json',
    'var/lib/tmedge/algo/session-revocations.json': DATA / 'algo/session-revocations.json',
    'var/lib/tmedge/algo/account-settings.json': DATA / 'algo/account-settings.json',
}


def ssh():
    cfg = json.loads((PRIVATE / 'config.json').read_text())
    host = cfg['primary_host']
    if not re.fullmatch(r'[a-zA-Z0-9.-]+', host):
        raise ValueError('invalid primary host')
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(PRIVATE / 'known_hosts'),
            '-i', str(PRIVATE / 'id_ed25519'), 'tmedge-backup@' + host]


def atomic(path, body, uid, gid):
    if path.is_symlink():
        raise ValueError('state destination is a symlink')
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        os.fchmod(stream.fileno(), 0o600)
        os.fchown(stream.fileno(), uid, gid)
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def standby_environment(body):
    lines = body.decode().splitlines()
    overrides = {
        'DATA_DIR': str(DATA), 'EDGE_ID': 'tmedge-backup', 'WEB_PUSH_URLS': '',
        'WEB_HOST': '0.0.0.0', 'UDP_HOST': '127.0.0.1', 'TMGW_HOST': '127.0.0.1',
        'CONSOLE_HOST': '127.0.0.1', 'SIGNUP_OPEN': '0',
        'NODES_CONFIG': str(DATA / 'adoption/nodes.json'), 'TRAINING_STORAGE': 'files',
        'PGHOST': '127.0.0.1', 'PGPORT': '5432', 'TMSENSE_DIR': '/opt/TMsense',
        'ML_PG_DUMP': '/usr/bin/pg_dump', 'EMAIL_FROM': '', 'EMAIL_SES_REGION': '',
        'EMAIL_CONSOLE_URL': '', 'EMAIL_SES_CONFIGURATION_SET': '',
        'PLATFORMIO_CORE_DIR': str(DATA / 'platformio'),
    }
    result = [line for line in lines if line.split('=', 1)[0] not in overrides]
    return ('\n'.join(result + [key + '=' + value for key, value in overrides.items()]) + '\n').encode()


def sync_state():
    account = pwd.getpwnam('tmedge')
    restart = set()
    with tempfile.TemporaryFile() as stream:
        subprocess.run([*ssh(), 'state'], stdout=stream, check=True)
        if stream.tell() > 2 * 1024 * 1024:
            raise ValueError('oversized standby state')
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r:gz') as archive:
            seen = set()
            files = []
            for member in archive:
                if member.name not in STATE_MAP or member.name in seen or not member.isfile() or member.size > 1024 * 1024:
                    raise ValueError('unexpected state archive member')
                seen.add(member.name)
                body = archive.extractfile(member).read()
                if member.name.endswith('/.env'):
                    body = standby_environment(body)
                elif member.name.endswith('/ai-knowledge.md'):
                    if len(body) > 16_000:
                        raise ValueError('knowledge exceeds model limit')
                    body.decode('utf8')
                else:
                    json.loads(body)
                files.append((STATE_MAP[member.name], body))
            if 'opt/tmedge-shared/.env' not in seen:
                raise ValueError('state has no primary environment')
            for path, body in files:
                if not path.exists() or path.read_bytes() != body:
                    atomic(path, body, account.pw_uid, account.pw_gid)
                    if path.name == 'ai-knowledge.md':
                        pass  # KnowledgeFile reloads the file on the next question.
                    elif path.name == '.env':
                        restart.update(('tmedge-edge', 'tmedge-web'))
                    elif path.parent == DATA:
                        restart.add('tmedge-web')
                    else:
                        restart.add('tmedge-edge')
    if restart:
        subprocess.run(['systemctl', 'try-restart', *sorted(restart)], check=True)


def sync_release():
    meta = json.loads(subprocess.check_output([*ssh(), 'status']))
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9-]+', meta['id']) or meta.get('dirty') is not False:
        raise ValueError('invalid primary release identity')
    if json.loads(Path('/opt/tmedge/RELEASE.json').read_text()).get('commit') == meta['commit']:
        return
    with tempfile.TemporaryDirectory(prefix='standby-release-') as temp:
        path = Path(temp) / 'release.tar.gz'
        with path.open('wb') as stream:
            subprocess.run([*ssh(), 'release'], stdout=stream, check=True)
        if path.stat().st_size > 256 * 1024 * 1024:
            raise ValueError('oversized release')
        # The normal receiver checks every member and manifest, activates
        # atomically and rolls back on failed application readiness.
        sys.path.insert(0, '/opt/tmedge-deploy')
        from release import extract
        extracted = extract(path, Path(temp) / 'inspect')
        if extracted != meta:
            raise ValueError('primary changed release during transfer')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open('rb') as stream:
            subprocess.run(['/opt/tmedge-deploy/ci-receiver.py', 'deploy ' + digest], stdin=stream,
                           env={**os.environ, 'TM_SERVICES': 'tmedge-edge tmedge-web'}, check=True)


if __name__ == '__main__':
    try:
        sync_state()
        if '--state-only' not in sys.argv:
            sync_release()
        PRIVATE.joinpath('last-sync.json').write_text(json.dumps({'at': int(time.time() * 1000)}))
        print('Private standby state and approved primary release synchronized')
    except Exception:
        sys.exit('Standby synchronization failed; primary service and last good standby are retained')
