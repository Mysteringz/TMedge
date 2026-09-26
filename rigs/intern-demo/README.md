# Intern desk verification rig

A Raspberry Pi verification rig with a Pi Camera 3 Wide and an ESP32 +
MLX90640 thermal node on USB serial, used to compare RGB against thermal.
Here, it is shown as the console-only floor
**Intern Space Demo** (one desk, two chairs on one side).

**The lab's own software is never modified.** That's `dualcam-recorder.service`.
It holds the camera and the serial port exclusively, so the demo stops it
while running and restarts it afterwards. Everything of ours lives in
`/opt/tm-demo` on the Pi and runs as a transient systemd unit.

## What the bridge does

`bridge.py` reads the ESP32's original v1 serial frames. These are 8-bit,
mapped from 10 to 35 °C, and the first row has a few corrupt pixels, which the
bridge repairs. It runs TMnode's detector (`libtmdetector.so`, built from
`TMsense/src/tm_detector.cpp` unchanged) and sends signed protocol-v1
REPORT/RAW/STATUS packets to the edge, so the rig behaves like any other node.
It also pushes a signed 640×480 JPEG about twice a second to the console's
`/api/demo/rgb/<uid>`.

RGB boundaries, enforced by the edge and covered by tests:
- RGB is accepted only from nodes flagged `"rgb": true`.
- Such a node must be on a `"visibility": "console"` floor.
- Frames are kept in memory only, shown only in the password-protected
  console, and never recorded or published.

## Commands (run on the Pi as root)

```sh
/opt/tm-demo/start-demo.sh          # stop the lab recorder, start the bridge
/opt/tm-demo/restore-original.sh    # stop the bridge, relaunch the lab recorder
journalctl -u tm-demo-bridge -f     # bridge logs
```

A reboot also restores the original state: the demo unit is transient, and
the lab recorder is still enabled at boot.

## Network

If a host VPN captures tailnet traffic, a userspace Tailscale client can
forward the rig's UDP and TCP to localhost. In that setup the rig appears at
`127.0.0.1`, and the edge correctly refuses to send it commands. For a direct
connection, set `EDGE_HOST` in `/opt/tm-demo/bridge.env` to your edge host's
tailnet address. Keep actual hostnames, addresses and credentials in private
deployment configuration.

## Layout

The demo floor has one desk (`D1`) and two chairs (`D1-A`, `D1-B`). Calibrate
chair positions and mounting height for your own rig. Use a per-table seat
radius when the site-wide radius would include nearby seating. Keep recorded
occupancy patterns and site measurements out of public documentation.
