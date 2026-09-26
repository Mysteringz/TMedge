# TMedge in Docker

One image, `tmedge`, builds on any machine with Docker: Linux, macOS or
Windows, on x86-64 or ARM. It runs the edge, the student web tier and the
simulator. Nothing else needs installing on the host: no Node, no compiler.

## Install

### 1. Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`), or
  Docker Desktop.
- About 300 MB of disk for the image, plus recordings in the `edge-data`
  volume (a few MB per node per day, or about 70 MB with `RECORD_RAW=1`).

### 2. Get the code and configure

```sh
git clone <this repo> TMedge && cd TMedge
cp .env.example .env
```

Fill in `.env`. Generate each secret with `openssl rand -hex 32`.

| Variable | What it is |
|---|---|
| `TM_KEY` | Shared HMAC key; the same value is set on every TMnode (`set key …`) |
| `WEB_PUSH_TOKEN` | Bearer token the edge uses to push snapshots to the web tier |
| `SESSION_SECRET` | Web tier cookie signing (32+ chars) |
| `ADMIN_PASSWORD` | Debug console password. **Required in Docker**: without it the console binds to the container's own localhost and can't be reached |
| `TMGW_TOKEN` | Shared with every TMWAccess gateway (16+ chars) |
| `BIND_ADDR` | Host address the ports listen on (see [Security](#security)). Default `127.0.0.1` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Only for the `tunnel` profile |

Put your site layout in `config/site.json` and `config/nodes.json`. These are
mounted read-only into the containers, so an edit only needs
`docker compose restart edge`.

### 3. Build and start

```sh
docker compose up -d --build        # edge + web
docker compose ps                   # both should read "healthy" within ~20 s
```

| URL | What |
|---|---|
| `http://<BIND_ADDR>:8080` | Student site |
| `http://<BIND_ADDR>:8090` | Debug console (any user name, password `ADMIN_PASSWORD`) |
| UDP `<BIND_ADDR>:5200` | TMnodes sending directly |
| TCP `<BIND_ADDR>:5210` | TMWAccess gateways (raw TCP or WebSocket `/tmgw`) |
| TCP `<BIND_ADDR>:5211` | Direct TMsense nodes, WebSocket `/tmnode` (only with `NODE_PORT=5211` in `.env`; see `docs/DIRECT_NODE_PROTOCOL.md`) |

Add a student account (the site allows only university email domains):

```sh
docker compose exec web tmedge user add you@connect.hku.hk "Your Name" "a long password"
```

### 4. Optional profiles

```sh
docker compose --profile sim up -d      # 9 virtual TMnodes feed the edge (needs "simulated": true nodes)
docker compose --profile tunnel up -d   # Cloudflare Tunnel, public access with no open ports
```

For the tunnel, point the public hostnames in the Cloudflare dashboard at the
compose service names: `http://web:8080` for the site, `http://edge:8090` for
the console (put a Cloudflare Access policy in front of it),
`http://edge:5210` for gateways, and `http://edge:5211` for direct nodes (no
Access login on that hostname: nodes authenticate to the edge themselves).

### 5. Other architectures and registries

The image is plain Alpine and Node, and builds natively on both amd64 and
arm64. To build for another machine, or for both at once, and push:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/tmedge:1.0 --push .
```

On the target, set `image: <registry>/tmedge:1.0` in `docker-compose.yml` and
run `docker compose pull && docker compose up -d`.

### Operate

```sh
docker compose logs -f edge                  # ingest, rejects, node health
docker compose pull; docker compose up -d --build   # update after git pull
docker compose down                          # stop (volumes kept)
docker compose down -v                       # stop and DELETE recordings and accounts
docker run --rm -v tmedge_edge-data:/d -v "$PWD":/b alpine tar czf /b/edge-data.tgz -C /d .   # back up
```

## How it works

### The image

A two-stage build:

1. **Build stage** (`node:22-alpine`): `npm ci`, then `tsc` compiles the
   server and both browser clients. Dev dependencies are then pruned.
2. **Runtime stage:** only the compiled `dist/`, the static `public-*`
   folders, production `node_modules` (`express`, `ws`), a default `config/`,
   and a small entrypoint. It runs as the unprivileged `node` user.

The entrypoint (`docker/entrypoint.sh`, installed as `tmedge`) picks the role
from the first argument:

| Command | Runs |
|---|---|
| `tmedge edge` | Ingest, occupancy, gateway server and console (`dist/src/edge/main.js`) |
| `tmedge web` | Student site and API (`dist/src/web/main.js`) |
| `tmedge sim [args]` | Simulator (`dist/src/tools/simulator.js`) |
| `tmedge user …` | Account management |
| `tmedge health` | Healthcheck: web `/healthz` is 200, or the console answers (401 counts as up) |

### The compose stack

```
                      ┌──────────────── Docker network ────────────────┐
TMnodes ─UDP 5200────►│ edge ──HTTP push (seats only)──► web :8080 ────┼──► students
TMWAccess ─TCP 5210──►│  │ :8090 console                    ▲          │
                      │  └─ edge-data volume                cloudflared├──► Cloudflare
                      │     (recordings)       web-data volume (users) │    (tunnel profile)
                      └────────────────────────────────────────────────┘
```

- **edge** keeps everything the system knows: raw frames, detections,
  recordings. It pushes only the occupancy snapshot (seat states and totals,
  no pixels, no positions) to `web` at `http://web:8080`, over the private
  Docker network. This is the same privacy boundary as outside Docker.
- **web** holds the student accounts in its own volume and has no route to
  raw data. You can run it on a different host instead: point the edge's
  `WEB_PUSH_URLS` at it.
- **State lives in named volumes** (`edge-data`, `web-data`), so rebuilding or
  replacing the containers loses nothing.
- The web tier trusts `X-Forwarded-*` headers only from loopback and private
  addresses (`TRUST_PROXY`), which is where `cloudflared` connects from.

### Networking notes

- **TMnodes behind a gateway** work unchanged. The gateway's TCP link is
  inbound to the edge, and commands go back down the same link.
- **TMnodes sending directly** to the edge's UDP 5200 are sent commands at
  their source address. Docker's NAT can rewrite that address, so on a Linux
  edge serving nodes directly, uncomment `network_mode: host` for `edge`.
- The `sim` service sends to `edge:5200` over the Docker network. It resolves
  the name once at start, so its packets arrive in order.

### Security

- **Docker bypasses the host firewall.** Published ports are NAT rules that
  ufw and nftables `INPUT` rules don't see. Restrict exposure with
  `BIND_ADDR`: `127.0.0.1` for this host only, or the host's Tailscale or LAN
  address. With the `tunnel` profile, public access needs no published port
  at all.
- Secrets come only from `.env`. It is git-ignored and `.dockerignore`d, so it
  is never baked into the image.
- The containers run as non-root. The config mount is read-only.
