# TMedge

Turns reports from **TMnode** thermal sensors into live seat availability,
and serves it to students.

```
TMnode ×N ──UDP 5200 (signed)──► edge ──HTTPS push (seats only)──► web ──► students
 heat blobs                       │ ingest, geometry,                sign-in, floor plan,
                                  │ de-duplication, seats            "N seats together"
                                  └─► debug console (admin, :8090): raw thermal, health
```

Two services from one codebase:

| Service | Runs on | Port | Sees |
|---|---|---|---|
| `edge` | the NUC (this Mac for now), on the sensor network | UDP 5200 in, 8090 console | everything, including raw thermal frames |
| `web` | anywhere: this Mac, the NUC, or EC2 | 8080 | seat states only |

**The privacy boundary is the edge.** Raw frames and detections stay on the
edge and in its admin console. The only thing that leaves is the occupancy
snapshot (`src/shared/types.ts`), which holds seat states and totals, with no
pixels and no positions. So the web tier can move to the cloud without
changing what the system knows about anyone.

## Run it

```bash
npm install
cp .env.example .env        # fill in TM_KEY, WEB_PUSH_TOKEN, SESSION_SECRET, ADMIN_PASSWORD
npm run build
npm run web                 # http://localhost:8080
npm run edge                # console http://localhost:8090 (user: anything, password: ADMIN_PASSWORD)
npm run simulate -- --load 0.5          # virtual nodes for every "simulated": true node
npm run user -- add you@connect.hku.hk "Your Name" "a long password"
```

The simulator can also knock nodes out: `--kill 02:00:00:00:00:07@60`.
`--truth file.json` writes the true seat states, for accuracy checks.

## Configure a site

- `config/site.json`: floors, zones, and tables in centimetres, origin
  top-left. Seats are generated three per long side, and a table's capacity
  can be anything from 1 to 20.
- `config/nodes.json`: each node's **MAC**, the floor it's on, its **pose**
  (`x`, `y`, `heightCm`, `yawDeg`, `mirror`) and the tables it **owns**.

Loading is strict. The edge refuses to start on an unknown field, a table
with two owners, or an owner whose pose can't see all of its table's seats.

A new node appears in the console as *unregistered* as soon as it's powered
up. Add its MAC to `nodes.json` to put it to work.

## How counting works

`src/edge/occupancy.ts` has the full reasoning. In short:

1. **Project.** Each blob goes through the node's pose, using a 110° f-theta
   lens model, to a plan point at seated-head height. The mounting height is
   per node.
2. **One authority per table.** Nodes overlap heavily, so each table is
   counted by exactly one node: its owner if healthy, otherwise the nearest
   healthy node that sees all of its seats (**fallback**), otherwise nobody.
   A table nobody can see is **unknown**, never empty. It is greyed out, left
   out of every free-seat number, and never suggested.
3. **Seats.** People claim their nearest free seat. A blob with about twice
   one person's heat (normalised by each pixel's floor area) claims two.
4. **Smoothing.** A seat is taken after 3 of 5 frames and released 20 s
   after it was last seen, so flicker doesn't flip it.

Measured against the simulator's ground truth, over 10 tables and 60 seats
with 55% load: **98.3%** seat-seconds correct, and **97.1%** with people
walking the aisles. Most of the remaining errors are the intentional 20 s
release delay.

## Deploy

- **NUC (edge):** `deploy/tmedge-edge.service` (systemd). Put the NUC on the
  sensor network. `UDP_HOST` binds the uplink to that interface.
- **Docker (any host, amd64 or arm64):** `docker compose up -d --build` runs
  the edge and web tiers, with optional simulator and Cloudflare Tunnel
  profiles. See **[DOCKER.md](DOCKER.md)** for installation and how the image
  and stack work.
- **EC2 (the live system, hkumyseat.com):** edge, web and simulator as
  systemd units on one box, published through a Cloudflare Tunnel. Runbook:
  **[deploy/aws-ec2.md](deploy/aws-ec2.md)**.
- Sign-in is local accounts limited to university email domains, as a
  stand-in for HKU SSO. Swap `UserStore` for OIDC before launch; sessions and
  everything else stay as they are.

### Updating the live box: `deploy/deploy.sh` only

```sh
deploy/deploy.sh              # checks, build, upload, switch, health-check
deploy/deploy.sh list         # releases on the box, * = live
deploy/deploy.sh rollback     # back to the previous release (or: rollback <id>)
```

It refuses uncommitted changes, re-runs typecheck, tests and the crosscheck,
uploads a new release beside the live one, switches with one rename, and
switches back by itself if the new release is unhealthy. Details, and the
GitHub settings that go with CI, are in
**[deploy/pipeline.md](deploy/pipeline.md)**.

> **Never use the old rsync command on EC2** (`rsync -a --delete … ./
> …:/opt/tmedge/`, from earlier versions of the runbook). Since 2026-09-24
> `/opt/tmedge` is a symlink to the live release, not a plain directory, so
> that rsync would write straight into the running release with no checks
> and no way back, and `--delete` would remove the release's `.env` link:
> the units would then fail to start and the site would go down.
> `.env` now lives in `/opt/tmedge-shared/`.

## Firmware updates

The console can build and roll out TMsense firmware without anyone visiting a
ceiling. Open **Firmware**, pick the TMsense project folder, and press
*Upload and build*: the edge compiles it with PlatformIO's `tmflash`
environment (the release build, which bakes in no Wi-Fi password or key) and
keeps the image under its SHA-256.

Then choose an image and a target — one node, one space, or every node — and
press *Update*.

**One node goes first.** The pilot has to come back running the new image,
with a working sensor and a packet accepted by the edge, before any other node
is touched. If it fails, the rollout stops and every other node keeps the
firmware it has. The rest then follow a few at a time.

How an image reaches a node that can only talk to its gateway:

```
console ──upload──► edge ──build──► image (sha256)
                      │
                      ├─ image in 32 kB frames ─► TMWAccess ─ serves http://<gw>:5282/fw/<id>.bin
                      └─ signed OTA request ────► node ─ downloads, checks the hash, flashes,
                                                          reboots, proves itself, confirms
```

The node trusts the hash, not the gateway: an image whose bytes do not match
what the edge signed is thrown away before it can boot. A freshly flashed
image is on probation for three minutes — if it cannot join Wi-Fi, read its
sensor and get a packet accepted, the node puts the old image back and reboots.

Requirements: PlatformIO on the edge (`PIO_PATH` in `.env` if it is not in the
usual place), and TMWAccess 1.1+ at each site. A node that talks to the edge
directly downloads from the edge's own console port instead.

## Tests

```bash
npm test          # 39 tests: geometry, config strictness, replay/auth, occupancy rules, web access, search
npm run crosscheck  # parses bytes from TMnode's own C serializer, and vice versa for commands
npm run typecheck
```
