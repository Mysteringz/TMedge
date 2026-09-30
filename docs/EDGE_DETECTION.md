# Edge detection against a day-long background

A node with `"detector": "edge"` in `nodes.json` is counted from its RAW
frames by the edge, not from its own REPORT detections. The rig on the intern
desk is the first node to use it.

## Why

The node's detector keeps an exponential background (`bg_tau` of about 90
frames). It never absorbs a *labelled* person, but in any frame where a seated
person's blob is missed (below `min_peak`, merged with a neighbour, split
oddly), those pixels drift into the background. Over one to three hours, a
student who sits still fades out of the count. A longer time constant only
moves the problem: one slow enough to keep a two-hour sitter is too slow to
follow the room.

## The model (`src/edge/staticbg.ts`)

This model tells room from people by *how long* a heat source stays, not by
how fast the background adapts.

1. **Level.** Each frame is taken relative to its own median, so the room
   warming or cooling over the day cancels out. People cover a few percent of
   the pixels and barely move the median.
2. **Buckets.** Every 15 minutes, at most one frame per 10 s goes into a
   bucket. The bucket's per-pixel median of those relative values is one vote.
3. **Quantile.** The background is the per-pixel **20th percentile** of the
   buckets from the last **24 hours**. A pixel is warm in the background only
   if it was warm in about 80% of them, which is 19 h of 24.

| Heat source | Buckets warm | Result |
|---|---|---|
| radiator, server, a lamp that is always on | ~100% | background, subtracted |
| someone sitting still for 1–3 h | 4–12% | person |
| someone at the desk all working day (9 h) | ~38% | person |

Detection (`src/edge/edgedetect.ts`) then segments `T − background` the way
the firmware does, with the firmware's default thresholds:

- threshold at `max(0.6 °C, 4σ)`, where σ is the frame's robust noise (MAD);
- find 8-connected components;
- split each component at the peaks of a 3×3-smoothed difference (1.9 px apart);
- keep blobs of area 1–60 px whose peak contrast is at least 1.2 °C;
- if more than 40% of the frame is foreground, treat it as a global shift and
  count no one.

The resulting REPORT goes through the same occupancy engine as any node's.

## Trade-offs

- **Warm-up.** For the first hour (4 buckets) the node reports
  *not ready*, so its tables are **unknown**, never empty. Until the window
  has filled, "most of the time" means most of the time *observed so far*:
  someone who has sat there since the model started can still be absorbed
  during those first hours. The buckets are saved to
  `$DATA_DIR/background/<mac>.json` after every bucket, so warm-up happens once
  per node, not after every restart or deploy.
- **Part-time heat.** Something warm for only part of every day, such as a PC
  that is on 9–6 or afternoon sun on one desk, never becomes background. It
  looks like a person unless its size rules it out (`max_area`). A
  time-of-day model, which compares with the same hour on previous days, would
  fix that once there are several days of data.
- **RAW every frame.** Edge detection runs once per RAW packet. The rig sends
  one every frame. A TMsense node would need `raw_every = 1`.

## Switching a node

1. Set `"detector": "edge"` on the node in the edge's `nodes.json` (in
   production, the copy in `/opt/tmedge-shared`) and restart the edge.
2. Make sure the node sends RAW every frame. The console's background column
   reads `edge · learning · 0 h of 24`, then `edge · ready` after about an
   hour.
3. To switch back, remove the field. The node's own REPORT counts again at
   once. The rig bridge must then run with `DETECT_ON_BOARD=1`, or it sends no
   detections and the desk reads unknown.
