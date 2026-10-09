# The algo debugger

`algo.hkumyseat.com` — a node editor over the real occupancy pipeline, where
changing a parameter changes the thing that owns it rather than a copy.

Built from `thermal_occupancy_debug_dashboard_plan.md`, with one structural
departure explained below.

## Phones and tablets

At widths of 900px or less, the Flow debugger shows full-width **Graph**,
**Stages**, **Inspector**, and **Output** tabs. Tap a graph node to inspect it,
or use the stage selector in Inspector and Output. Switching tabs keeps local
parameter edits and the live connection. The graph opens around the selected
stage; pinch and pan to explore, or use the fit control for an overview.
Returning to a wider window restores
the desktop panes and their saved sizes.

Training, Updates, and the embedded Debug console use touch-sized controls
and responsive forms. Wide job, image, and node tables scroll inside their
panels; floor tabs scroll to reveal additional floors. Dialogs scroll within
the available screen height, including in landscape.

## The departure: half this pipeline runs on the ESP32

The plan draws one pipeline and assumes a server owns it. In this system the
first three stages — the camera, the background model and the blob detector —
run in `TMsense/src/tm_detector.cpp` **on the sensor**. The edge only ever
receives detections. So the graph spans two machines, and every node carries a
`domain`:

| domain | where it runs | changing a parameter means |
|---|---|---|
| `device` | the ESP32 on the ceiling | a signed `CMD_SET_PARAM`, confirmed in the node's next `STATUS.last_cmd` |
| `edge` | this process | the live `OccupancyEngine` changes on the next frame |
| `view` | the browser | nothing outside the debugger |

The editor colours nodes by domain and the inspector says which one you are
about to touch. This is the single most important thing about the tool: an
orange stage is a piece of hardware in a room, and the floor it watches may be
one students are reading right now.

## How the preview stays honest

A debugger that re-implements the algorithm it is debugging will drift from it
and then lie. So the preview is not a re-implementation: it is
`TMsense/src/tm_detector.cpp` itself, compiled for this machine by
`test/host/detector_host.cpp` and fed the frames we captured from that sensor.
The harness reads the detector's own struct — background, difference,
foreground mask, blob labels — and hands them over; the algorithm file is not
modified. `npm test` fails if a copy of the detector ever appears in this repo.

Every device stage therefore shows two answers:

- **observed** — what the sensor decided about this exact frame, from its
  `REPORT`. A `REPORT` and a `RAW` of the same frame carry the same `frame`
  number, which is what lets them be paired. Drawn as dashed boxes.
- **preview** — what the firmware's detector does with the numbers currently
  in the inspector, replayed over the ring. Drawn solid.

While the inspector matches the sensor they agree. Change a number and only
the preview moves. Press **Apply** and the sensor is told; within a frame or
two the observed answer catches up. If it does not, either the command never
landed — check `last_cmd` — or the host and the device genuinely disagree,
which is a bug worth having found.

Background is an exponential average over history, so previewing a different
`bg_tau` replays the whole ring rather than one frame. That is also what makes
a result reproducible: same frames, same parameters, same answer.

**Simulated nodes are a special case.** A simulated node reports its world
model directly and renders its `RAW` separately, so the two are allowed to
disagree and on a busy floor they will — merged Gaussians exceed `max_area`
and the real detector drops the component. The debugger says so in the node's
debug panel. Only on hardware does a disagreement mean something is wrong.

## Live writes, and the way back

Every live change is **temporary by default**. It takes effect at once and is
put back after 15 minutes unless somebody presses *keep*. The previous value
is remembered from before the session started, so a second edit to the same
parameter still reverts to what the system had, not to the middle of an
experiment. Writing to the node's flash (`Save to flash…`) is a separate,
confirmed action, because that value survives a reboot and outlives whoever
set it.

Everything is appended to `data/algo/audit.jsonl` with the old value, the new
one, who did it and when it will go back.

Edge parameters are clamped server-side in `OccupancyEngine.setOptions`
rather than trusted from the request: they decide what students are told about
a real room.

## Frames

`raw_every` is 0 by default, and recording every node's RAW would be about
7 GB a day against a 22 GB volume. So the debugger turns RAW on **for the node
you are inspecting** — itself a live parameter write, and the quickest proof
that the dashboard reaches the camera — and keeps the last 360 frames in
memory per node. The timeline steps through that ring; nothing is written to
disk.

## The desk estimator

`src/algo/desk.ts` is a first implementation, not a stub: dwell cells above a
threshold are clustered into seats, seats within a table span vote for a
rectangle, and each candidate is scored and matched against the configured
table nearest it. It proposes only — nothing downstream consumes its output —
and the debug panel shows every stage (cells, clusters, candidates, rejects)
so its reasoning can be argued with. A confidently wrong desk looks exactly
like a detection bug from the outside, which is why it shows its work.

