# TMedge on AWS EC2

The live system, since 2026-09-21. It replaces the Proxmox VM described in
`proxmox-vm.md`, which is kept installed and stopped as a rollback.

```
host      ec2-54-234-24-4.compute-1.amazonaws.com  (us-east-1)
ssh       ssh -i TMedgeKey.pem ec2-user@ec2-54-234-24-4.compute-1.amazonaws.com
tailnet   tmedge-ec2 = 100.79.19.4
os        Amazon Linux 2023, x86_64, 2 vCPU, 913 MB RAM + 2 GB swap
disks     8 GB root; 22 GB xfs volume (LABEL=tmedge-data) at /var/lib/tmedge
```

## What runs where

| service | what it is | port |
|---|---|---|
| `tmedge-edge` | UDP ingest, occupancy, debug console | 5200/udp, 5210/tcp, 8090 |
| `tmedge-web` | student site | 8080 |
| `tmedge-sim` | 19 virtual nodes for the pilot floors | — |
| `cloudflared` | the tunnel: hkumyseat.com, gw.hkumyseat.com, console.hkumyseat.com | — |
| `tailscaled` | how the Pi rig and the gateway's fallback route reach us | — |
| `tmedge-prune.timer` | deletes recordings older than 30 days | — |

Nothing listens on the public interface but SSH. Students arrive through the
Cloudflare Tunnel, nodes through a gateway or the tailnet, so the security
group needs no port but 22 — and should not be given one.

## Layout

- `/opt/tmedge` — the checkout, root-owned and read-only to the service.
  `.env` is `tmedge:600` and git-ignored; it is the only secret on the box.
- `/var/lib/tmedge` — the 22 GB volume: `users.json`, `detections/`,
  `occupancy/`, `firmware/`, and PlatformIO's toolchains in `platformio/`.
  `DATA_DIR` and `PLATFORMIO_CORE_DIR` in `.env` point here, because a
  compile plus a week of recordings does not fit on the 8 GB root.
- Node 22 in `/usr/local`, from the official tarball, checksum-verified.

## Updating

From the dev Mac, `npm run build && npm test` in this repo, then:

```sh
rsync -a --delete --rsync-path="sudo rsync" \
  --exclude node_modules --exclude data --exclude .env \
  --exclude .git --exclude web-app/node_modules \
  -e "ssh -i TMedgeKey.pem" ./ ec2-user@ec2-54-234-24-4.compute-1.amazonaws.com:/opt/tmedge/
ssh -i TMedgeKey.pem ec2-user@ec2-54-234-24-4.compute-1.amazonaws.com \
  'cd /opt/tmedge && sudo /usr/local/bin/npm ci --omit=dev \
   && sudo chown tmedge:tmedge /opt/tmedge/.env && sudo chmod 600 /opt/tmedge/.env \
   && sudo systemctl restart tmedge-edge tmedge-web tmedge-sim'
```

`--rsync-path="sudo rsync"` is needed because `/opt/tmedge` is root-owned:
the service may read its own code and never write it.

`public-web/app/` is build output and is git-ignored, so rsync (not git) is
what carries the built site; run `npm run build` first or the shell will ask
for chunk names that are not there.

## The connectors, and what each one points at

- **Students**: Cloudflare Tunnel -> `localhost:8080`. The tunnel is
  remotely managed; its token is `/etc/cloudflared/token`. Moving the tunnel
  is moving that file: only one machine may run the connector at a time, or
  Cloudflare will split students across two independent occupancy stores.
- **TMWAccess on the EsanHouse NUC**: `wss://gw.hkumyseat.com/tmgw` first,
  `tcp://100.79.19.4:5210` over Tailscale as the fallback. The primary route
  follows the tunnel by itself; only the fallback names a machine.
- **The Innovation Wing Pi**: `/opt/tm-demo/bridge.env` sends UDP to
  `100.79.19.4:5200` over Tailscale.
- **Firmware builds**: `PIO_PATH=/opt/platformio/penv/bin/pio`. The first
  build of a project downloads ~1 GB of toolchain into
  `/var/lib/tmedge/platformio`; the 2 GB swap is there so that compile is
  not killed on a 913 MB box.

## Rolling back to the Proxmox VM

The VM still has the whole install and its own data; its services are
stopped and disabled.

```sh
ssh <ec2>  'sudo systemctl stop cloudflared tmedge-edge tmedge-web tmedge-sim'
ssh <vm>   'sudo systemctl enable --now tmedge-edge tmedge-web tmedge-sim cloudflared'
```

Then point the Pi's `bridge.env` and the NUC's `EDGE=` fallback back at
`100.106.57.2`; both keep a `.bak-proxmox` copy of the file beside it.

## Known trade-off: distance

The origin is in us-east-1 and the students are in Hong Kong, so the first
byte of a page now takes about a second instead of about a hundred
milliseconds. Everything with a content-hashed name -- the bundle, the
photographs, the floor models -- is served from Cloudflare's Hong Kong edge
and is unaffected, and so is the live WebSocket once it is open; it is the
uncached HTML and the API that pay the crossing. An instance in `ap-east-1`
would remove it.
