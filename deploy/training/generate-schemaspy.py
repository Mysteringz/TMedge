#!/usr/bin/env python3
"""Run on the Proxmox server. Publish a credential-free SchemaSpy snapshot.

Use a SELECT-only URL in a private file, matching installed Java/Graphviz,
SchemaSpy and PostgreSQL JDBC jars. The web app only serves the resulting files.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, unquote


def properties(value):
    return value.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('=', '\\=').replace(':', '\\:')


def generate(args):
    secret = Path(args.reader_url_file)
    if secret.stat().st_mode & 0o077:
        raise ValueError('reader URL file must be private (0600)')
    url = urlsplit(secret.read_text().strip())
    if url.scheme not in ('postgres', 'postgresql') or url.username != 'crowdaware_reader' or url.path != '/crowdaware_training' or url.query or url.fragment:
        raise ValueError('requires the dedicated training reader connection')
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (target.parent / '.schemaspy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='.schemaspy-', dir=target.parent) as work:
            root = Path(work)
            config = root / 'schemaspy.properties'
            settings = {'t': 'pgsql', 'host': url.hostname, 'port': str(url.port or 5432),
                        'db': 'crowdaware_training', 'u': 'crowdaware_reader', 'p': unquote(url.password or ''),
                        's': 'training', 'dp': str(Path(args.jdbc_jar).resolve()),
                        'o': str(root / 'report'), 'norows': 'true', 'noads': 'true', 'noimplied': 'true'}
            config.touch(mode=0o600)
            config.write_text(''.join('schemaspy.' + k + '=' + properties(v) + '\n' for k, v in settings.items()))
            # SchemaSpy logs connection details. Capture privately and never
            # forward its diagnostics to the browser or the system journal.
            result = subprocess.run(['java', '-jar', str(Path(args.schemaspy_jar).resolve()), '-configFile', str(config)],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
            if result.returncode:
                diagnostic = target.parent / 'schemaspy-error.log'
                diagnostic.touch(mode=0o600)
                diagnostic.chmod(0o600)
                diagnostic.write_bytes(result.stdout.replace(settings['p'].encode(), b'[REDACTED]'))
                raise RuntimeError('SchemaSpy failed; verify its private reader connection and tool versions')
            report = root / 'report'
            if not (report / 'index.html').is_file():
                raise RuntimeError('SchemaSpy did not produce a report')
            password = settings['p'].encode()
            for path in report.rglob('*'):
                if path.is_symlink():
                    raise RuntimeError('unexpected report symlink')
                if path.is_file() and password and password in path.read_bytes():
                    raise RuntimeError('report contains a credential; refusing publication')
            (report / 'generated.json').write_text(json.dumps({'generatedAt': int(time.time() * 1000), 'schema': 'training'}))
            old = target.with_name(target.name + '.previous')
            if old.exists():
                shutil.rmtree(old)
            if target.exists():
                target.rename(old)
            try:
                report.rename(target)
            except Exception:
                if old.exists():
                    old.rename(target)
                raise
            if old.exists():
                shutil.rmtree(old)
            print('SchemaSpy report generated on Proxmox.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reader-url-file', required=True)
    parser.add_argument('--schemaspy-jar', required=True)
    parser.add_argument('--jdbc-jar', required=True)
    parser.add_argument('--output', required=True)
    try:
        generate(parser.parse_args())
    except Exception:
        raise SystemExit('SchemaSpy generation failed. Check the private configuration on Proxmox.')
