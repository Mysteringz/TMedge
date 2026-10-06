"""
Claims about `npm run hpc-hostkeys`, run through a real pseudo-terminal the
way an admin would type into it, against the fake HKU (run.sh):
the PIN and code are never echoed, and the pinned keys are the server's own.
Usage: hostkeys-pty.py <hpc config> <data dir> <known_hosts out> <server .pub>
"""
import hmac, hashlib, os, pty, struct, sys, time

config, data, out_file, server_pub = sys.argv[1:5]
seed = bytes.fromhex('3131313131313131313131313131313131313131')  # the fake "lockme" account
pin = 'lockme-pin-3'

def otp():
    while 30 - time.time() % 30 < 7: time.sleep(1)
    c = int(time.time()) // 30
    h = hmac.new(seed, struct.pack('>Q', c), hashlib.sha1).digest(); o = h[19] & 15
    return '%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 1000000)

pid, fd = pty.fork()
if pid == 0:
    os.execvpe('node', ['node', 'dist/src/tools/hpchostkeys.js'], {**os.environ, 'HPC_CONFIG': config, 'DATA_DIR': data})
seen = b''
def until(s, timeout=90):
    global seen
    end = time.time() + timeout
    while s.encode() not in seen and time.time() < end:
        try: seen += os.read(fd, 4096)
        except OSError: break
    return s.encode() in seen
code = otp()
# Answers go in the instant each prompt shows: faster than any person.
for prompt, answer in [('HKU UID', 'lockme'), ('VPN domain', ''), ('Portal PIN', pin), ('One-time code', code), ('Type "yes"', 'yes')]:
    assert until(prompt), f'never prompted for {prompt}:\n{seen.decode(errors="replace")}'
    os.write(fd, (answer + '\r').encode())
assert until('Pinned'), seen.decode(errors='replace')
text = seen.decode(errors='replace')
assert pin not in text, 'the PIN was echoed to the terminal'
assert code not in text, 'the one-time code was echoed to the terminal'
pinned = {tuple(l.split()[1:3]) for l in open(out_file) if l.strip()}
real = tuple(open(server_pub).read().split()[0:2])
assert real in pinned, f'the server key {real[0]} was not among the pinned keys'
assert all(l.split()[0] == 'hpc.fakehku.test' for l in open(out_file) if l.strip())
print(f'ok - hpc-hostkeys pinned {len(pinned)} key(s) through a pseudo-terminal; nothing secret was echoed')
