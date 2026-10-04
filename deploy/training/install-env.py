#!/usr/bin/env python3
"""Accept generated credentials over stdin; never print a database secret."""
import json
import os
from pathlib import Path
import pwd
import sys

c = json.load(sys.stdin)
path = Path('/opt/tmedge-training/database.env')
path.touch(mode=0o600)
path.write_text('TRAINING_DATABASE_URL=postgresql://crowdaware_ingest:' + c['writer'] + '@127.0.0.1:55432/crowdaware_training\n')
os.chown(path, pwd.getpwnam('tmedge').pw_uid, pwd.getpwnam('tmedge').pw_gid)
