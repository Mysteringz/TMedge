#!/usr/bin/env python3
"""Prepare a durable file-mode registry without restarting the live services.

Dry-run by default. The environment backup contains secrets: it stays private
beside the original and is never printed. The normal approved deployment loads
the new path. A private directory within DATA_DIR supports atomic replacement
without granting the service write access to the shared environment directory.
"""
import argparse
import json
import os
import pathlib
import re
import tempfile
import time


def prepare(env_path, release, apply=False):
    env_path, release = pathlib.Path(env_path), pathlib.Path(release).resolve()
    original = env_path.read_text()
    values = {}
    for line in original.splitlines():
        match = re.match(r'^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$', line)
        if match:
            name, value = match.groups()
            if name in values:
                raise ValueError('duplicate environment setting; resolve it before migration')
            values[name] = value.strip().strip('"').strip("'")
    if values.get('PERSISTENCE_MODE', 'file') != 'file':
        raise ValueError('this preparation is only for file-mode registration')
    if values.get('NODES_CONFIG'):
        raise ValueError('NODES_CONFIG already exists; review the current persistent registry')
    data = pathlib.Path(values.get('DATA_DIR', ''))
    if not data.is_absolute() or not data.is_dir():
        raise ValueError('DATA_DIR must be an existing absolute persistent directory')
    data = data.resolve()
    if data.is_relative_to(release) or 'tmedge-releases' in data.parts:
        raise ValueError('DATA_DIR must survive a release')
    source = release / 'config' / 'nodes.json'
    encoded = source.read_bytes()
    doc = json.loads(encoded)
    if not isinstance(doc, dict) or not isinstance(doc.get('nodes'), list) or not doc['nodes']:
        raise ValueError('live node registry is invalid or empty')
    uids = [node.get('uid') if isinstance(node, dict) else None for node in doc['nodes']]
    if any(not isinstance(uid, str) or not re.fullmatch(r'[0-9a-f]{2}(:[0-9a-f]{2}){5}', uid) for uid in uids) or len(set(uids)) != len(uids):
        raise ValueError('live registry has invalid or duplicate identities')
    directory = data / 'adoption'
    target = directory / 'nodes.json'
    if directory.exists():
        raise ValueError('adoption storage already exists; inspect it before migration')
    print(f'Prepare {len(uids)} existing nodes at {target}; no restart or device change')
    if not apply:
        return
    owner = data.stat()
    directory.mkdir(mode=0o700)
    os.chown(directory, owner.st_uid, owner.st_gid)
    # Exclusive creation prevents replacing a registry prepared by somebody
    # else between the dry run and application.
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(encoded)
    os.chmod(target, 0o600)
    os.chown(target, owner.st_uid, owner.st_gid)
    env_stat = env_path.stat()
    backup = env_path.with_name(env_path.name + '.before-adoption-' + str(time.time_ns()))
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(original.encode())
    os.chmod(backup, 0o600)
    os.chown(backup, env_stat.st_uid, env_stat.st_gid)
    replacement = original.rstrip('\n') + '\nNODES_CONFIG=' + str(target) + '\n'
    fd, temporary = tempfile.mkstemp(prefix='.adoption-env-', dir=env_path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(replacement)
        os.chmod(temporary, 0o600)
        os.chown(temporary, env_stat.st_uid, env_stat.st_gid)
        os.replace(temporary, env_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Prepared. The next approved release loads the persistent registry.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    prepare(args.env, args.release, args.apply)
