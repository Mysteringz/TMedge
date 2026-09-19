#!/usr/bin/env python3
"""TMnode bridge for the RGB verification rig (Raspberry Pi + ESP32/MLX90640 + Pi Camera).

Makes the rig look like any other TMnode to TMedge:
  * reads the ESP32's thermal frames from USB serial (the original v1 serial
    format: FE 01 FE 01, 8-bit image mapped 10..35 C),
  * runs TMnode's own detector on them (libtmdetector.so, built from
    TMnode/src/tm_detector.cpp unchanged),
  * sends signed protocol-v1 REPORT / RAW / STATUS datagrams to the edge,
and, because this is a verification rig, also pushes a signed RGB JPEG to the
edge's console (and nowhere else) a couple of times a second.

It needs the serial port and the camera exclusively, so the lab's recorder
(dualcam-recorder.service) must be stopped while this runs. It never touches
that software's files. Settings: bridge.env next to this file.
"""
import ctypes, hashlib, hmac, os, socket, struct, sys, threading, time, urllib.request
import numpy as np
import serial

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
with open(os.path.join(HERE, 'bridge.env')) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            ENV[k.strip()] = v.strip()

KEY = ENV['TM_KEY'].encode()
EDGE = (ENV.get('EDGE_HOST', '100.84.194.47'), int(ENV.get('EDGE_UDP_PORT', '5200')))
EDGE_HTTP = ENV.get('EDGE_HTTP', f'http://{EDGE[0]}:8090')
SERIAL_PORT = ENV.get('SERIAL_PORT', '/dev/ttyUSB0')
RGB_FPS = float(ENV.get('RGB_FPS', '2'))
FW = b'tm-rig-1.0.0'

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

# --- identity -------------------------------------------------------------------
UID = bytes.fromhex(open('/sys/class/net/wlan0/address').read().strip().replace(':', ''))
UID_STR = UID.hex(':')
state = os.path.join(HERE, 'state')
os.makedirs(state, exist_ok=True)
boot_file = os.path.join(state, 'boot')
BOOT = (int(open(boot_file).read()) if os.path.exists(boot_file) else 0) + 1
open(boot_file, 'w').write(str(BOOT))   # (boot, seq) only ever increases, like a real node
seq = 0
T0 = time.monotonic()
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def packet(ptype, payload):
    global seq
    head = struct.pack('<2sBB6sHIIH', b'TM', 1, ptype, UID, BOOT, seq & 0xffffffff,
                       int((time.monotonic() - T0) * 1000) & 0xffffffff, len(payload))
    seq += 1
    tag = hmac.new(KEY, head + payload, hashlib.sha256).digest()[:8]
    return head + payload + tag

def send(ptype, payload):
    try:
        sock.sendto(packet(ptype, payload), EDGE)
    except OSError as e:
        log('udp send failed:', e)

# --- detector ----------------------------------------------------------------------
lib = ctypes.CDLL(os.path.join(HERE, 'libtmdetector.so'))
lib.tmd_init.argtypes = [ctypes.c_float, ctypes.c_float, ctypes.c_float, ctypes.c_int, ctypes.c_int,
                         ctypes.c_int, ctypes.c_int, ctypes.c_float]
lib.tmd_step.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float), ctypes.c_int,
                         ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_float)]
lib.tmd_step.restype = ctypes.c_int
PARAMS = dict(min_contrast=0.6, min_peak=1.2, noise_k=4.0, min_area=1, max_area=60, bg_tau=90, bg_frames=20, split_sep=1.9)
lib.tmd_init(*PARAMS.values())
out = (ctypes.c_float * (6 * 24))()
flags = ctypes.c_int()
bg_mean = ctypes.c_float()

# --- thermal: the ESP32's v1 serial frames ---------------------------------------------
HEADER = b'\xFE\x01\xFE\x01'

def read_packet(ser):
    window = b''
    while True:
        b = ser.read(1)
        if not b:
            return None
        window = (window + b)[-4:]
        if window == HEADER:
            break
    n = int.from_bytes(ser.read(2), 'little')
    if n < 768 or n > 4000:
        return None
    data = ser.read(n)
    return data if len(data) == n else None

def repair(t):
    """The v1 firmware's first row carries a few corrupt pixels; replace any
    pixel far from its neighbours' median, like the node's bad-pixel repair."""
    pad = np.pad(t, 1, mode='edge')
    neigh = np.median(np.stack([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]]), axis=0)
    bad = np.abs(t - neigh) > 6.0
    bad[1:, :] = False          # only the first row is known-corrupt; people elsewhere are real contrast
    t[bad] = neigh[bad]
    return t

stats = {'frames': 0, 'fps': 0.0, 'serial_err': 0, 'rgb_sent': 0, 'rgb_err': 0, 'last_frame': 0.0}

