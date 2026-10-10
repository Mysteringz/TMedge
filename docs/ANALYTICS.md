# Analytics (module 05 of the algo console)

`algo.hkumyseat.com/analytics` answers two questions an operator otherwise has
to SSH in to answer: **is HKUMySeat being used, and is the machine behind it
well.** It reads; it has no control and no endpoint that changes anything.

Three views, one time range (1 hour, 24 hours, 7 days, 30 days) that scopes
everything under it:

| view | path | what it shows |
|---|---|---|
| Overview | `/analytics` | students online and active, searches, seats taken; processor, memory, storage, sensors; service health |
| HKUMySeat usage | `/analytics/usage` | registered and active students, what they did, sign-ins, new accounts, traffic and response time of the student site, occupancy over time and by hour of the week |
| Server and back end | `/analytics/server` | processor (with steal and I/O wait), memory, swap, storage with a fill forecast and a breakdown of the data directory, network, systemd units, the edge process, sensor ingest |

Any signed-in role may open it (`algo.read`); the range is in the address, so
a link opens the same picture.

## Where the numbers come from

```
student browsers ──> web tier ── UsageMeter ──────────────┐   src/modules/analytics/application/usage-meter.ts
                       (counts, never rows about a person) │
                                                           │  GET /api/edge/usage   (edge's push token)
sensors ──> edge ── EdgeAnalyticsCollector ── every 10 s   │
              │       host (/proc), process, ingest,       │
              │       occupancy of public floors           │
              └── ReadAnalytics <──────────────────────────┘   + systemd, + data-directory scan, on demand
                       │
                       └── GET /api/analytics?range=…  ──> the page (algo-app/src/pages/analytics/)
```

- **The edge samples itself** whether or not anyone is looking, because last
  week's chart needs someone to have been writing it down last week. Host
  figures are read from `/proc` on Linux: memory in use is `MemTotal -
  MemAvailable` (so page cache is not mistaken for a leak) and processor time
  separates *steal* -- on a burstable instance, the number that says the box is
  being throttled. Off Linux (a developer's Mac) it falls back to `os`, and what
  it cannot measure there is reported as unknown.
- **The web tier meters its own traffic**, because that is where students are.
  The edge fetches the report with the same credential and in the same
  direction as a snapshot push; nothing calls in to the edge, and no student
  session can read the report.
- **systemd** is asked with `systemctl show` for a fixed list of unit names.
  Names are validated as plain unit names before they are used as arguments;
  nothing is ever started, stopped or changed.

## Rules this module keeps

- **Unknown is not zero.** A source that did not answer is `unavailable`; one
  that is not configured is `disabled`. Neither carries data, so a tile shows a
  dash and says why. A stretch nothing was measured in is a gap in the line. A
  floor no working sensor covers has no "seats taken" figure, and occupancy is
  always a share of the seats that *are* covered. This is "silence is never
  emptiness", applied to charts.
- **Counts, not people.** Nothing here holds an email, a name or an account
  ID. "Different students today" needs something stable per student for a
  month, and what is kept is a keyed hash cut to 64 bits
  (`distinct-days.ts`): the key is derived from the web tier's session secret
  and is not in the file. Paths are counted under a handful of names
  (`pages`, `sign-in`, `occupancy`, …), never as typed.
- **Nothing that could be a picture.** The module reads occupancy totals and
  host figures. It never touches frames, detections or sensor addresses.
- **It cannot hurt the services it watches.** History writes are append-only
  and never throw; an unwritable directory costs the charts their past and
  nothing else. The data-directory scan yields to the event loop and is bounded
  by entries and by time. The database check cannot hold up a sample.

## What is kept, and where

History survives restarts and deploys, as small append-only JSON-lines files
in the data directory (never in the release).

| directory | written by | holds | kept |
|---|---|---|---|
| `DATA_DIR/analytics-edge/` | edge | host, process, ingest and occupancy gauges: a line a minute and a line every fifteen minutes | 26 hours at a minute, 32 days at fifteen minutes |
| `<dir of USERS_FILE>/analytics-web/` | web tier | event counts per five minutes and per hour; request-rate, latency and online gauges; one line of hashed student IDs per day | 48 hours at five minutes, 35 days hourly, 35 days of daily IDs |

Ten-second samples for the last hour are in memory only. Sizes are a few
megabytes in all. The two directories are siblings on purpose: the services
may run as different users, and neither depends on the other's directory.

History begins when this version first runs. Ranges that reach back before
that say so above the charts and leave the earlier part empty.

## Settings

Both optional; both validated at start-up.

| variable | read by | default | meaning |
|---|---|---|---|
| `ANALYTICS_TIMEZONE` | edge and web | `Asia/Hong_Kong` | The site's own zone: what "today" means for daily counts and for the hour-of-week pattern. Set it the same for both. |
| `ANALYTICS_UNITS` | edge | the stock unit names (`tmedge-edge.service`, `tmedge-web.service`, `tmedge-sim.service`, `cloudflared.service`, `tailscaled.service`, `tmedge-training.service`, `tmedge-training-tunnel.service`, `tmedge-prune.timer`) | Comma-separated systemd units whose state to show. Units the machine does not have are left out, not shown as stopped. |

## Service health

Each row is a status now (an icon and a word), thirty daily marks and the share
of recorded time it was up:

| row | "up" means | a day is degraded / an outage below |
|---|---|---|
| Edge service | a sample exists for the fifteen-minute slot | 99% / 90% of slots |
| Student web tier | every snapshot push target answered | 99% / 90% |
| Sensor ingest | sensors reporting ÷ sensors registered | 90% / 50% |
| Recorder | no stream has a write error | 99% / 90% |
| Database | it answers `SELECT 1` within 3 s (only where one is configured) | 99% / 90% |

A day before history began has no mark at all.

## Cost

One page is about 100 kB of JSON, sent gzip-compressed (about a tenth of
that), and an open tab asks again every 10 s on the hour view, 30 s on the day
view and one to two minutes on the longer ones; a hidden tab stops asking.
Several tabs on the same range within two seconds share one assembly.

## Not here

- Per-student activity. Where accounts are in PostgreSQL the durable activity
  log has it (`docs/student-accounts.md`); this module deliberately does not.
- Sensor, training, firmware and parameter status: that is the notification
  bell and each module's own page.
- Alerts. This page shows; it does not notify.

## Tests

`test/analytics-history.test.ts` (gaps, restarts, what is never written),
`test/analytics-host.test.ts` (reading `/proc`, units, the directory scan),
`test/analytics-usage.test.ts` (what the web tier counts and who may read it),
`test/analytics-api.test.ts` (roles, unknown-is-not-zero, end to end), and the
Analytics steps in `test/algo-mobile.test.mjs` (the page on a phone, in
Chromium and WebKit).
