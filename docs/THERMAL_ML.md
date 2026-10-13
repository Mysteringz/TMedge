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

## Scoring the hand-labelled test (decided 2026-10-13, before any scoring)

**Background on the test days.**
- The edge's own background needs an hour of well-covered history. The
  September recordings were patchy, so under production rules only 182 of the
  hand-labelled frames had one, and only 2 of the 35 frames with three people.
- So the test days are scored against the rig's empty-room background, saved
  on 19 Sept as `rigs/intern-demo/empty_bg_rel.npy`. It correlates 0.90 and
  0.93 with the backgrounds the test days produce.
- It was captured before the test days, so no later frame is used.
- The production-exact score on the 182 frames is reported beside it.

**Picking the RGB teacher.** This rule is fixed before any detector is scored,
so it cannot be bent to fit the results.

- **Candidates:**
  - yolo11s and yolo26s: Ultralytics, imgsz 640, confidence ≥ 0.25, NMS IoU
    0.7, class person;
  - Faster R-CNN ResNet50-FPN v2: torchvision COCO weights, score ≥ 0.25, label
    person;
  - a weighted-box-fusion ensemble of those three: IoU 0.55; each fused box's
    confidence is the sum of its members' confidences divided by 3; kept if
    ≥ 0.25.
  - `rf-overhead-person` has stored outputs on only 56 of the 400 frames. It is
    reported there, but it cannot be chosen unless it is run on all 400.
- **Points:** a box is a person at its centre. Hand boxes and detector boxes
  are mapped into thermal pixels with the same September RGB→thermal fit (next
  section).
- **Matching:** per frame, a Hungarian assignment on thermal distance. A match
  counts if it is ≤ 2.0 thermal px.
- **Score:** F1 summed over all 400 frames. Ties go to the lower mean absolute
  count error.
- **If the best F1 is below 0.90,** stop and ask before fine-tuning anything.

**RGB→thermal fit.**
- **Similarity transform, by RANSAC,** with no assumed correspondence: the
  algorithm of `tools/train_human_location.py`.
- **Both orientations are tried,** because a similarity cannot mirror and the
  rig's thermal image was flipped on 6 Oct.
- **Fitted per period** (September, October) on frames that are **not** among
  the 400 hand-labelled ones, using consensus detector boxes and warm blobs in
  the thermal frame. Hand labels are never used for it.
- **Refused if the RMS is above 3 thermal px.**

**Result, and the fine-tuning round (decided 2026-10-13).** The best
off-the-shelf candidate, the ensemble, scored F1 0.841 (95% interval
0.793–0.882), below 0.90. Kevin chose to fine-tune, scored two-fold by day.
These settings were fixed before any fine-tuned model was trained:

- **Models:** yolo11s and yolo26s from their COCO weights, single class person.
  - Ultralytics training: imgsz 640, 60 epochs, batch 16, patience 20, seed 0.
  - Default augmentation, plus vertical flips (`flipud` 0.5), because the view
    is from overhead.
  - Prediction as before: confidence ≥ 0.25, NMS IoU 0.7.
- **Folds:**
  - Fold A trains on 26 Sept and predicts 29 Sept. Fold B trains on 29 Sept
    and predicts 26 Sept.
  - Inside the training day, the last 20% of its labelled frames by time are
    the validation set for early stopping. The other day is never seen.
  - Together the folds give one honest prediction for each of the 400 frames.
- **Candidates scored that way:**
  - each fine-tuned model alone;
  - the two fused (WBF, divided by 2);
  - the two plus the untuned Faster R-CNN (WBF, divided by 3).

  The same point-F1 rule picks the winner.
- **The teacher that labels October** is the winner's recipe trained on all 400
  frames, with the same settings (the last 20% of each day by time for early
  stopping). Its quality is quoted as the two-fold score, never as a score on
  frames it trained on.
- **The thermal test is unchanged.** The thermal model never trains on
  September, so fine-tuning the RGB teacher on September photos does not
  touch the thermal frames it is tested on.

**Note on the first fine-tuning runs.**
- Validation collapsed after epoch 1, on the Mac GPU and on the CPU alike.
- Evaluated after epoch 9, the model output the maximum 300 boxes per
  image at up to 0.98 confidence.
- The likely cause is the class head, which Ultralytics re-initialises when
  going from 80 classes to 1: it overshoots once the learning rate ramps up
  after warm-up.
- It recovered on its own (mAP50 0.17 by epoch 10). The recipe was left
  unchanged.

## The teacher that labels October (decided 2026-10-13)

**Fine-tuning made it worse.** Scored two-fold by day, fine-tuned yolo11s
reached F1 0.529, against 0.782 untuned.

