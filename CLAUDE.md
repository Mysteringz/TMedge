# TMedge — notes for AI coding sessions

Edge processing + student web app for TMnode thermal sensors. Firmware lives
in `../TMsense` (the thermal node, formerly TMnode).

## Map

```
src/edge/protocol.ts     wire format reader — mirrors TMsense/include/tm_protocol.h
src/edge/ingest.ts       UDP, HMAC, replay by (boot, seq), per-node loss, commands
src/edge/registry.ts     site/nodes config + strict validation, coverage per table
src/edge/occupancy.ts    projection -> authority per table -> seats -> smoothing
src/edge/runtime.ts      wires ingest/occupancy/recorder/publisher; node & edge health
src/edge/console.ts      admin console HTTP/WS (raw frames live here only)
src/edge/recorder.ts     daily JSONL logs = Phase 3 calibration data
src/shared/geometry.ts   110° f-theta pixel <-> floor, height-aware
src/shared/seats.ts      seat layout + "N seats together" (server and client share it)
src/web/                 student web tier (auth, snapshot store, API, WS)
src/dashboard-client/    student UI (tsc only, no framework)
src/console-client/      admin console UI
src/tools/simulator.ts   virtual nodes sending real signed packets; --truth for accuracy
```

## Commands

```bash
npm run build && npm test && npm run typecheck
npm run crosscheck           # needs ../TMsense and g++
npm run edge | web | simulate
```

## Invariants

- **Silence is never emptiness.** Unknown tables have `occupied: null`, are left
  out of free totals and are never suggested. A stale edge turns its whole floor
  unknown in the web tier.
- **Each person is counted once.** One authority node per table (owner →
  fallback → unknown). Tests prove the overlap and fallback cases.
- **A table never reports more than its seats; the zone counts everyone.**
- **Counts are smoothed**, both seat hysteresis and median zone counts. Never
  use the latest frame.
- **Blob heat is compared after normalising by pixel floor area.** Raw heat
  varies ~2× across a 110° view and produced phantom seats (86% → 98%
  accuracy when fixed).
- **Privacy boundary:** only `OccupancySnapshot` leaves the edge. Raw frames
  reach a browser only in the authenticated admin console on the edge.
- **Students can't write.** The only write on the web tier is the edge's
  bearer-token push.
- **Config is strict.** Add validation for any new field.
- **Wire format changes touch both repos** and `npm run crosscheck`.

## Conventions

TypeScript `strict` + `noUncheckedIndexedAccess`; runtime deps are only
`express` and `ws`. Comments explain *why*. Plan units are cm, origin top-left.
Tests read as claims about behaviour. Add one that fails without your change.
On the dev Mac, NordVPN may block LAN traffic; bind to `en0` if packets stop.
