#!/bin/sh
# Open the TMedge dashboards on a Mac whose VPN (NordVPN) blocks tailnet traffic.
# Tunnels through the userspace Tailscale client to the live box, then:
#   http://localhost:8080   student dashboard
#   http://localhost:8091   algo console (sign in; 03 is the debug console)
#   (localhost:8090, the old console address, sends you to 8091/console)
# Ctrl-C to close. Needs the userspace client running (see deploy/proxmox-vm.md).
#
# The default is the production EC2 host (deploy/aws-ec2.md). The Proxmox VM
# this script used to point at is stopped and kept only as a rollback path:
#   TM_DASH_HOST=100.106.57.2 TM_DASH_USER=debian \
#   TM_DASH_KEY=$HOME/.ssh/tmedge_ed25519 deploy/open-dashboards-from-mac.sh
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${TM_DASH_HOST:-100.79.19.4}"          # tmedge-ec2 (tailnet)
DASH_USER="${TM_DASH_USER:-ec2-user}"
SOCKET="${TM_TS_SOCKET:-$HOME/.tmedge-tailscale/tailscaled.sock}"

# The deploy key first, the old VM's key second; with neither, ssh's own agent
# and default identities still get a chance rather than being sent a bad path.
KEY="${TM_DASH_KEY:-}"
if [ -z "$KEY" ]; then
  for candidate in "$REPO/../TMcloudkey.pem" "$HOME/.ssh/tmedge_ed25519"; do
    [ -f "$candidate" ] && { KEY="$candidate"; break; }
  done
fi
if [ -n "$KEY" ] && [ ! -f "$KEY" ]; then
  echo "no SSH key at $KEY; set TM_DASH_KEY or put the key where ssh can find it" >&2
  exit 1
fi

set -- -N -o ExitOnForwardFailure=yes \
  -o "ProxyCommand=/opt/homebrew/bin/tailscale --socket=$SOCKET nc %h %p" \
  -o StrictHostKeyChecking=accept-new
[ -n "$KEY" ] && set -- "$@" -i "$KEY"
exec ssh "$@" \
  -L 8080:127.0.0.1:8080 -L 8090:127.0.0.1:8090 -L 8091:127.0.0.1:8091 \
  "$DASH_USER@$HOST"
