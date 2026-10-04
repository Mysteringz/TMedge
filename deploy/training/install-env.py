#!/usr/bin/env python3
"""Accept generated credentials over stdin; never print a database secret."""
import json
import os
from pathlib import Path
import pwd
import re
import sys

c = json.load(sys.stdin)
if not isinstance(c, dict) or not isinstance(c.get('writer'), str) or not re.fullmatch(r'[0-9a-f]{64}', c['writer']):
    raise ValueError('invalid training writer credential')
path = Path('/opt/tmedge-training/database.env')
path.touch(mode=0o600)
path.chmod(0o600)
path.write_text('TRAINING_DATABASE_URL=postgresql://crowdaware_ingest:' + c['writer'] + '@127.0.0.1:55432/crowdaware_training\n')
os.chown(path, pwd.getpwnam('tmedge').pw_uid, pwd.getpwnam('tmedge').pw_gid)
