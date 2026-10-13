Ask AI's system knowledge. Maintainers: the rules for this file are in
CLAUDE.md, "The assistant's knowledge base".

## What the system is

HKUMySeat tells students where there are free seats. Thermal sensors on the
ceiling see people as heat; the system counts seats taken per table and shows
students which tables have room. No picture of anybody is ever shown to a
student or stored for them: that is the project's privacy claim.

Three parts:
- TMsense: the sensor node (ESP32-S3 with an MLX90640 thermal array, 32x24
  pixels, 110 degree lens). It detects people on the device and sends signed
  reports. A Raspberry Pi rig with a camera beside the thermal sensor is used
  for calibration.
- TMedge, "the edge": the server. It verifies every packet, turns detections
  into occupancy, and publishes an occupancy snapshot. It also hosts this
  console.
- The student site, hkumyseat.com: a separate web service. It only ever
  receives occupancy snapshots (seat states and totals), never thermal pixels
  or detections.

Sensors reach the edge by UDP, through a Wi-Fi site gateway (TMWAccess), or
directly over a secure WebSocket. All three go through the same checks.
TMflash flashes and provisions a sensor over USB. It exists twice: a Mac app,
and TMflash web in this console, which does the same from a browser.
The Mac app preserves saved node settings and boot counters; damaged
firmware is refused before USB writes.

## How a count is made

1. The node subtracts a learned background from each thermal frame and finds
   warm blobs; each blob is one or more people.
2. The edge projects blobs onto the floor plan using the sensor's mounting
   height, rotation and lens model. Heat is normalised by the floor area a
   pixel covers before estimating how many people a merged blob holds.
3. Each table has one authority sensor: its owner, or a healthy fallback if
   the owner is silent. This stops two overlapping sensors counting the same
   person twice.
4. Seats use hysteresis and zone counts use a median over a window, so the
   numbers do not flicker. The latest frame alone is never used.
5. A table never reports more people than it has seats, but the zone total
   still counts everyone.

Rules that are never broken:
- Silence is never emptiness. A table with no working sensor is "unknown". It
  is left out of free-seat totals and never suggested. Unknown is not zero.
- A sensor marked "detector: edge" is counted by the edge from raw frames,
  against a background learned over 24 hours (heat present in about 80% of
  the day is furniture; the rest may be people). This exists because a
  student sitting still for hours used to fade into the node's own
  background. Until it has an hour of history its tables are unknown.

## The console, algo.hkumyseat.com

On phones/tablets the menu opens Home and every module, including both ML
pages. Accounts requires account-management access. The current page is
highlighted; selection, outside taps or Escape close the menu. Wide headers
show Algorithm flow, ML, Debug console, Devices and Analytics; each page has
its own address. Beside the notifications bell, the account menu shows the
username, access role, Account settings and Sign out.

Home shows a welcome, search, frequently used modules, six live figures,
mailbox and board (requests and tasks). Search first finds modules, pages,
members, your own mail, requests, tasks and sensors. Questions or unmatched
searches go to Ask AI. Press "/" to focus search.

Modules (docs number them; pages show names):
- 01 Algorithm flow, /flow. A node graph over the real detection pipeline.
  Change a parameter and see its effect on live or recorded frames. A live
  parameter change reaches the real sensor or engine, and reverts by itself
  after 15 minutes unless it is committed. Every change is written to an
  audit log with the old value. The preview runs the firmware's own detector
  code compiled for the server, so it cannot drift from the sensor.
- 02 ML job, /train. The training page. Write a training script, run it on the university's
  HPC cluster through SLURM, watch the job, fetch results. Each person signs
  in to the cluster as themselves; credentials are sealed in the browser,
  used once and never stored.
- 02 ML data, /ml-data. Query the private PostgreSQL training database with a
  SELECT or WITH statement, inspect table definitions and a SchemaSpy report,
  and download selected tables as a ZIP containing a SQL dump and a manifest.
  The console shows at most 200 rows, bounds result sizes and query time, and
  summarizes binary values as byte counts. Queries cannot change the database. The dedicated reader can read table
  data and sequence values for exports, but cannot advance or change sequences.
  Every signed-in role may query and inspect the schema; Operator, Engineer
  and Admin may prepare exports, each owned by the account that asked. With
  the private worker, Proxmox stores the ZIP and the edge streams it;
  downloads resume and fail on truncation. Preparation runs in the
  background; ZIPs expire 24 hours after completion, active downloads are kept.
  The worker enforces disk and archive limits. Restarted unfinished exports
  fail and can be generated again. A download key
  (Download data tab; 1 h, 24 h or 7 days; revocable; shown once) lets a
  training job on the cluster list and download its owner's exports and
  nothing else; it ends when the owner's password changes. The table browser reads the live
  database; the SchemaSpy report is a separately generated snapshot. SchemaSpy generation
  runs on Proxmox; the console serves its static output.
  A Graphviz diagram sits beside the tools, below them on phones. A watcher
  checks schema and row-write counters every 30 seconds between jobs and
  regenerates SchemaSpy on Proxmox; changes during generation trigger the
  next check. The edge privately synchronizes completed snapshots and the
  page polls every 15 seconds. Failures retain the last diagram and timestamp.
