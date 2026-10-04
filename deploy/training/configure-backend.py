#!/usr/bin/env python3
"""Set the shared backend selector without reading credentials into logs."""
from pathlib import Path
import shutil

path = Path('/opt/tmedge-shared/.env')
backup = Path('/opt/tmedge-shared/.env.before-training-postgres')
if not backup.exists():
    shutil.copy2(path, backup)
lines = [line for line in path.read_text().splitlines() if not line.startswith('TRAINING_STORAGE=')]
temporary = path.with_name('.env.training-new')
temporary.touch(mode=0o600)
temporary.write_text('\n'.join(lines) + '\nTRAINING_STORAGE=postgres\n')
shutil.chown(temporary, user=path.stat().st_uid, group=path.stat().st_gid)
temporary.replace(path)