It needs dwell to have accumulated: with `minDwellSeconds` at 120 a freshly
started edge proposes nothing for the first few minutes.

## Human Location ML

An alternative to Human Location that places people from the thermal frame
alone, using weights learned from the rig's own camera. Same `points` output,
so it drops into the graph where the projection was — wire the thermal frame
straight into it and it replaces the whole device-detection chain for
comparison.

The honest part is where the labels come from. The intern-desk rig carries a
Raspberry Pi camera and the MLX90640 looking at the same scene, so the camera
can say where a person really was and the thermal frame has to learn to. Three
pieces:

1. **The recorder** (`src/algo/pairs.ts`) keeps an RGB frame only with the
   thermal frame nearest it in time, and only when that is within 400 ms — a
   person walks 55 cm in that, about a seat's width. Every other second, so
   1 Hz cameras cost half the disk. It keeps every frame where the sensor saw
   somebody and one in six of the empty ones, since a detector trained only on
   people learns to answer "person". The switch has three settings
   (`src/algo/autorecord.ts`): **Auto**, the default, keeps frames only while
   the detector reports a person at that sensor, with 5 s of pre-roll and a
   10 s hold, so nobody has to press record and an empty room overnight is not
   stored; **Always** keeps everything (for deliberate empty-room negatives);
   **Off** keeps nothing. Simulated nodes never record.
2. **The trainer** (`tools/train_human_location.py`) runs off the box, where
   numpy and OpenCV live. People are found by background subtraction against a
   median of the scene — a fixed overhead camera makes that reliable, where a
   pedestrian detector would struggle with the view from above. It then
   **fits the RGB→thermal transform from the data**, because nobody wrote down
   how the two cameras are mounted. A poor fit stops the run rather than
   training on scrambled labels.

   The obvious way to calibrate would be one person alone in the room. Real
   rooms do not cooperate: over five hours of the intern desk there was never
   a single frame with exactly one person in the camera *and* one warm blob in
   the thermal — the median frame has four of each. So no correspondence is
   assumed. Every (camera blob, thermal blob) pair inside a frame is a
   candidate, most of them wrong; RANSAC samples two candidates from different
   frames, fits a similarity transform, and counts how many other candidates
   it explains, at most one per frame. The true geometry is the one thing
   consistent across hundreds of frames, and wrong pairings agree with
   nothing.

### What the fit found

On 324 pairs from the intern rig it converged on 309 frames at **1.36 thermal
pixels RMS**: a scale of 0.037 (640 camera pixels onto 24 thermal), a rotation
of **−28.5°**, and a **positive determinant — no reflection**.

The rig's pose says `mirror: true`, and projecting five hours of recorded
detections onto the floor supports it: 29% land within 70 cm of the table with
the mirror applied against 17% without, and the median distance from its centre
is halved. That flag describes the thermal-to-floor projection. It is not also
an RGB display setting: the Pi photograph is shown in its delivered
orientation, while thermal views continue to apply the pose mirror.
3. **Inference** (`src/algo/model.ts`) is a few dozen weights applied per
   pixel: logistic regression over local thermal features, then threshold,
   group and take the centroid. No runtime dependency, and small enough to
   read. With a corpus from one room a larger model would mostly memorise the
   room, and could not be argued with.

The two implementations of the feature vector — numpy in the trainer,
TypeScript on the edge — are compared against each other on a real frame by
`npm test`, the same way the wire format is. That test found a genuine drift
the first time it ran: numpy interpolates percentiles and averages the median
for an even-length array, and the TypeScript was using nearest-rank, which
scaled every feature slightly differently.

Scores are computed on frames held out **by time**, not at random: frames a
second apart are nearly the same picture, and a random split would let the
model be graded on what it had already seen. The node shows precision, recall,
F1 and median placement error from the model file.

```sh
# on the box, once the dashboard says it has enough pairs
scp -r <box>:/var/lib/tmedge/algo/pairs ./pairs
python3 tools/train_human_location.py ./pairs --out data/algo/models
scp data/algo/models/*.json <box>:/var/lib/tmedge/algo/models/
```

The node re-reads the model every ten seconds, so dropping one in needs no
restart. Until one exists it says so and explains how to make it.

## Module 02: ML Training

