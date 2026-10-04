#!/usr/bin/env python3
"""Brief live capture; restore the user's recording switch even on failure."""
from pathlib import Path
import subprocess
import time

flag = Path('/var/lib/tmedge/algo/pairs/recording.on')
original = flag.read_text()
try:
    flag.write_text('1')
    subprocess.run(['systemctl', 'restart', 'tmedge-edge'], check=True)
    time.sleep(25)
finally:
    flag.write_text(original)
    subprocess.run(['systemctl', 'restart', 'tmedge-edge'], check=True)
print('Live capture completed; original recording switch restored')
