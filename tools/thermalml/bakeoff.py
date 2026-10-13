"""
The one-time teacher bake-off, scored on the 400 hand-labelled frames.

    data/ml/.venv/bin/python -m tools.thermalml.bakeoff

Rules, fixed before anything was scored, are in docs/THERMAL_ML.md. Every
candidate -- the RGB detectors, their fused ensemble, and today's thermal
detectors as baselines -- is reduced to points in thermal pixels and matched
against the hand labels with metrics.match (2.0 px). Writes
data/ml/reports/bakeoff.json and prints the table; nothing here is typed by
hand into a report.

Thermal detectors see the whole 32x24 view while the photo covers about half
of it, and nobody labelled what the photo cannot show. So for them, a person
is only scored where the mapping puts it inside the photo; a warm blob
outside it is neither right nor wrong.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
from datetime import datetime, timedelta, timezone

import numpy as np

from .mapping import RGB_H, RGB_W, apply, centre
from .metrics import Frame, bootstrap, by_true_count, match, score_frames
from .rgb import read_pairs_index
from .shards import read_shard, sensor_dir

RADIUS = 2.0
UID = '2c:cf:67:0b:c0:94'
DAYS = ('2026-09-26', '2026-09-29')
RGB_MODELS = ('yolo11s', 'yolo26s', 'fasterrcnn_v2')
WBF_IOU = 0.55
MIN_CONF = 0.25


def hand_labels(root: str) -> dict[str, list[tuple[float, float]]]:
    """16-hex name -> person centres in photo pixels, from the Roboflow YOLO export."""
    out = {}
    for img in glob.glob(os.path.join(root, '*', 'images', '*.jpg')):
        name = os.path.basename(img).split('_jpg')[0]
        lab = img.replace(f'{os.sep}images{os.sep}', f'{os.sep}labels{os.sep}').rsplit('.', 1)[0] + '.txt'
        pts = []
        for line in open(lab):
            parts = line.split()
            if len(parts) == 5:
                pts.append((float(parts[1]) * RGB_W, float(parts[2]) * RGB_H))
        out[name] = pts
    return out


def iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def wbf(per_model: list[list[list[float]]], n_models: int) -> list[list[float]]:
    """Weighted box fusion: clusters by IoU >= 0.55, confidence-weighted box, summed confidence / n_models."""
    boxes = sorted((b for m in per_model for b in m), key=lambda b: -b[4])
    clusters: list[list[list[float]]] = []
    fused: list[list[float]] = []
    for b in boxes:
        for k, f in enumerate(fused):
            if iou(f, b) >= WBF_IOU:
                clusters[k].append(b)
                w = np.array([c[4] for c in clusters[k]])
                xy = np.array([c[:4] for c in clusters[k]])
                fused[k] = [*(w @ xy / w.sum()).tolist(), float(w.mean())]
                break
        else:
            clusters.append([b])
            fused.append(list(b))
    out = []
    for f, c in zip(fused, clusters):
        conf = sum(x[4] for x in c) / n_models
        if conf >= MIN_CONF:
            out.append(f[:4] + [conf])
    return out


def inside_photo(m: dict, tx: float, ty: float) -> bool:
    """Whether a thermal point maps back inside the photo."""
    M = np.asarray(m['M'])
    A, t = M[:, :2], M[:, 2]
    x, y = np.linalg.solve(A, np.array([tx, ty]) - t)
    if m['flipX']:
        x = RGB_W - x
    return 0 <= x <= RGB_W and 0 <= y <= RGB_H


def summarise(frames: list[Frame]) -> dict:
    return {'all': score_frames(frames), 'byTrueCount': by_true_count(frames), 'ci95': bootstrap(frames)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.bakeoff')
    p.add_argument('--labels', default='data/ml/handlabels/v1')
    p.add_argument('--mapping', default='data/ml/mapping/2ccf670bc094-sept.json')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--rgb', default='data/ml/rgb')
    p.add_argument('--teachers', default='data/ml/teachers')
    p.add_argument('--replay', default='data/ml/replay', help='edge detector, production background')
    p.add_argument('--replay-empty', default='data/ml/replay-emptybg', help='edge detector, 19-Sept empty room')
    p.add_argument('--stored', default='data/ml/export-20261012/dataset.sql', help='for rf-overhead outputs')
    p.add_argument('--out', default='data/ml/reports/bakeoff.json')
    a = p.parse_args(argv)

    m = json.load(open(a.mapping))
    labels = hand_labels(a.labels)
    to_t = lambda pts: [apply(m, x, y) for (x, y) in pts]

    # Which thermal frame and photo each hand-labelled name is.
    rows = []      # (name, day, index in shard, thermal id, rgb id, at)
    shards = {d: read_shard(a.shards, UID, d) for d in DAYS}
    for d in DAYS:
        pairs = read_pairs_index(a.rgb, UID, d)
        for i, tid in enumerate(shards[d].ids):
            if tid[:16] in labels and tid in pairs:
                rows.append((tid[:16], d, i, tid, pairs[tid]['rgb'], int(shards[d].at[i])))
    if len(rows) != len(labels):
        raise SystemExit(f'only {len(rows)} of {len(labels)} hand-labelled frames found a thermal frame and photo')

    def rgb_boxes(model: str, d: str) -> dict:
        return json.load(open(os.path.join(a.teachers, model, 'locked', sensor_dir(UID), f'{d}.json')))['boxes']

    boxes = {mdl: {d: rgb_boxes(mdl, d) for d in DAYS} for mdl in RGB_MODELS}
    results: dict[str, dict] = {}

    def score(name: str, predict) -> None:
        frames = []
        for (n, d, i, tid, rid, at) in rows:
            pred = predict(n, d, i, tid, rid)
            if pred is None:
                continue
            truth = to_t(labels[n])
            tp, fp, fn, dists = match(truth, pred, RADIUS)
            frames.append(Frame(at, len(truth), len(pred), tp, fp, fn, dists))
        results[name] = summarise(frames)

    for mdl in RGB_MODELS:
        score(mdl, lambda n, d, i, tid, rid, mdl=mdl: to_t([centre(b) for b in boxes[mdl][d][rid]]))
    score('ensemble_wbf', lambda n, d, i, tid, rid: to_t([centre(b) for b in wbf([boxes[x][d][rid] for x in RGB_MODELS], 3)]))

    # rf-overhead: stored outputs only, on the frames it happens to have.
    stored = {}
    with open(a.stored, 'rb') as f:
        from .copydump import iter_copy, unescape
        for r in iter_copy(f, 'training.annotations'):
            if r['label_source'] == b'rf-overhead-person-szky0':
                lab = json.loads(unescape(r['labels']) or '{}')
                stored[unescape(r['frame_id'])] = [d['bbox_xyxy'] for d in lab.get('detections', [])]
    score('rf_overhead_stored', lambda n, d, i, tid, rid: to_t([centre(b) for b in stored[rid]]) if rid in stored else None)

    # Today's thermal detectors, scored only inside the photo's footprint.
    def thermal(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x, y) for (x, y) in points if inside_photo(m, x, y)]

    def in_view_truth_ok() -> None:
        pass

    obs = {d: shards[d].observed for d in DAYS}
    score('firmware_observed', lambda n, d, i, tid, rid: thermal([(o['x'], o['y']) for o in (obs[d][i] or [])]) if obs[d][i] is not None else None)
    for key, root in (('edge_empty_room_bg', a.replay_empty), ('edge_production_bg', a.replay)):
        path = lambda d: os.path.join(root, 'locked', sensor_dir(UID), f'{d}.edge.json')
        if not all(os.path.exists(path(d)) for d in DAYS):
            continue
        rep = {d: json.load(open(path(d))) for d in DAYS}
        score(key, lambda n, d, i, tid, rid, rep=rep: thermal([(x[0], x[1]) for x in rep[d]['dets'][i]]) if rep[d]['ready'][i] else None)

    report = {
        'generated': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'),
        'rule': 'docs/THERMAL_ML.md#scoring-the-hand-labelled-test',
        'radiusPx': RADIUS, 'labelledFrames': len(rows),
        'labelledPeople': sum(len(labels[r[0]]) for r in rows),
        'mapping': {k: m[k] for k in ('period', 'flipX', 'rms', 'framesUsed', 'excludedFrames')},
        'candidates': results,
        'note': 'Teacher candidates: yolo11s, yolo26s, fasterrcnn_v2, ensemble_wbf. Others are baselines or partial.',
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(report, f, indent=1, default=lambda v: None if isinstance(v, float) and math.isnan(v) else v)

    fmt = lambda v: '  -  ' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:.3f}'
    print(f'{"candidate":22} {"frames":>6} {"P":>6} {"R":>6} {"F1":>6} {"F1 95% CI":>15} {"cntMAE":>7} {"exact":>6}  '
          f'false people per empty frame | F1 with 1/2/3+ people')
    for k, r in results.items():
        s, ci, bc = r['all'], r['ci95']['f1'], r['byTrueCount']
        slices = (fmt(bc['0']['falsePerFrame']) if '0' in bc else '  -  ') + ' | ' + \
            ' / '.join(fmt(bc[g]['f1']) if g in bc else '  -  ' for g in ('1', '2', '3+'))
        print(f'{k:22} {s["frames"]:>6} {fmt(s["precision"]):>6} {fmt(s["recall"]):>6} {fmt(s["f1"]):>6} '
              f'{"[" + fmt(ci[0]) + ", " + fmt(ci[1]) + "]":>15} {fmt(s["countMAE"]):>7} {fmt(s["exactCount"]):>6}  {slices}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
