#!/usr/bin/env python3
"""Restricted, read-only exports for a website standby; install as root."""
import io
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import subprocess
import sys
import tarfile

PRIVATE = Path('/etc/tmedge-backup-primary')
TOOLS = Path('/opt/tmedge-backup-primary')
STATE_FILES = (
    '/opt/tmedge-shared/.env',
    '/opt/tmedge-shared/ai-knowledge.md',
    '/var/lib/tmedge/adoption/nodes.json',
    '/var/lib/tmedge/session-revocations.json',
    '/var/lib/tmedge/student-token-revocations.json',
    '/var/lib/tmedge/algo/users.json',
    '/var/lib/tmedge/algo/session-revocations.json',
    '/var/lib/tmedge/algo/account-settings.json',
)


def sql(text):
    return subprocess.run(['sudo', '-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
                          input=text.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def install():
    key = sys.stdin.read().strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?', key):
        raise ValueError('expected one ed25519 public key')
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    secret = PRIVATE / 'replication-password'
    if not secret.exists():
        secret.write_text(secrets.token_hex(32))
    secret.chmod(0o600)
    password = secret.read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', password):
        raise ValueError('invalid replication credential')
    exists = sql("SELECT 1 FROM pg_roles WHERE rolname='tmedge_backup';").strip()
    if not exists:
        sql(f"CREATE ROLE tmedge_backup LOGIN REPLICATION PASSWORD '{password}';")
    sql("ALTER SYSTEM SET wal_keep_size='128MB';")
    hba = Path(sql('SHOW hba_file;').decode().strip())
    line = 'host replication tmedge_backup 127.0.0.1/32 scram-sha-256'
    if line not in hba.read_text().splitlines():
        with hba.open('a') as stream:
            stream.write('\n# Website standby through a restricted SSH forward.\n' + line + '\n')
    sql('SELECT pg_reload_conf();')
    try:
        account = pwd.getpwnam('tmedge-backup')
    except KeyError:
        subprocess.run(['useradd', '--create-home', '--shell', '/bin/bash', 'tmedge-backup'], check=True)
        account = pwd.getpwnam('tmedge-backup')
    sshdir = Path(account.pw_dir) / '.ssh'
    sshdir.mkdir(mode=0o700, exist_ok=True)
    auth = sshdir / 'authorized_keys'
    # Forwarding reaches only PostgreSQL's loopback listener; session commands
    # are the small exporter vocabulary, never a shell or a client-supplied path.
    auth.write_text('restrict,port-forwarding,permitopen="127.0.0.1:5432",'
                    'command="sudo -n /opt/tmedge-backup-primary/primary.py" ' + key + '\n')
    auth.chmod(0o600)
    for path in (sshdir, auth):
        os.chown(path, account.pw_uid, account.pw_gid)
    sudoers = Path('/etc/sudoers.d/tmedge-backup')
    sudoers.write_text('Defaults:tmedge-backup env_keep += "SSH_ORIGINAL_COMMAND"\n'
                       'tmedge-backup ALL=(root) NOPASSWD: /opt/tmedge-backup-primary/primary.py\n')
    sudoers.chmod(0o440)
    subprocess.run(['visudo', '-cf', str(sudoers)], check=True)
    print('Restricted standby exporter and replication role installed')


def export_state():
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as archive:
        for name in STATE_FILES:
            path = Path(name)
            if path.is_file() and not path.is_symlink():
                archive.add(path, arcname=name.lstrip('/'), recursive=False)


def export_release():
    live = Path('/opt/tmedge').resolve()
    sys.path.insert(0, '/opt/tmedge-deploy')
    from release import verify
    verify(live)
    manifest = json.loads((live / 'MANIFEST.json').read_text())
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as archive:
        for name in sorted([*manifest, 'MANIFEST.json']):
            archive.add(live / name, arcname=name, recursive=False)


def main():
    if sys.argv[1:] == ['install']:
        install()
        return
    if sys.argv[1:]:
        raise ValueError('unexpected argument')
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'state':
        export_state()
    elif command == 'release':
        export_release()
    elif command == 'status':
        print(Path('/opt/tmedge/RELEASE.json').read_text())
    elif command == 'replication-credential':
        sys.stdout.write((PRIVATE / 'replication-password').read_text())
    else:
        raise ValueError('only status, state, release and replication-credential are permitted')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('Standby export failed; inspect the private configuration on the primary')
