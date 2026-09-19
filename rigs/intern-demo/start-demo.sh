#!/bin/sh
# Run ON THE PI as root: hand the camera and thermal serial port to the TM demo bridge.
# Stops (does not disable or modify) the lab's dualcam-recorder, which needs the same devices.
set -e
systemctl stop dualcam-recorder.service
systemctl stop tm-demo-bridge 2>/dev/null || true
systemctl reset-failed tm-demo-bridge 2>/dev/null || true
# Transient unit: nothing is written to /etc, and it disappears on reboot.
systemd-run --unit=tm-demo-bridge --description="TM demo bridge (transient; see /opt/tm-demo)" \
  --property=Restart=always --property=RestartSec=3 --working-directory=/opt/tm-demo \
  /usr/bin/python3 -u /opt/tm-demo/bridge.py
echo "tm-demo-bridge started; logs: journalctl -u tm-demo-bridge -f"
