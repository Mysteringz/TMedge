#!/usr/bin/env python3
"""Fit the thermal locator from RGB ground truth.

    python3 tools/train_human_location.py pairs/ --out data/algo/models/

The rig on the intern desk sees the same scene twice: a Raspberry Pi camera
that can say where a person is, and a 32x24 thermal array that has to learn
to. This reads the pairs the edge recorded, finds people in the RGB, works
out how the two views line up, and fits weights the edge can apply to a
thermal frame on its own.

Three things it does not assume:

* **Where the cameras point.** The RGB and the thermal are not aligned and
  nobody wrote down how they are mounted, so the transform between them is
  fitted from the data -- a similarity transform from RGB pixels to thermal
  pixels, estimated from frames where exactly one person was present and the
  thermal frame has exactly one clear hot blob. If that fit is poor the
  script says so and stops rather than training on scrambled labels.
* **That a person looks like a person.** An overhead camera sees the top of
  a head, which pedestrian detectors are bad at, so people are found by
  background subtraction against a running median of the scene -- which is
  what actually works for a camera that never moves.
* **That it worked.** Everything is scored on frames held out from fitting,
  and the numbers go into the model file for the dashboard to show.

Needs numpy and OpenCV, neither of which belongs on the edge box:
    pip3 install numpy opencv-python-headless
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from dataclasses import dataclass

try:
    import numpy as np
except ImportError:
    sys.exit('numpy is needed: pip3 install numpy opencv-python-headless')
try:
    import cv2
except ImportError:
    sys.exit('OpenCV is needed: pip3 install opencv-python-headless')

GRID_W, GRID_H = 32, 24
FEATURES = ['bias', 'above_median', 'local_max3', 'local_mean5', 'gradient', 'row', 'col']


@dataclass
class Sample:
    at: int
    uid: str
    temps: np.ndarray      # (24, 32) degrees C
    jpeg: str              # path
    observed: list         # what the node itself reported, for comparison only
    mirror: bool


def load_pairs(root: str) -> list[Sample]:
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in sorted(files):
            if not f.endswith('.json'):
                continue
            meta_path = os.path.join(dirpath, f)
            jpeg_path = meta_path[:-5] + '.jpg'
            if not os.path.exists(jpeg_path):
                continue
            try:
                with open(meta_path) as fh:
                    m = json.load(fh)
                levels = np.frombuffer(base64.b64decode(m['pixels']), dtype=np.uint8)
                if levels.size != GRID_W * GRID_H:
                    continue
                temps = m['tMin'] + levels.astype(np.float32) * m['step']
                out.append(Sample(
                    at=int(m['at']), uid=m['uid'], temps=temps.reshape(GRID_H, GRID_W),
                    jpeg=jpeg_path, observed=m.get('observed') or [], mirror=bool(m.get('mirror')),
                ))
            except Exception as exc:                      # noqa: BLE001
                print(f'  skipped {f}: {exc}', file=sys.stderr)
    out.sort(key=lambda s: s.at)
    return out


def rgb_people(samples: list[Sample], every: int = 1) -> dict[int, list[tuple[float, float, float]]]:
    """People per sample, as (x, y, area) in RGB pixels.

    A fixed camera makes this easy and reliable: build a median background
    from a sample of frames, then anything large, bright-different and
    blob-shaped is a person. No pretrained model, nothing to download, and it
    does not care that the view is from above.
    """
    print('building the RGB background model...')
    stack = []
    for s in samples[::max(1, len(samples) // 60)]:
        img = cv2.imread(s.jpeg, cv2.IMREAD_GRAYSCALE)
        if img is not None:
            stack.append(img)
    if len(stack) < 5:
        sys.exit('not enough readable RGB frames to build a background')
    bg = np.median(np.stack(stack), axis=0).astype(np.uint8)
    h, w = bg.shape
    min_area = (h * w) * 0.004      # a person overhead is at least this much frame
    max_area = (h * w) * 0.25

    found: dict[int, list[tuple[float, float, float]]] = {}
    for i, s in enumerate(samples):
        if i % every:
            continue
        img = cv2.imread(s.jpeg, cv2.IMREAD_GRAYSCALE)
        if img is None or img.shape != bg.shape:
            continue
        diff = cv2.absdiff(img, bg)
        diff = cv2.GaussianBlur(diff, (9, 9), 0)
        _th, mask = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        n, _lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
        people = []
        for k in range(1, n):
            area = float(stats[k, cv2.CC_STAT_AREA])
            if not (min_area <= area <= max_area):
                continue
            people.append((float(cent[k][0]), float(cent[k][1]), area))
        found[i] = people
    with_people = sum(1 for v in found.values() if v)
    print(f'  {with_people} of {len(found)} frames contain someone')
    return found


def fit_transform(samples, people) -> tuple[np.ndarray, float, int]:
    """RGB pixels -> thermal pixels, from frames with exactly one of each.

    A similarity transform (scale, rotation, translation, and a flip if the
    data asks for one) is all the geometry two rigidly mounted cameras
    looking at a flat floor need. Fitted with RANSAC so a mislabelled frame
    cannot drag it.
    """
    src, dst = [], []
    for i, s in enumerate(samples):
        ppl = people.get(i) or []
        if len(ppl) != 1:
            continue
        # The warmest connected region of the thermal frame, if it is clear.
        t = s.temps
        hot = t > (np.median(t) + max(1.0, 0.6 * (t.max() - np.median(t))))
        n, lab, stats, cent = cv2.connectedComponentsWithStats(hot.astype(np.uint8), 8)
        blobs = [(stats[k, cv2.CC_STAT_AREA], cent[k]) for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= 2]
        if len(blobs) != 1:
            continue
        src.append([ppl[0][0], ppl[0][1]])
        dst.append([float(blobs[0][1][0]), float(blobs[0][1][1])])
    if len(src) < 12:
        sys.exit(f'only {len(src)} frames had exactly one person and one clear hot blob; '
                 'walk the room alone for a few minutes with recording on, then train again')
    M, inliers = cv2.estimateAffinePartial2D(
        np.array(src, dtype=np.float32), np.array(np.array(dst), dtype=np.float32),
        method=cv2.RANSAC, ransacReprojThreshold=2.5)
    if M is None:
        sys.exit('could not fit a transform between the two cameras')
    used = int(inliers.sum()) if inliers is not None else 0
    pred = (M @ np.hstack([np.array(src), np.ones((len(src), 1))]).T).T
    err = np.linalg.norm(pred - np.array(dst), axis=1)
    rms = float(np.sqrt((err[inliers.ravel() == 1] ** 2).mean())) if used else float('inf')
    print(f'  RGB->thermal fitted on {used}/{len(src)} frames, RMS {rms:.2f} thermal px')
    if rms > 3.0:
        sys.exit(f'the two cameras do not line up ({rms:.1f} px): check the rig is rigid and retrain')
    return M, rms, used


def features(temps: np.ndarray) -> np.ndarray:
    """Per pixel, matching src/algo/model.ts exactly."""
    flat = temps.reshape(-1)
    median = float(np.median(flat))
    spread = max(0.2, float(np.percentile(flat, 95) - np.percentile(flat, 5)))
    pad1 = np.pad(temps, 1, mode='edge')
    pad2 = np.pad(temps, 2, mode='edge')
    max3 = np.stack([pad1[y:y + GRID_H, x:x + GRID_W] for y in range(3) for x in range(3)]).max(axis=0)
    mean5 = np.stack([pad2[y:y + GRID_H, x:x + GRID_W] for y in range(5) for x in range(5)]).mean(axis=0)
    gx = pad1[1:1 + GRID_H, 2:2 + GRID_W] - pad1[1:1 + GRID_H, 0:GRID_W]
    gy = pad1[2:2 + GRID_H, 1:1 + GRID_W] - pad1[0:GRID_H, 1:1 + GRID_W]
    rows = np.repeat(np.arange(GRID_H)[:, None], GRID_W, axis=1) / GRID_H - 0.5
    cols = np.repeat(np.arange(GRID_W)[None, :], GRID_H, axis=0) / GRID_W - 0.5
    return np.stack([
        np.ones_like(temps),
        (temps - median) / spread,
        (max3 - median) / spread,
        (temps - mean5) / spread,
        np.hypot(gx, gy) / spread,
        rows, cols,
    ], axis=-1).reshape(-1, len(FEATURES))


def labels_for(sample: Sample, ppl, M) -> np.ndarray:
    """A disc around each projected person is positive; the rest is negative."""
    y = np.zeros(GRID_H * GRID_W, dtype=np.float32)
    if not ppl:
        return y
    pts = (M @ np.hstack([np.array([[p[0], p[1]] for p in ppl]), np.ones((len(ppl), 1))]).T).T
    yy, xx = np.mgrid[0:GRID_H, 0:GRID_W]
    for px, py in pts:
        near = ((xx - px) ** 2 + (yy - py) ** 2) <= 1.8 ** 2
        y[near.reshape(-1)] = 1.0
    return y


def train_logistic(X, y, epochs=240, lr=0.35, l2=1e-4):
    """Plain gradient descent, class-weighted: people are the rare pixels."""
    w = np.zeros(X.shape[1], dtype=np.float64)
    pos = max(1.0, float(y.sum()))
    neg = max(1.0, float((1 - y).sum()))
    wt = np.where(y > 0.5, neg / pos, 1.0)
    for _ in range(epochs):
        p = 1.0 / (1.0 + np.exp(-(X @ w)))
        g = (X * ((p - y) * wt)[:, None]).sum(axis=0) / len(y) + l2 * w
        w -= lr * g
    return w


def emit_features() -> None:
    """Reference output for TMedge's test suite.

    The edge applies these weights with its own copy of `features()` in
    TypeScript. If the two ever compute a different thing, a model fitted
    here means something else there and nobody would notice, so the test
    feeds a frame through both and compares -- the same discipline the wire
    format gets.
    """
    temps = np.array(json.load(sys.stdin), dtype=np.float32).reshape(GRID_H, GRID_W)
    json.dump([[round(float(v), 6) for v in row] for row in features(temps)], sys.stdout)


def main() -> None:
    if '--features' in sys.argv:
        emit_features()
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pairs', help='the directory the edge wrote (data/algo/pairs)')
    ap.add_argument('--out', default='data/algo/models', help='where to write <uid>.json')
    ap.add_argument('--uid', help='train only this node')
    ap.add_argument('--threshold', type=float, default=None, help='override the chosen threshold')
    args = ap.parse_args()

    samples = load_pairs(args.pairs)
    if args.uid:
        samples = [s for s in samples if s.uid == args.uid]
    if len(samples) < 200:
        sys.exit(f'only {len(samples)} pairs: leave the recorder on for longer '
                 '(a few hours of a used room is a reasonable start)')
    uid = samples[0].uid
    print(f'{len(samples)} pairs from {uid}')

    people = rgb_people(samples)
    M, rms, used = fit_transform(samples, people)

    # Hold out the last fifth by time, not at random: frames seconds apart are
    # nearly the same picture, and splitting them randomly would let the model
    # be scored on what it has already seen.
    split = int(len(samples) * 0.8)
    def build(rng):
        Xs, ys = [], []
        for i in rng:
            s = samples[i]
            if i not in people:
                continue
            Xs.append(features(s.temps))
            ys.append(labels_for(s, people[i], M))
        return np.concatenate(Xs), np.concatenate(ys)

    Xtr, ytr = build(range(split))
    Xte, yte = build(range(split, len(samples)))
    print(f'  fitting on {len(ytr)} pixels ({int(ytr.sum())} person), holding out {len(yte)}')
    w = train_logistic(Xtr, ytr)

    p = 1.0 / (1.0 + np.exp(-(Xte @ w)))
    best = (0.0, 0.5, 0.0, 0.0)
    for th in np.arange(0.2, 0.95, 0.05):
        pred = p >= th
        tp = float((pred & (yte > 0.5)).sum())
        fp = float((pred & (yte < 0.5)).sum())
        fn = float((~pred & (yte > 0.5)).sum())
        prec = tp / max(1.0, tp + fp)
        rec = tp / max(1.0, tp + fn)
        f1 = 2 * prec * rec / max(1e-9, prec + rec)
        if f1 > best[0]:
            best = (f1, float(th), prec, rec)
    f1, th, prec, rec = best
    if args.threshold is not None:
        th = args.threshold

    # How far off is a placed person, in thermal pixels, on the held-out part?
    errs = []
    for i in range(split, len(samples)):
        ppl = people.get(i) or []
        if len(ppl) != 1:
            continue
        pm = (1.0 / (1.0 + np.exp(-(features(samples[i].temps) @ w)))).reshape(GRID_H, GRID_W)
        if pm.max() < th:
            continue
        py, px = np.unravel_index(int(pm.argmax()), pm.shape)
        truth = (M @ np.array([ppl[0][0], ppl[0][1], 1.0]))
        errs.append(float(np.hypot(px - truth[0], py - truth[1])))
    median_err = float(np.median(errs)) if errs else -1.0

    model = {
        'version': 1, 'uid': uid, 'trainedAt': int(time.time() * 1000),
        'samples': len(samples), 'positives': int(sum(1 for i in people if people[i])),
        'features': FEATURES, 'weights': [float(v) for v in w],
        'threshold': round(float(th), 3), 'minArea': 2,
        'metrics': {
            'precision': round(prec, 3), 'recall': round(rec, 3), 'f1': round(f1, 3),
            'heldOut': int(len(yte) // (GRID_W * GRID_H)), 'medianErrorPx': round(median_err, 2),
        },
        'notes': f'RGB->thermal RMS {rms:.2f}px on {used} frames; '
                 f'ground truth from background subtraction on the rig camera',
    }
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, uid.replace(':', '') + '.json')
    with open(path, 'w') as fh:
        json.dump(model, fh, indent=1)
    print(f'\nwrote {path}')
    print(f'  held-out precision {prec:.2f} recall {rec:.2f} F1 {f1:.2f} at threshold {th:.2f}')
    print(f'  median placement error {median_err:.2f} thermal px')
    if f1 < 0.5:
        print('\n  That F1 is poor. More data usually helps, but check the RGB\n'
              '  background model first: a camera that was nudged invalidates it.')


if __name__ == '__main__':
    main()
