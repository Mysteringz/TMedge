# Thermal ML: data layer

The thermal people detector is trained offline in Python and will run on the
edge in TypeScript. This page covers the first part: turning what the training
database recorded into data a model can be trained and judged on.

## Day shards

```bash
# from an ML-data export ZIP that contains training.frames (no unpacking needed)
python3 -m tools.thermalml shards --dump data/ml/ml-data-<id>.zip --out data/ml/shards
# or live, through the reader role (TRAINING_DATABASE_URL, docs/TRAINING_POSTGRES.md)
python3 -m tools.thermalml shards --db --since 2026-10-12 --until 2026-10-13 --out data/ml/shards
python3 -m tools.thermalml summary --root data/ml/shards
```

One shard is every thermal frame one sensor recorded in one day:

| File | Contents |
|---|---|
| `<uid without colons>/<day>.thermal.gz` | N x 768 bytes, row-major 24x32; °C = tMin + byte × step |
| `<uid without colons>/<day>.json` | times (ms), frame numbers, tMin/step, frame ids, the node's own detections (legacy pairs only), pose spans, a SHA-256 of the pixels |

- **Days start at 04:00 Hong Kong time.** Sessions cross midnight, and the
  rooms are empty around four.
- **Frames within 30 minutes of a boundary** are left out of training and
  scoring.
- **RGB is not in the shards.** It is only needed to make labels.

## The locked test days

26 and 29 September 2026 hold the 400 hand-labelled frames, which are the
only test the team has.
- Their shards are written under `<root>/locked/`.
- `days.assert_trainable` refuses any training set that contains them.
- Use the hand test only at milestones, never as a nightly check.

## Same background as the edge

`tools/thermalml/staticbg.py` is a line-for-line port of `src/edge/staticbg.ts`,
including where values are rounded to float32. The model is trained on "frame
minus background", and it must be the background the edge will have.
`test/thermalml.test.ts` runs both on the same frames and fails if they differ
by 1e-5 °C or more.

## Today's detector as the baseline

```bash
node dist/src/tools/replay.js --shards data/ml/shards --out data/ml/replay
```

This feeds every shard, in time order and across days, through the real
`EdgeDetector`, as `runtime.ts` does for a `"detector": "edge"` node. It writes
the per-frame blobs and whether the background was ready. A new model is
scored against this on the same frames.

## Tests

```bash
python3 -m unittest discover -s tools/thermalml -t . -p 'test_*.py'
npm test    # includes test/thermalml.test.ts
```
