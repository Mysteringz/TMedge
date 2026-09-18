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
- **EC2 (web):** the `Dockerfile` (`docker run ... tmedge web`) behind an ALB
  with HTTPS, and `COOKIE_SECURE=1 TRUST_PROXY=1`. Point the edge's
  `WEB_PUSH_URLS` at it. The edge pushes outbound, so the NUC needs no inbound
  ports. The Dockerfile has not been built yet (no Docker daemon was running
  on the dev Mac).
- Sign-in is local accounts limited to university email domains, as a
  stand-in for HKU SSO. Swap `UserStore` for OIDC before launch; sessions and
  everything else stay as they are.

## Tests

```bash
npm test          # 26 tests: geometry, config strictness, replay/auth, occupancy rules, web access, search
npm run crosscheck  # parses bytes from TMnode's own C serializer, and vice versa for commands
npm run typecheck
```
