#!/bin/sh
# Open the TMedge dashboards on a Mac whose VPN (NordVPN) blocks tailnet traffic.
# Tunnels through the userspace Tailscale client to the VM, then:
#   http://localhost:8080   student dashboard
#   http://localhost:8090   debug console
# Ctrl-C to close. Needs ~/.tmedge-tailscale running (see deploy/proxmox-vm.md).
exec ssh -N -o ExitOnForwardFailure=yes \
  -o ProxyCommand="/opt/homebrew/bin/tailscale --socket=$HOME/.tmedge-tailscale/tailscaled.sock nc %h %p" \
  -i "$HOME/.ssh/tmedge_ed25519" -o StrictHostKeyChecking=accept-new \
  -L 8080:127.0.0.1:8080 -L 8090:127.0.0.1:8090 debian@100.106.57.2