def thermal_loop():
    frame_no = 0
    last_status = 0.0
    while True:
        try:
            ser = serial.Serial(SERIAL_PORT, 57600, timeout=2)
            log('serial open', SERIAL_PORT)
            while True:
                data = read_packet(ser)
                if data is None:
                    continue
                t = (10.0 + np.frombuffer(data[:768], dtype=np.uint8).astype(np.float32) / 255.0 * 25.0).reshape(24, 32)
                t = np.ascontiguousarray(repair(t), dtype=np.float32)
                n = lib.tmd_step(t.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), out, 24, ctypes.byref(flags), ctypes.byref(bg_mean))
                now = time.monotonic()
                if stats['last_frame']:
                    inst = 1.0 / max(now - stats['last_frame'], 1e-3)
                    stats['fps'] = inst if stats['fps'] == 0 else 0.9 * stats['fps'] + 0.1 * inst
                stats['last_frame'] = now
                stats['frames'] += 1
                c = lambda v: int(round(v * 100))
                body = struct.pack('<IhhhhBB', frame_no, 0, c(t.min()), c(t.max()), c(bg_mean.value), flags.value, n)
                for i in range(n):
                    x, y, area, con, peak, heat = out[6 * i:6 * i + 6]
                    q = lambda v, lim=255: max(0, min(lim, int(round(v))))
                    body += struct.pack('<BBBBBH', q(x * 8), q(y * 8), q(area), q(con / 0.05), q(peak / 0.25), q(heat * 10, 65535))
                send(1, body)
                lo = np.floor(t.min() * 100) / 100
                step_q = max(1, min(65535, int(np.ceil((t.max() - lo) / 255 * 10000))))
                px = np.clip(np.round((t - lo) / (step_q / 10000)), 0, 255).astype(np.uint8)
                send(2, struct.pack('<IhH', frame_no, int(round(lo * 100)), step_q) + px.tobytes())
                if now - last_status > 10:
                    last_status = now
                    ip = bytes(4)   # the rig has no single IP worth reporting; the edge sees its tailnet address
                    params = [60, 120, 40, 1, 60, 90, 20, 1, 2, 19]
                    status = FW.ljust(12, b'\0') + ip + struct.pack('<bBIIHHHIHHhIBB', 0, 0, 0, 0, 0, 0,
                              stats['serial_err'] & 0xffff, stats['frames'], int(stats['fps'] * 100), 0, 0, 0,
                              0x01 | (0x02 if flags.value & 1 else 0) | 0x04, len(params)) + struct.pack(f'<{len(params)}i', *params)
                    send(3, status)
                    log(f"frames={stats['frames']} fps={stats['fps']:.2f} people={n} rgb_sent={stats['rgb_sent']} rgb_err={stats['rgb_err']}")
                frame_no += 1
        except (serial.SerialException, OSError) as e:
            stats['serial_err'] += 1
            log('serial error, retrying in 2 s:', e)
            time.sleep(2)

# --- RGB: verification only -------------------------------------------------------------
def rgb_loop():
    import cv2
    from picamera2 import Picamera2
    cam = None
    while cam is None:
        try:
            cam = Picamera2()
            cam.configure(cam.create_preview_configuration({'format': 'RGB888', 'size': (640, 480)}))
            cam.start()
            log('camera started')
        except Exception as e:
            log('camera init failed, retrying in 3 s:', e)
            cam = None
            time.sleep(3)
    period = 1.0 / RGB_FPS
    while True:
        t0 = time.monotonic()
        try:
            frame = cam.capture_array('main')          # BGR-ordered, as the lab's recorder uses it
            ok, jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                body = jpg.tobytes()
                ts = int(time.time() * 1000)
                sig = hmac.new(KEY, f"{UID_STR}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode(), hashlib.sha256).hexdigest()
                req = urllib.request.Request(f'{EDGE_HTTP}/api/demo/rgb/{UID_STR}', data=body, method='POST',
                                             headers={'content-type': 'image/jpeg', 'x-tm-ts': str(ts), 'x-tm-sig': sig})
                urllib.request.urlopen(req, timeout=5).read()
                stats['rgb_sent'] += 1
        except Exception as e:
            stats['rgb_err'] += 1
            if stats['rgb_err'] % 20 == 1:
                log('rgb push failed:', e)
        time.sleep(max(0.0, period - (time.monotonic() - t0)))

if __name__ == '__main__':
    log(f'tm rig bridge: uid {UID_STR} boot {BOOT} -> {EDGE[0]}:{EDGE[1]} (udp), {EDGE_HTTP} (rgb)')
    threading.Thread(target=rgb_loop, daemon=True).start()
    thermal_loop()
