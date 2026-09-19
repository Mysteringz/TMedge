# Intern desk verification rig

A Raspberry Pi above an intern desk in the Innovation Wing, with a Pi Camera 3
Wide and an ESP32 + MLX90640 thermal node on USB serial. The lab uses it to
compare RGB against thermal. Here, it is shown as the console-only floor
**Intern Space Demo** (one desk, two chairs on one side).

**The lab's own software is never modified.** That's `dualcam-recorder.service`,
which runs `/home/ttl/crowdaware-dual-cam-test/python_parser/raw_dualcam_recorder.py`.
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

The dev Mac's NordVPN captures traffic headed into the tailnet. The edge
therefore reaches the tailnet through a second, userspace-only Tailscale
client (`tmedge-mac-userspace`, 100.84.194.47), which forwards the rig's UDP
and TCP to localhost. So the rig appears at `127.0.0.1`, and the edge
correctly refuses to send it commands. On the NUC, set `EDGE_HOST` in
`/opt/tm-demo/bridge.env` to the NUC's tailnet address.

## Layout

The desk and its two chairs (`D1-A`, `D1-B`) were placed from a dwell map
built by running the detector over 8,139 of the lab's archived thermal frames
(7 weeks). Chair B is the seat used most. `D1` uses a 50 cm seat radius,
because the bench next to the desk is within the site-wide 80 cm of chair B.
The mounting height (280 cm) is an estimate, and so is chair A's position.
