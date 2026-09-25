#!/usr/bin/env python3
"""Build and validate a runtime-only release. No archive member is trusted."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ID = re.compile(r'^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9-]+$')
ROOT_FILES = {'package.json', 'package-lock.json', 'RELEASE.json', 'MANIFEST.json'}
ROOT_DIRS = {'dist', 'public-web', 'public-console', 'public-algo', 'config'}
MAX_BYTES = 256 * 1024 * 1024


def safe_name(name):
    p = PurePosixPath(name)
    if (p.is_absolute() or '..' in p.parts or not p.parts or
            any(x.startswith('.') for x in p.parts) or str(p) != name):
        raise ValueError('unsafe archive path')
    if p.parts[0] not in ROOT_DIRS and name not in ROOT_FILES:
        raise ValueError('unexpected runtime file: ' + name)
    return p


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(root):
    manifest = json.loads((root / 'MANIFEST.json').read_text())
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError('missing file manifest')
    actual = set()
    for name, digest in manifest.items():
        safe_name(name)
        path = root / name
        if not re.fullmatch('[0-9a-f]{64}', digest) or not path.is_file() or path.is_symlink():
            raise ValueError('invalid manifest entry: ' + name)
        if sha(path) != digest:
            raise ValueError('release integrity failure: ' + name)
    for path in root.rglob('*'):
        name = path.relative_to(root).as_posix()
        # These are server-managed, never part of an uploaded artifact.
        if name.split('/')[0] in {'node_modules', '.env', 'data', 'QUARANTINED'}:
            continue
        if path.is_symlink():
            raise ValueError('release symlink: ' + name)
        if path.is_file() and name != 'MANIFEST.json':
            actual.add(name)
    if actual != set(manifest):
        raise ValueError('unlisted or missing release files')
    meta = json.loads((root / 'RELEASE.json').read_text())
    if not ID.fullmatch(meta['id']) or not re.fullmatch('[0-9a-f]{40}', meta['commit']):
        raise ValueError('invalid release metadata')
    for name in ('dist/src/web/main.js', 'dist/src/edge/main.js', 'public-web/index.html',
                 'public-algo/index.html', 'package-lock.json'):
        if name not in manifest:
            raise ValueError('missing required file: ' + name)
    return meta


def extract(archive, destination):
    # Prevalidate every member before creating files; reject links, duplicates,
    # devices and traversal. Never use extractall on a privileged receiver.
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        names = set()
        total = 0
        for member in members:
            safe_name(member.name)
            if member.name in names or not (member.isfile() or member.isdir()):
                raise ValueError('duplicate or non-regular archive member')
            names.add(member.name)
            total += member.size
            if total > MAX_BYTES or len(names) > 20000:
                raise ValueError('release exceeds extraction limit')
        destination.mkdir(mode=0o755)
        for member in members:
            path = destination / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with tar.extractfile(member) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o644)
    return verify(destination)


def package(root, archive):
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    firmware = (root / 'ci/tmsense.ref').read_text().strip()
    dirty = bool(subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain'], text=True).strip())
    if os.environ.get('GITHUB_EVENT_NAME') == 'push' and dirty:
        raise ValueError('CI build changed tracked sources or left untracked files')
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    meta = dict(id=now.strftime('%Y%m%dT%H%M%SZ-') + commit[:12] + ('-dirty' if dirty else ''), commit=commit, dirty=dirty,
                firmwareCommit=firmware, builtAt=now.isoformat(),
                runId=os.environ.get('GITHUB_RUN_ID'), runAttempt=os.environ.get('GITHUB_RUN_ATTEMPT'))
    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp)
        for name in ROOT_DIRS:
            source = root / name
            if not source.is_dir():
                raise ValueError('missing build output: ' + name)
            if name == 'dist':
                source = source / 'src'
                destination = stage / name / 'src'
            else:
                destination = stage / name
            shutil.copytree(source, destination, symlinks=True,
                            ignore=shutil.ignore_patterns('.DS_Store', '*.map'))
        for name in ('package.json', 'package-lock.json'):
            shutil.copyfile(root / name, stage / name)
        (stage / 'RELEASE.json').write_text(json.dumps(meta, indent=2) + '\n')
        files = sorted(p for p in stage.rglob('*') if p.is_file())
        for path in stage.rglob('*'):
            safe_name(path.relative_to(stage).as_posix())
            if path.is_symlink():
                raise ValueError('symlink in runtime build')
        (stage / 'MANIFEST.json').write_text(json.dumps({p.relative_to(stage).as_posix(): sha(p) for p in files}, indent=2) + '\n')
        verify(stage)
        archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, 'w:gz') as tar:
            for path in sorted(stage.rglob('*')):
                tar.add(path, arcname=path.relative_to(stage).as_posix(), recursive=False)
    archive.with_suffix(archive.suffix + '.sha256').write_text(sha(archive) + '  ' + archive.name + '\n')
    print(json.dumps(meta))


if __name__ == '__main__':
    try:
        cmd, *args = sys.argv[1:]
        if cmd == 'package':
            package(Path(args[0]).resolve(), Path(args[1]).resolve())
        elif cmd == 'verify':
            print(json.dumps(verify(Path(args[0]))))
        elif cmd == 'extract':
            print(json.dumps(extract(Path(args[0]), Path(args[1]))))
        else:
            raise ValueError('unknown release command')
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        sys.exit('release: ' + str(error))
