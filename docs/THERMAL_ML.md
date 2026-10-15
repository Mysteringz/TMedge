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

## What the teacher cannot see is unknown (found 2026-10-13)

A pilot model, and today's edge detector, both "invented" people on frames
the teacher called empty on 7 Oct (0.49 and 0.68 per empty frame). Mapped
back into a 15:30 photo, the three hottest spots were:

- a real person, seated at the photo's bottom edge and only partly in
  view. No RGB detector found them, and both thermal detectors did. This is
  a teacher miss, not a detector error.
- two warm electronics on the desk. These are real false people, which the
  model must learn to ignore. 7 Oct is a training day for that reason too.

So the known region stops 60 photo px short of the photo's edge: 305 of 768
thermal px instead of 503. Count error on 7 Oct fell from 0.68 to 0.12 for
the edge detector, and from 0.51 to 0.06 for the pilot.

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

- **First thermal model:** whole days.
  - Train on 6, 7 and 11 Oct. **Validate on 10 Oct.**
  - The first choice (train on 6, 7, 10; validate on 9, 11 = 74/26 by frames)
    left almost nobody to validate on. 9 Oct's only lit photos fall in the
    edge background's first hour, so it has 0 usable frames, and 11 Oct has
    about 26 people.
  - Validating on 10 Oct is closer to P'Ing's 70/30 *by people*, about 65/35.
  - Frames within 30 minutes of a day boundary are dropped.
  - Validation picks the epoch and the threshold, and nothing else.
- **Final check:** the 400 hand-labelled September frames, at milestones only.
- **Nightly:** train on every day up to the day before yesterday, test on
  yesterday. The series of those scores is the "is it getting better" curve.

## Job 2: two recipes compared (decided 2026-10-14, before any result)

