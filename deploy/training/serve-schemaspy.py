#!/usr/bin/env python3
"""Forced SSH command for a report-only key. Never offers a shell or database access."""
import json
import os
from pathlib import Path
import shutil
import sys


def serve(root, command, output):
    root = Path(root)
    if command == 'status':
        status = json.loads((root / 'report-status.json').read_text())
        output.write(json.dumps(status).encode())
    elif command == 'report':
        with (root / 'report.tar.gz').open('rb') as source:
            shutil.copyfileobj(source, output)
    else:
        raise ValueError('unsupported report request')


if __name__ == '__main__':
    try:
        serve('/var/lib/crowdaware-schemaspy', os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdout.buffer)
    except Exception:
        raise SystemExit('SchemaSpy report unavailable.')