`/train` writes or uploads a training script, takes what it needs from HKU
HPC2021, and sends it there as the person who wrote it: they sign in with
their own UID, PIN and code, which open their own HKUVPN tunnel and SSH
login once and are wiped (Plan A). See [hpc/plan-a-runbook.md](hpc/plan-a-runbook.md)
for the box, [hpc/decisions.md](hpc/decisions.md) for why, the spec
[hpc/HANDOVER.md](hpc/HANDOVER.md), and [hpc/m0-checklist.md](hpc/m0-checklist.md)
for what the first real logins must record.

## Layout

```
src/algo/types.ts      the model: ports, domains, parameter bindings
src/algo/frames.ts     the ring, and RAW/REPORT pairing by frame number
src/algo/detector.ts   builds and drives the firmware's own detector
src/algo/params.ts     writes, the 15-minute revert, the audit log
src/algo/desk.ts       the desk estimator
src/algo/pairs.ts      RGB/thermal pair recording, the ML training set
src/algo/model.ts      the learned locator, inference only
tools/train_human_location.py   fits it, off the box
src/algo/nodes.ts      the node catalogue and the default graph
src/algo/graph.ts      typed connections, cycles, execution order
src/algo/runtime.ts    runs the graph over one frame
src/algo/server.ts     HTTP + WS on ALGO_PORT
src/algo/train/        module 02: HPC2021 job drafts, safe uploads, sbatch rendering (docs/hpc/)
src/algo/auth.ts       sign-in: accounts, session cookie, Turnstile
src/edge/console.ts    module 03's core (mounted at /console-app/) + the console port
src/tools/algouser.ts  npm run algo-user
algo-app/              the console (algo-app/src/console/) around the editor (React + React Flow), built into public-algo/
```

## Signing in

`algo.hkumyseat.com` is a console with a sign-in page, not a browser
password prompt. Cloudflare Access still sits in front; behind it:

- `/login` is the page: username, password, Cloudflare Turnstile. The
  server checks the Turnstile token (action `algo-login`, one of
  `TURNSTILE_HOSTNAMES`) *before* the password, after a per-address limit of
  10 tries in 5 minutes. It fails closed: no token, or siteverify
  unreachable, means no sign-in.
- Accounts are per person, in `data/algo/users.json` (scrypt hashes; override
  with `ALGO_USERS_FILE`). Manage them on the box:

  ```sh
  npm run algo-user -- add <name>      # prompts for the password (12+ chars)
  npm run algo-user -- remove <name>   # signed out on their next request
  npm run algo-user -- list
  ```

  The edge re-reads the file when it changes; no restart. The audit log
  records `algo:<name>` for every parameter write.
- The session is an HttpOnly, SameSite=Lax cookie (`tm_algo`, 12 h), signed
  with a key derived from `SESSION_SECRET` (or `ALGO_SESSION_SECRET`) so a
  student-tier session can never pass here. Lax, not Strict, because the
  first navigation arrives from Cloudflare Access's login on another site.
- Pages (`/`, `/flow`, `/train`) redirect to `/login?next=…` when signed out;
  `/api/*` answers `401` with no `WWW-Authenticate` header, which is what
  keeps the browser from drawing its own dialog (and is still what the
  deploy health check counts as up).
- Sign-in is on whenever `ADMIN_PASSWORD` is set -- the edge's signal that
  it listens beyond localhost. Without it the port binds to 127.0.0.1 and
  there is no sign-in at all. `ADMIN_PASSWORD` itself is not an algo login;
  it only guards the debug console on CONSOLE_PORT when the algo console is
  off (`ALGO_PORT=0`).
- `TRUST_PROXY=1` (already set for the web tier) makes the limiter see each
  visitor behind cloudflared, and the cookie `Secure` over HTTPS.
- Turnstile only accepts tokens solved on `TURNSTILE_HOSTNAMES`, so opening
  the console on localhost, the LAN or the tailnet cannot sign in while
  Turnstile is on. Use the public hostname, or Cloudflare's test keys locally.
- A live WebSocket is authorised when it opens; signing out ends it when the
  page leaves `/flow`, not server-side.

## Screens

- `/login` — sign-in.
- `/` — module select (↑ ↓, 1–4, enter).
- `/flow` — module 01, the node-graph debugger described above, unchanged.
- `/train` — module 02, ML Training: a placeholder until there is a sandboxed
  job runner to back it.
- `/console` — module 03, the edge's debug console (formerly
  `console.hkumyseat.com`): health, floor fusion, raw frames, node commands,
  admitting TMflash nodes.
- `/updates` — module 04, firmware source upload, build output, saved images,
  target selection and pilot-first OTA rollout progress. Uses the console's
  existing `/console-app/api/firmware*` services and `x-tm-console: 1` write guard.

### Module 03, the debug console

`src/edge/console.ts` is one core with two routers, so its state (the
provisioning queue, the live feed) exists once and is served in two places:

- **`ui`** -- the screens -- is mounted here at `/console-app/`, behind this
  sign-in, with its WebSocket at `/console-app/ws`. `/console` draws it in a
  same-origin frame under the console's bar: it is its own document, with a
  global stylesheet and a run-once module that would collide with the React
  app. Its CSP allows framing by this origin only (`frame-ancestors 'self'`)
  and `blob:` images (rig RGB). Its writes still need `x-tm-console: 1`, and
  approvals, uploads and rollouts are recorded as `console:<name>`.
- **`machine`** -- rig RGB uploads (`/api/demo/rgb`), firmware downloads
  (`/fw/<id>.bin`) and TMflash (`/api/provision/request|status`) -- stays on
  CONSOLE_PORT (8090). Those callers are devices with their own
  credentials and already know that address. Everything else there now
  forwards a browser to the algo console's `/console` (a 200 page with a
  meta refresh, not a 302: production's pinned health check accepts only
  200 or 401 from this port)
  (`console.<domain>` -> `https://algo.<domain>/console`, otherwise the same
  host on ALGO_PORT) and answers its old API with `410`.

With `ALGO_PORT=0` the console port serves the screens itself, behind Basic
auth, as before, including the original firmware panel. When embedded in
module 03, that panel is omitted and OTA is handled by module 04.

## API

Signed-in only (above). Writes additionally require `x-tm-algo: 1`, which a
cross-site form cannot send.

```
POST /auth/login                 {username, password, next?, cf-turnstile-response} -> cookie
POST /auth/logout                clears it
GET  /api/me                     {user}
GET  /api/catalogue              node specs, edge parameter limits, revert window
GET  /api/sources                nodes, whether they are online, sending RAW, public
GET  /api/pipeline               the graph, its problems, which params are edited
PUT  /api/pipeline               replace it (validated: types, cycles, one source per input)
POST /api/pipeline/save|load|reset
GET  /api/frames?uid=            the ring as a timeline
GET  /api/frame/:frame?uid=      one frame, with the sensor's own detections
POST /api/run                    {frame?, only?} -> an envelope per node
POST /api/mode                   {mode: live|pause|step, frame?}
GET  /api/params                 what the sensor reports, what the edge runs, what is pending
POST /api/params/apply           {nodeId, param, value} -> writes to device or edge
POST /api/params/commit          keep it past the revert window
POST /api/params/revert          put it back now
POST /api/params/persist         write the node's parameters to flash
POST /api/node/reset-background  make the sensor relearn the room
WS   /ws?token=                  frame results, pipeline state
```

## Deploying it

Through `deploy/deploy.sh` like everything else — never rsync (see
`deploy/pipeline.md`). Two things the box needs that the release does not
carry, because they are the firmware's, not this repo's:

```sh
sudo dnf install -y gcc-c++                    # the preview compiles C++
sudo rsync -a --relative \
  TMsense/./include TMsense/./src/tm_detector.cpp \
  TMsense/./test/host/detector_host.cpp  <box>:/opt/
echo 'TMSENSE_DIR=/opt/TMsense' >> /opt/tmedge-shared/.env
```

Sign-in needs, once per box: at least one account (`cd /opt/tmedge && sudo -u
tmedge npm run algo-user -- add <name>`), and `algo.hkumyseat.com` added to
`TURNSTILE_HOSTNAMES` in the shared `.env` *and* to the Turnstile widget's
hostname list in the Cloudflare dashboard. Until both, the console refuses
every sign-in (it fails closed).

`TMSENSE_DIR` matters because `/opt/tmedge` is a symlink into a release
directory, so the relative `../TMsense` the debugger would otherwise use
resolves inside `/opt/tmedge-releases/`. Keep `/opt/TMsense` in step with the
firmware the nodes are running, or the preview will answer for a version they
are not.

## Running it

```sh
ALGO_PORT=8091 npm run edge        # 0 turns it off
npm --prefix algo-app run dev      # the editor, proxying to 8091
```

The preview needs `g++` and `../TMsense` beside this checkout. Without them
everything else still works and the dashboard says why the preview is off.

## Known limits

- **Commands cannot reach a node the edge sees on loopback.** A simulator on
  the same machine appears as `127.0.0.1`, and `Ingest.sendCommand` refuses
  rather than pretending: there is no route back. Device writes are therefore
  exercised against hardware or a gateway-attached node; the unit tests cover
  the path with a stub.
- The occupancy node shows the live engine's own answer rather than
  re-deriving occupancy from the previewed detections, so its output reflects
  every node on the floor, not just the one being inspected.
- Node replacement, breakpoints and experiment comparison from the plan's
  later phases are not built.