Job 1 (iw-g2, CPU) trains today's recipe on every October photo. Job 2 runs
on a team member's Linux PC with a 24 GB AMD GPU (`hpc_job.py --stage
compare`) and trains two recipes from the **same teacher boxes**, so the
labelling is done once and is identical for both:

| | Recipe 1 (control) | Recipe 2 |
|---|---|---|
| Network | widths 12/24/32, 30,575 weights | widths 16/32/48, 60,115 weights |
| Labels | the fused teacher, photo by photo | the same, voted on by the photos within ±3 s |
| Everything else | the same days, inputs, augmentation, epochs, threshold search | the same |

Kevin chose to change both at once. A win then says the pair helped, not
which half; the teacher boxes stay on the PC, so separating the halves is a
training run, not another labelling.

**The vote** (`labels.vote`): a person the teacher found in fewer than half
of the nearby photos is set aside as uncertain, and one it found in at least
half the photos before *and* half after, but missed in this one, becomes a
target. Nobody is ever turned into "no person"; frames with fewer than two
photos nearby keep their labels. Measured beforehand on every fifth photo
(about 4 s apart): 1.9% of 6 Oct's 513 labelled people and 6.9% of 7 Oct's
58 appeared in neither neighbouring photo. The vote changes few labels, so
recipe 2's difference may come mostly from the larger network.

**Edge cost**, measured with the edge's own `heatForward` on the M4 (median
of 5 x 1,000 frames): 4.5 ms per frame for recipe 1, 8.3 ms for recipe 2. The
t3.micro is not measured yet; that comes before anything ships.

**How the winner is chosen:**
- Each recipe trains 3 times (seeds 0, 1, 2). Each keeps the run with the
  best F1 on 10 Oct against **its own** labels, as it would in production.
- Both kept models are scored on 10 Oct against **both** label sets, since
  each label set favours its own recipe. This is reported, not used to decide.
- **The hand test decides**, one use per recipe in the ledger. The two
  models are compared by the difference in F1 on the same 400 frames, with a
  95% interval from resampling the same 10-minute blocks for both
  (`metrics.paired_bootstrap`).
  - Interval above 0: recipe 2 is better.
  - Interval below 0: recipe 1 is better.
  - Otherwise: **no measurable difference on 400 frames**, which is reported
    as such. Nobody rounds it into a win.

**Using all of the data** (asked for by Kevin the same day):
- **Every rig day in the export.** Days after 11 Oct are labelled and
  trained on too, each only if both cameras are where they were on 6 Oct
  (`alignment.same_place`: the day's median photo within 2 px and 0.3°, and
  its thermal background within 0.25 px). These are the checks done by hand on
  13 Oct, which measured 0.0–0.7 px and 0.04 px within October. A day that
  fails, or has fewer than 500 photos, is left out, and `days.json` says why.
  10 Oct stays the check day.
- **A final model on every labelled day, 10 Oct included.** After the
  comparison, the winner is retrained on all of it, with the same learning-rate
  schedule and seed, and kept at the epoch and threshold its validation chose.
  With no measurable winner, recipe 1 goes on, because it costs the edge half as
  much. The hand test scores it, a third use in the ledger. Two caveats are
  reported with that score: the hand test also chose the recipe, so the score is
  slightly optimistic; and no October check day is left.
- **Not used, on purpose:**
  - photos too dark for the teacher;
  - thermal frames without a photo, which are near-copies of a neighbour a
    second away;
  - the bench board, which has no labels.

## Jobs 1 and 2: results (measured 2026-10-15)

On the 400 hand-labelled frames, scored the same way for every row:

| Model | Trained on | Hand test F1 [95%] | Recall |
|---|---|---|---|
| Today's edge detector (19-Sept background) | n/a | 0.558 [0.491, 0.616] | 0.771 |
| Job 1: recipe 1 (iw-g2) | 6, 7, 11 Oct | 0.384 [0.282, 0.486] | 0.350 |
| Job 2: recipe 1, best of 3 | 6, 7, 11 Oct | 0.367 [0.271, 0.453] | 0.347 |
| Job 2: recipe 2, best of 3 | 6, 7, 11 Oct | 0.305 [0.172, 0.416] | 0.243 |
| Job 2: final (recipe 1) | 6, 7, 10, 11 Oct | 0.283 [0.150, 0.395] | 0.183 |

- **Recipe 1 reproduces** on two machines (0.384 and 0.367), and its three
  runs agree on 10 Oct (0.407–0.420).
- **Recipe 2 vs recipe 1:** −0.062 [−0.150, +0.001]. No measurable
  difference.
- **No model beats today's detector**, so none ships.
- **Fitting October better made the hand test worse.** That held for the
  bigger network, and for adding 10 Oct to training. The intervals overlap,
  so this is a pattern, not proof. Every run peaked at epoch 4 of 25.

**A scoring fault found on the way.**
- 42% of 10 Oct's sure people lay in the band between 30 and 60 photo px
  from the photo's edge. Training used them as people, but the check-day
  scoring threw away every prediction there, so they could never be
  matched.
- This held down every check-day score (the edge detector's too) and the
  epoch and threshold chosen from it. Rescored, recipe 1 (retrained the
  same way, seed 0) has 10 Oct F1 **0.798** (precision 0.913, recall 0.708,
  count error 0.050). The edge detector has 0.194 (precision 0.111, recall
  0.739, count error 0.896); it reports warm desk equipment as people.
- Fixed in `train.scorable`: a prediction near a sure person is always
  judged. One that matches nobody is judged only where the photo could see,
  because the teacher misses people near the edge.
- The hand test was unaffected: it scores the whole photo.

## Why the September test failed (diagnosed 2026-10-15)

Every check below avoids the 400 hand-labelled frames.

**Not position.** A first look suggested coverage: the labels only cover
what the October photo sees (305 of 768 sensor pixels), and only 39% of the
hand test's people stand inside that region (positions only, no model scored).
Two checks disproved it:
- **Moving frames was a flawed test.** It cuts people off at the image's
  border, and that alone lowers recall.
- **Pasting real people instead.** 200 isolated people from 10 Oct were
  pasted into empty 10 Oct frames at 35 positions across the sensor. Recipe
  1 found 80% of them overall, and 63–94% at every position, including where
  no label ever was.
- **Shift augmentation** (each training frame moved up to 8 px) found 74%,
  and scored 0.725 on 10 Oct against 0.798 without it. It was dropped.

**Frame rate: no effect.** History from one frame per 8 s left recall
unchanged, and so did no history at all.

**The cause is the test's fixed background.**
- **Where:** the 6,645 lit September frames that are not hand-labelled,
  scored against yolo11s (the only teacher that read every September photo;
  0.782 on the hand labels).
- **Comparison:** on the 4,372 of those frames where the edge's live
  background was ready, the fixed 19-Sept background against the live one:

  | | F1 [95%] | Precision | Recall | Count error | False people per frame |
  |---|---|---|---|---|---|
  | Model (recipe 1), fixed | 0.061 [0.009, 0.124] | 0.033 | 0.457 | 0.867 | 0.892 |
  | Model (recipe 1), live | **0.419** [0.272, 0.502] | 0.375 | 0.474 | **0.070** | **0.052** |
  | Edge detector, fixed | 0.114 [0.034, 0.180] | 0.062 | 0.727 | 0.714 | 0.728 |
  | Edge detector, live | 0.290 [0.096, 0.430] | 0.181 | 0.727 | 0.217 | 0.217 |

- **Why:** the room on 26 and 29 Sept was not as it had been on 19 Sept, so
  against the fixed reference every leftover warm spot looked like a person.
  The model, trained only on live backgrounds, suffered most.
- **Positions are fine:** where the model finds a person, it is a median 1.15
  px from yolo11s's point, with no systematic offset.
- **What remains:** in September it finds about half the people (recall 0.47)
  against the edge detector's 0.73.

**The hand test now uses the live background** (decided 2026-10-15). Kevin
asked which choice gives the most accurate model. The test chooses which
model ships, so it must measure the way a sensor runs.
- **Which frames:** the hand-labelled frames where the edge's background
  is ready. In the bake-off that was 182 of the 400 (edge detector: 0.693).
  The others come from the first hour of a recording, when a sensor
  reports not-ready.
- **The old rule** (fixed background, all 400) is still run for the record
  and decides nothing. Ledger entries say which background was used.

## Job 3: job 2 again, measured correctly (2026-10-15)

- **Job 2's verdict and final model were chosen under both faults**: the
  check-day scoring and the hand test's background.
- **Job 3 re-runs it on the Mac.** It uses the same labels, recipes 1 and 2,
  three runs each, and the same comparison rule (paired difference in hand
  test F1, now with the live background). Training this network needs no
  big GPU: a run takes about 2.5 minutes on the M4.
- **Uses of the hand test** go in the same ledger as job 2's
  (`data/ml/job2/reports/handtest-ledger.jsonl`).

**Results (measured 2026-10-15).** The hand test is the 182 frames with a
live background, the same frames as the edge detector's 0.693:

| Model | 10 Oct F1 [95%] (fixed scoring) | Hand test F1 [95%] | Precision | Recall | Count error |
|---|---|---|---|---|---|
| Today's edge detector | 0.194 | **0.693** [0.624, 0.781] | 0.636 | 0.762 | 0.379 |
| Recipe 1, best of 3 (run 2) | 0.805 [0.748, 0.856] | 0.290 [0.132, 0.494] | 0.679 | 0.184 | 0.901 |
| Recipe 2, best of 3 (run 2) | 0.799 [0.736, 0.856] | 0.482 [0.323, 0.584] | 0.714 | 0.364 | 0.643 |
| Final: recipe 2 on 6, 7, 10, 11 Oct | n/a | 0.479 [0.380, 0.633] | 0.841 | 0.335 | 0.725 |

- **Recipe 2 minus recipe 1:** +0.192 [+0.006, +0.288], paired over 27
  ten-minute blocks. By the rule, recipe 2 is better. On 10 Oct the two are
  level.
- **For the record, the old rule** (fixed background, 400 frames): recipe 1
  0.390, recipe 2 0.427, final 0.363.
- **Nothing ships.** The best model scores 0.48 against the edge detector's
  0.69 on the same frames. It reports people more reliably (precision 0.71–0.84
  against 0.64), but on these busy September evenings it finds only about a
  third of them (recall 0.34–0.36 against 0.76). On the rig's October check
  day it is far ahead: 0.80 against 0.19.
- **The hand test has now been consulted 9 times** on this ledger, plus the
  bake-off and job 1's ledger on iw-g2. A fresh hand-labelled set from other
  days is needed before it decides much more.

## Why it misses people in September (diagnosed 2026-10-15)

Measured on September frames outside the hand test (live background,
yolo11s labels), and on 10 Oct. Recall is the share of people the model
finds; the model is job 3's recipe 2 pick.

- **Absorbed into the background: 10% of people.** Their difference from the
  background is under 1 °C (2% in October), and none of them are found.
- **Not crowding.** 96% of September's people have nobody within 6 px.
- **Not size or shape.** Median blob area is 16 px against 14 in October;
  elongation 1.46 against 1.63. They are missed at every size and shape.
- **Recent change: small.** Switching c2 off moves recall from 0.40 to 0.43.
- **The swap test:**

  | | Found |
  |---|---|
  | September people, in their own frames | 49% |
  | September people pasted into October's empty frames | 68% (October's own people: 70%) |
  | October people pasted into September frames | 83% |

  The people look normal, and the room does not suppress other people. It
  fails when the two come together.
- **What the frames show.** September's room has a warm band across its
  lower part, a table edge with warm things on it. Most missed people sit on
  or against it, and the model gives them 0.45–0.58 against a threshold of
  0.6. In October it learned that warm things on the desk are not people.

**Recipe 4 tries to fix it.**
- **What it changes:** recipe 2, but half the training frames with people
  are pasted into the bench board's room (another house, never labelled).
  Each person comes with the 7×7 around them, and only that window is known
  (`train.into_scene`, `--scene-sensor`).
- **Runs:** three runs scored 0.816, 0.838 and 0.798 on 10 Oct, against
  recipe 2's 0.699, 0.802 and 0.794.
- **Best of each recipe, outside the hand test:**

  | | 10 Oct F1 | September F1 [95%] | Precision | Recall |
  |---|---|---|---|---|
  | Recipe 2 | 0.799 | 0.214 [0.051, 0.336] | 0.156 | 0.343 |
  | Recipe 4 | **0.830** | 0.214 [0.059, 0.329] | 0.138 | **0.473** |

  The September labels are both YOLO models fused the way October's are:
  sure where both see a person, set aside where only one does. yolo11s alone
  misses 30% of the hand-labelled people, so on its own it would count real
  people as false.
- **Result: it finds clearly more of the missed people**, and is better on
  October. But it reports about as many extra people that neither YOLO saw,
  so September F1 does not move (−0.000 [−0.061, +0.070]).
- **Not adopted, and not put to the hand test.** It stays available,
  switched off by default (job 4 in `hpc_job.py`).

**What the measurements say is still missing.**
- **Variety.** Every model learns the one room it was trained in. Precision is
  about 0.9 there and 0.14–0.38 in another room, whichever recipe is used.
- **A test that weighs empty rooms.** 90% of the hand test's frames have
  people, but 82% of September's frames are empty. A model that adds false
  people to empty rooms, which makes a free seat look taken, is barely
  penalised. The next hand-labelled set should include empty periods.

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