| Fold | Trained on | Scored on | F1 | Precision | Recall |
|---|---|---|---|---|---|
| A | 26 Sept, 224 photos | 29 Sept | 0.520 | 0.38 | 0.81 |
| B | 29 Sept, 96 photos | 26 Sept | 0.533 | 0.48 | 0.61 |

- Each fine-tuned model was nearly perfect on its own evening's held-out
  frames (mAP50 about 0.98) and invented people on the other evening. It
  learned the evening, not people seen from above.
- The yolo26s fine-tune under the same recipe was stopped unfinished, by
  Kevin's decision, after the yolo11s result.

**The teacher** is therefore the bake-off winner, unchanged: the untuned
ensemble of yolo11s, yolo26s and Faster R-CNN (F1 0.841).

**How it is applied:**
- **Every fifth paired October photo.** Faster R-CNN would need 6–12 h for
  all 108k photos on the Mac, and frames a second apart are near-duplicates.
- **Only photos at least as bright as the darkest hand-labelled one** (mean
  grey 105; the hand-labelled range is 105–125). At night (mean grey about
  26–75) the detectors invent people in the dark; on 9 Oct the two YOLO
  models never agreed on one of their 618 "people". Too-dark photos are
  unknown, not empty.

## One camera-to-thermal fit per period (checked 2026-10-13)

| Period | Error | Frames explained | Other orientation |
|---|---|---|---|
| September | 1.20 px | 1,072 | 640 |
| October (20% photo sample) | 1.33 px | 1,637 of 2,021 | 1,326, with a near-zero scale |

The two periods differ (4.8 px where October's people sit), so each has its
own fit.

**Within a period, neither camera moved.** Measured directly, with no people
involved:
- **Photo camera:** each day's median photo aligns with the period's first
  day within 0.0–0.7 px of 640×480, rotation under 0.1°.
- **Thermal sensor:** each day's background aligns within 0.04 thermal px.

**Correction.** An earlier version of this page said the rig moved between 6
and 10 Oct, because fits on single days disagreed by 2–6 px. That was wrong.
People sit in the same few seats, so a fit on one day is pinned down only
near those seats and is ambiguous elsewhere: even the two halves of one day
disagreed. The per-day labelling it led to was reverted. Fits use whole
periods.

The nightly loop still checks this directly with the same two alignments,
and stops labelling a day if either camera has moved.

## Splitting the thermal model's data (decided 2026-10-13)

Never by random frames. Frames a second apart are nearly the same picture,
so a random split scores near-copies of what the model trained on.

- **First thermal model:** P'Ing's 70/30, done by whole days on the rig's
  October recordings, counting frames with a ready background.
  - Train on 6, 7 and 10 Oct: 100,643 frames, 74%.
  - Validate on 9 and 11 Oct: 35,406 frames, 26%.
  - Frames within 30 minutes of a day boundary are dropped.
  - Validation picks the epoch and the threshold, and nothing else.
- **Final check:** the 400 hand-labelled September frames, at milestones only.
- **Nightly:** train on every day up to the day before yesterday, test on
  yesterday. The series of those scores is the "is it getting better" curve.

**Running it.** The RGB photos, the detectors and the bake-off need the ML
environment (`tools/thermalml/requirements-ml.txt`, in `data/ml/.venv`):

```bash
python3 -m tools.thermalml rgb --dump <frames ZIP> --pairs <pairs ZIP> --shards data/ml/shards --out data/ml/rgb
data/ml/.venv/bin/python -m tools.thermalml.teachers --model yolo11s --rgb data/ml/rgb --out data/ml/teachers --day 2026-09-26 --day 2026-09-29
data/ml/.venv/bin/python -m tools.thermalml.mapping --name sept --day 2026-09-26 --day 2026-09-29 --background empty --exclude data/ml/handlabels/rgb-ids.txt
node dist/src/tools/replay.js --shards data/ml/shards --out data/ml/replay-emptybg --fixed-rel <empty_bg_rel as JSON> --fixed-day 2026-09-26,2026-09-29
data/ml/.venv/bin/python -m tools.thermalml.bakeoff
```

**Added after the rule was written, before any score was seen.** It affects
the thermal baselines only, not the choice of teacher. The thermal detectors
(firmware, edge) see the whole 32x24 view, but the photo, and so the hand
labels, cover about half of it. So their detections are only scored where the
mapping puts them inside the photo. Empty frames are reported as false people
per frame, because F1 has nothing to find there.

## Tests

```bash
python3 -m unittest discover -s tools/thermalml -t . -p 'test_*.py'
npm test    # includes test/thermalml.test.ts
```
