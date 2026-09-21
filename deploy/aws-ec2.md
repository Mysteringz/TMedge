# TMedge on AWS EC2

The live system, since 2026-09-21. It replaces the Proxmox VM described in
`proxmox-vm.md`, which is kept installed and stopped as a rollback.

```
host      ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com  (Singapore)
ssh       ssh -i TMcloudkey.pem ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com
tailnet   tmedge-ec2 = 100.79.19.4
type      t3.micro, Amazon Linux 2023, x86_64, 913 MB RAM + 2 GB swap
disks     8 GB root; 22 GB xfs volume (LABEL=tmedge-data) at /var/lib/tmedge
```

It began in us-east-1 and moved to Singapore the same evening, as an AMI of
the whole machine copied across and launched. That instance still exists,
**stopped**: see the rollback section, and read its warning before starting
it.

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
  -e "ssh -i TMcloudkey.pem" ./ ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com:/opt/tmedge/
ssh -i TMcloudkey.pem ec2-user@ec2-13-251-45-51.ap-southeast-1.compute.amazonaws.com \
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

## Moving the machine, and the two things that are not files

An AMI of this instance carries everything, both volumes included, so a
region change is: create the image, copy it to the new region, launch, and
move the two pointers that name a machine. It is how Singapore happened.

What a clone does **not** duplicate safely:

- **The tunnel token.** Both machines will connect as connectors for the
  same tunnel and Cloudflare will split students between two independent
  occupancy stores. Exactly one machine may run `cloudflared`.
- **The Tailscale node.** The clone comes up with the same node key and
  takes the identity over -- which is why Singapore kept `100.79.19.4` and
  the Pi and the NUC needed no change at all. The other side of that: if the
  old instance is started while this one runs, they fight over the node, and
  whichever loses needs `tailscale up --force-reauth --hostname=<name>`.

Launching a clone with this user data keeps it quiet until you choose:

```bash
#!/bin/bash
systemctl stop cloudflared tmedge-edge tmedge-web tmedge-sim
systemctl disable cloudflared
```

## Rolling back

Two ways back, in order of preference.

**To the us-east-1 instance** (stopped, same install, data to 2026-09-21):
stop this machine first -- `sudo systemctl stop cloudflared tmedge-edge
tmedge-web tmedge-sim` -- then start that one in the console. It has the same
tunnel token and the same Tailscale node, so it resumes as `100.79.19.4` and
the Pi and the NUC follow it without being touched.

**To the Proxmox VM**, which still has the whole install and its own data,
stopped and disabled:

```sh
ssh <this box> 'sudo systemctl stop cloudflared tmedge-edge tmedge-web tmedge-sim'
ssh <vm>       'sudo systemctl enable --now tmedge-edge tmedge-web tmedge-sim cloudflared'
```

Then point the Pi's `bridge.env` and the NUC's `EDGE=` fallback back at
`100.106.57.2`; both keep a `.bak-proxmox` copy of the file beside it.

## Distance, measured

The shell and the API are `no-store`, so every one of those requests walks
to the origin and back; only the content-hashed files answer from
Cloudflare's Hong Kong edge. That makes the origin's distance the number
that matters, and it is worth re-measuring after any move, from a machine in
Hong Kong rather than from the dev Mac (whose VPN adds seconds of its own):

```sh
for i in $(seq 12); do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" https://hkumyseat.com/login/
done | sort -n
```

| origin | RTT from HK | median first byte |
|---|---|---|
| Proxmox VM, Hong Kong | ~1 ms | ~0.1 s |
| EC2 us-east-1 | 290 ms | ~1.0 s |
| EC2 ap-southeast-1 | 38 ms | ~0.22 s |

`ap-east-1` (Hong Kong) would save perhaps another 30 ms of that; it is an
opt-in region with no free tier, and on these numbers it is not worth a
second migration.