- 03 Debug console, /console. Live thermal frames, the floor with fused
  occupancy, per-sensor health, and commands to a sensor (set a parameter,
  reset its background, identify, save, reboot).
- 04 Updates, /updates. Upload firmware source, build an image, roll it out
  over the air; each records who did it. A rollout always flashes one pilot
  sensor first; it must report the new version with a working sensor, or
  everything stops.
- 05 Analytics, /analytics. How the student site is used (students online,
  searches, sign-ins, traffic) at /analytics/usage, and how the server is
  doing (processor, memory, storage with a fill forecast, services, sensor
  ingest) at /analytics/server. Read-only. Counts only: no name, email or
  account id of a student is kept.
  Service health distinguishes the registry database from the training
  database. Registry storage may use files while the PostgreSQL training
  database is operational. The training database has its own read-only
  connectivity probe and uptime history; an unavailable database is reported
  as an outage, and time before monitoring began has no invented history.
- 06 Adoption, /adoption. Admitting a newly flashed sensor. TMflash creates a
  pending request; a person compares the board's UID and request code and
  approves it. An admitted sensor has no floor or position yet, so it cannot
  affect any number a student sees until it is placed.
- 07 TMflash web, /flash. Flash and set up a sensor from the browser, with no app
  to install. The board is plugged into the computer the browser runs on. The
  person clicks Connect, the browser shows its own list of USB devices, and
  only the one they pick becomes reachable. It needs Chrome or Edge on a
  computer (Web Serial); Safari, Firefox and phones are told they cannot.
  The firmware is always the latest release published by the TMsense
  firmware repository on GitHub; nobody chooses or uploads a file. The
  console server downloads the release from GitHub, checks every file
  against the SHA-256 list in the release, and refuses a release that is
  incomplete or is not TMsense firmware. The page shows the version, tag and
  commit it will write. If no release has been published, or GitHub cannot
  be reached and nothing was checked before, the page says so and only
  settings can be changed. A new firmware version reaches the page when the
  firmware repository's Release workflow is run on its main branch.
  The page writes four images (bootloader,
  partition table, boot selector, application), checks each by reading it
  back, then sets the node up over its serial console: node ID, uplink (Wi-Fi
  through a local gateway, Wi-Fi direct to cloud, or LoRa), network name and
  password, gateway address or cloud URL, signing key, frame rate. A blank
  field keeps what the node has. It reads the settings back to verify them.
  It never erases a board: the node's saved settings and boot counter (NVS)
  are left untouched, and a build whose layout would reach them is refused.
  The Wi-Fi password and the signing key go from the page to the USB port.
  They are never sent to the server, stored, or logged.
  "Write firmware" can be turned off to change only the settings of a board
  that already runs TMsense. With "Ask TMedge to admit this node" on, the
  page queues the adoption request itself and stops at an "Admit this board"
  button showing the UID read from the board; pressing it is the approval,
  and someone else may approve or deny it in Adoption instead. Engineers and
  admins only. Opening a board's serial port restarts it. A browser cannot
  scan for Wi-Fi networks, so the name is typed; flashing several boards at
  once is only in the Mac app.
- 08 TMflash download, /tmflash-download. Everyone signed in can download
  the latest published Mac app. TMflash master updates automatically publish
  a DMG and size/SHA-256 manifest; the portal checks every minute and hosts
  verified files in a persistent cache. New builds need no portal deploy.
  Intel and Apple Silicon, macOS 14+, with firmware and tools included; no
  Python, PlatformIO or source folder. Open the DMG and drag into Applications.
  Included firmware works offline; account adoption needs internet.
  Unnotarized builds have Apple's Open Anyway instructions. GitHub outages
  label the last checked build; invalid newest releases are refused.
- Accounts, /accounts (admins only). Create accounts, set access roles and
  team roles, reset passwords, revoke sessions.
