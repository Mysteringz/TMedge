#!/bin/bash
# Users come from FAKE_USERS="name:password:totp-hex name2:...". As at HKU,
# the VPN login is name@hku.hk and SSH is the bare name, and the same password
# (the Portal PIN) opens both. Host names are under .test, so nothing in this
# stack can ever resolve to, or reach, a real HKU system.
set -euo pipefail
mkdir -p /etc/ocserv /certs
: > /etc/ocserv/ocpasswd
: > /etc/ocserv/users.oath
for spec in $FAKE_USERS; do
  IFS=: read -r name pw seed <<<"$spec"
  id "$name" >/dev/null 2>&1 || useradd -m -s /bin/bash "$name"
  echo "$name:$pw" | chpasswd
  echo "$name@hku.hk:*:$(openssl passwd -6 "$pw")" >> /etc/ocserv/ocpasswd
  echo "HOTP/T30 $name@hku.hk - $seed" >> /etc/ocserv/users.oath
done
chmod 600 /etc/ocserv/users.oath

if [ ! -f /certs/server-key.pem ]; then
  certtool --generate-privkey --outfile /certs/server-key.pem 2>/dev/null
  cat > /tmp/cert.tmpl <<T
cn = "vpn2fa.fakehku.test"
expiration_days = 30
signing_key
encryption_key
tls_www_server
T
  certtool --generate-self-signed --load-privkey /certs/server-key.pem --template /tmp/cert.tmpl --outfile /certs/server-cert.pem 2>/dev/null
fi
chmod 644 /certs/server-cert.pem

cat > /etc/ocserv/ocserv.conf <<C
auth = "plain[passwd=/etc/ocserv/ocpasswd,otp=/etc/ocserv/users.oath]"
tcp-port = 4443
socket-file = /run/ocserv-socket
server-cert = /certs/server-cert.pem
server-key = /certs/server-key.pem
isolate-workers = false
max-clients = 16
max-same-clients = 2
keepalive = 300
dpd = 60
mobile-dpd = 60
idle-timeout = ${FAKE_IDLE_TIMEOUT:-1200}
try-mtu-discovery = false
device = vpns
predictable-ips = true
default-domain = fakehku.test
ipv4-network = 192.168.99.0
ipv4-netmask = 255.255.255.0
dns = 192.168.99.1
route = 192.168.99.0/255.255.255.0
cisco-client-compat = true
compression = false
run-as-user = nobody
run-as-group = nogroup
pid-file = /run/ocserv.pid
# Every test connection comes from one Docker gateway IP, and ocserv otherwise
# refuses that IP for minutes after a failed login -- so the lockout test would
# block every later test. The real HKU VPN may throttle per IP too: that is
# M0's to measure (docs/hpc/m0-checklist.md), not this fake's to imitate.
min-reauth-time = 1
max-ban-score = 0
rate-limit-ms = 0
C

# The login node's name exists only on the far side of the tunnel.
cat > /etc/dnsmasq.d/hku.conf <<D
address=/hpc.fakehku.test/192.168.99.1
no-resolv
D
dnsmasq --conf-dir=/etc/dnsmasq.d

ssh-keygen -A >/dev/null
cat > /etc/ssh/sshd_config.d/hpc.conf <<S
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PermitRootLogin no
S
/usr/sbin/sshd
# Hand the host key to the tests, so they can pin it (or pin a wrong one).
cp /etc/ssh/ssh_host_ed25519_key.pub /certs/hpc_host_ed25519.pub
exec ocserv --foreground --debug="${FAKE_DEBUG:-0}" --config /etc/ocserv/ocserv.conf
