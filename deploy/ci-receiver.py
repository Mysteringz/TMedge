#!/usr/bin/env python3
"""Root-owned forced-command receiver: no shell, forwarding, or rsync access."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release import extract, MAX_BYTES

BASE = Path('/opt/tmedge-releases')
REMOTE = Path(__file__).resolve().parent / 'remote.sh'


def main():
    # SSH_ORIGINAL_COMMAND arrives as one argument from the forced command.
    command = sys.argv[1] if len(sys.argv) == 2 else ''
    match = re.fullmatch(r'deploy ([0-9a-f]{64})', command)
    if command == 'status':
        subprocess.run(['bash', str(REMOTE), 'list'], check=True)
        return
    if not match:
        raise ValueError('only status and deploy <sha256> are permitted')
    BASE.mkdir(exist_ok=True)
    # Serialize the complete receive/install/switch transaction. remote.sh also
    # takes the shared activation lock used by manual deployments.
    with (BASE / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='.incoming-', dir=BASE) as temp:
            archive = Path(temp) / 'release.tar.gz'
            size = 0
            digest = hashlib.sha256()
            with archive.open('wb') as output:
                while True:
                    block = sys.stdin.buffer.read(1024 * 1024)
                    if not block:
                        break
                    size += len(block)
                    if size > MAX_BYTES:
                        raise ValueError('archive exceeds size limit')
                    digest.update(block)
                    output.write(block)
            if digest.hexdigest() != match[1]:
                raise ValueError('upload checksum mismatch')
            stage = Path(temp) / 'stage'
            meta = extract(archive, stage)
            target = BASE / meta['id']
            if target.exists() or target.is_symlink():
                raise ValueError('release id already exists; refusing overwrite')
            os.rename(stage, target)
            try:
                subprocess.run(['bash', str(REMOTE), 'activate', meta['id']], check=True,
                               env={**os.environ, 'TM_LOCK_HELD': '1'})
            except subprocess.CalledProcessError:
                # A dependency-install failure happens before remote.sh switches.
                # Never offer that incomplete release as a rollback candidate.
                live = BASE.parent / 'tmedge'
                if target.exists() and (not live.is_symlink() or live.resolve() != target):
                    shutil.rmtree(target)
                raise
            print(json.dumps({'deployed': meta['id'], 'commit': meta['commit']}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit('receiver: ' + str(error))