- Account settings, /account (everyone, for their own account only; opened
  from the account icon). It shows the username, access role, team roles and
  when the account was created; an admin sets those. The person can save an
  email address and tick what they want to be emailed about (sensors,
  training jobs, firmware, live parameter changes, team mail, tasks), change
  their own password by giving the current one, and "Sign out everywhere".
  Changing the password keeps that browser signed in and signs out every
  other device and any TMflash app session. The email address is private to
  its owner: no admin, page or list shows it to anyone else, and Ask AI is
  never given it. Email uses Amazon SES when configured; otherwise the page
  says the address is kept and delivery is off. "Send confirmation code"
  sends six digits, valid for 30 minutes and five tries. The owner types them
  back; an unconfirmed address receives nothing else. Changing it requires
  confirmation again. Ticked topics arrive as plain-text digests, checked
  each minute: only events after opt-in; clearable faults only after ten
  minutes and not again that day; at most one digest per 15 minutes and 12
  per day. Team mail includes sender and subject, never body. Each recipient
  receives only what their own role permits them to see.

System figures on the landing page: sensors reporting, seats taken now,
students online, processor, memory, storage. A dash means the source did not
answer; it never means zero.

## People, roles and the team workspace

Access roles decide what someone may do:
- Viewer: read everything operational; cannot change settings.
- Operator: also change algorithm parameters, use routine sensor commands,
  run their own training jobs.
- Engineer: also firmware, flashing and provisioning, and advanced sensor
  commands.
- Admin: also manage accounts.
Being an admin does not let anyone read another person's mail, training jobs,
cluster credentials or the email address in their account settings.

Team roles say what someone works on: ML, front-end, back-end, firmware,
hardware. They are labels for finding and assigning people. They grant no
access.

Mailbox: messages between account holders. A message is visible to its sender
and its recipients only. No role can read other people's mail, and the
assistant is never shown any mail.

Board: anyone signed in can file a feature request and vote on it. Operators,
engineers and admins decide a request's status (open, planned, in progress,
shipped, declined) and create and assign tasks. Whoever a task is assigned to
can move its status (to do, in progress, done) whatever their role.

## How it is run

- One server runs the edge and the student web service as separate
  processes. Occupancy history, recordings and the workspace files live in a
  data directory that survives deployments.
- Deployment is only through the pipeline: a pull request with passing
  checks, an artifact built by CI, an approval by the owner, then an
  automatic health check with rollback. Nobody copies files onto the server.
- A change only to the root README runs brief documentation checks and does
  not build or deploy the runtime. A daily GitHub task refreshes its generated
  directory tree only when tracked project paths change, using a pull request
  and the required checks. Written descriptions are maintained by people.
  Code and runtime configuration changes still run the full pipeline.
  Later changes only to the root README do not invalidate an already checked
  release; every other Git tree entry must still match before deployment.
- Firmware and the edge share a wire format. A change to it must be made in
  both repositories and proved by "npm run crosscheck".
- Training data (thermal and camera frame pairs from the calibration rig) is
  recorded only when recording is switched on, and is stored privately, apart
  from anything students can reach.
- Ask AI runs on a model on the team's own cluster, not a public service. It
  is given this file, a few live figures and, when a question names something
  a file can be found by, a few pieces of this repository's source and
  documents (tests by title only; never configuration or data). Each answer
  lists the files it was shown. It sees pieces, not whole files, explains
  code without writing it out, and has no tools: it cannot change anything.
  The model is loaded when the landing page opens.

## Availability

AWS is the primary student website. Cloudflare sends all normal traffic there
and uses the Proxmox website only after readiness failures. The standby has a
read-only database copy: existing accounts can sign in, but sign-up, activity,
sensor ingest and console writes remain on AWS. AWS publishes occupancy to
both websites; if it stops, counts become unknown, never empty.

A full-site mode is being prepared, but is not live. A PostgreSQL lease
will authorize one origin for sensor, console and student traffic;
the old owner closes listeners before takeover, and the standby's
readiness stays false until it owns the lease. Node/gateway replay and command
cursors are fenced and importable. Console/session, artifact and ML state
must move to shared stores, and a managed cloud
database must pass restore/failover tests before this mode is enabled. See
docs/FAILOVER.md and deploy/backup/README.md.

## Where to look for more

- Detection and parameters: Algorithm flow, and docs/ALGO_DASHBOARD.md.
- Why a count looks wrong: Debug console for the sensor's live frames and
  health; Analytics, server view, for sensor ingest.
- Server health and storage: Analytics, server view.
- Student usage: Analytics, usage view.
- A sensor that will not join: Adoption, and docs/ADOPTION.md.
- Browser flashing: TMflash web, docs/WEB_FLASHER.md. Mac app: TMflash download, docs/TMFLASH_DOWNLOAD.md.
- Firmware: Updates. Training: ML job, and docs/hpc/. Database: ML data, and docs/ML_DATA.md.
- The workspace and this assistant: docs/WORKSPACE.md, docs/ASSISTANT.md.
