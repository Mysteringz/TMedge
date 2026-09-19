#!/bin/sh
# Run ON THE PI as root: stop the TM demo bridge and relaunch the lab's recorder,
# returning the device to exactly how it was. (A reboot does the same.)
systemctl stop tm-demo-bridge 2>/dev/null || true
systemctl reset-failed tm-demo-bridge 2>/dev/null || true
systemctl start dualcam-recorder.service
echo "dualcam-recorder: $(systemctl is-active dualcam-recorder.service) (enabled: $(systemctl is-enabled dualcam-recorder.service))"
# To remove every trace of the demo as well:  rm -rf /opt/tm-demo
