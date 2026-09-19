# TMedge on the Proxmox cluster (HomeDataCenter)

Deployed 2026-09-19.

| | |
|---|---|
| VM | **104 `tmedge`**, Debian 13 cloud image, 2 vCPU, 2 GB RAM, 16 GB disk on Ceph `proxpool` |
| HA | `ha-manager` resource `vm:104` (state started, max_restart 3, max_relocate 2) |
| LAN | **192.168.0.250**/22, gateway 192.168.0.1 (cluster site). Reserve it in that router's DHCP. |
| Tailscale | **100.106.57.2** (`tmedge.tailc29e8b.ts.net`). This address follows the VM when HA moves it. |
| Dashboards | student `http://100.106.57.2:8080`, console `http://100.106.57.2:8090` (or the LAN address) |
| Sensor uplink | UDP `100.106.57.2:5200` / `192.168.0.250:5200` (nodes on the cluster LAN) |
| Access gateways | TCP `5210` (TMGW v1, `TMGW_TOKEN` in `.env`): TMWAccess at other sites |
| SSH | `debian@` the VM, key `~/.ssh/tmedge_ed25519` on the dev Mac |

## Public access: Cloudflare Tunnel (hkumyseat.com)

`cloudflared` (Cloudflare apt repo) runs in the VM as the systemd service
`cloudflared`, a remotely managed tunnel installed with the tunnel token.
It opens outbound QUIC connections only (4 connections, spread over the
bkk08, sin02 and sin07 data centres), so:

- no port is forwarded on the cluster site's router, and none is open from
  the internet (probed from outside: 22/80/443/5210/8006/8080/8090 are all
  filtered);
- DNS records point at Cloudflare, never at the site's public IP;
- the VM's nftables still admits only LAN and tailnet sources, and cloudflared
  reaches the services on loopback.

Public hostnames are set in the Cloudflare dashboard (Zero Trust → Networks →
Tunnels → this tunnel → Public Hostname), not in a file:

| Hostname | Service |
|---|---|
| `hkumyseat.com` | `http://localhost:8080` (student dashboard) |
| `console.hkumyseat.com` | `http://localhost:8090` (debug console; also behind a Cloudflare Access policy) |

The web tier runs with `TRUST_PROXY=1`. It trusts `X-Forwarded-*` from
loopback only, and it sets the session cookie `Secure` on HTTPS requests.

## Layout inside the VM

- `/opt/tmedge`: this repo (built `dist/`, `npm ci --omit=dev`). `.env` is
  mode 600, owned by `tmedge`.
- `/opt/node`: Node 22 (official tarball, checksum-verified).
- `/opt/tmedge/data`: recordings and `users.json`. This is the only writable path.
- systemd units `tmedge-edge`, `tmedge-web` and `tmedge-sim` run as the
  unprivileged `tmedge` user with `ProtectSystem=strict`.
- `/etc/nftables.conf`: inbound traffic is dropped except SSH/5210/8080/8090/UDP 5200
  from 192.168.0.0/22 and 100.64.0.0/10 (the tailnet), plus Tailscale's own UDP
  41641.

## Updating

From the dev Mac, run `npm run build && npm test` in this repo, then:

```sh
rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude .git ./ tmedge-vm:/opt/tmedge/
ssh tmedge-vm 'cd /opt/tmedge && npm ci --omit=dev && sudo systemctl restart tmedge-edge tmedge-web tmedge-sim'
```

## Two networks, not one

The dev Mac and the ESP32 are on a different site ("EsanHouse", router
68:7f:f0:…) from the cluster (router 1c:0b:8b:…). Both use 192.168.0.x, so
they can't reach each other's LAN. Consequences:

- From the dev Mac, the VM is reachable only over Tailscale. NordVPN on that
  Mac blocks tailnet traffic, so use `deploy/open-dashboards-from-mac.sh`
  (a tunnel to `localhost:8080`/`8090`) or `curl --socks5-hostname localhost:1055`.
- The Pi rig (Innovation Wing) reaches the VM directly over Tailscale.
- The bench ESP32 (`30:ed:a0:cb:f5:f8`, "Above M3") on EsanHouse Wi-Fi reaches
  the VM through **TMWAccess** (`../TMWAccess`), which runs on the dev Mac for
  now and moves to a mini PC later. The console shows it as
  `gw:esanhouse-mac|192.168.0.9`.
