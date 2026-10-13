"""
Today's detector and a trained model, scored on the same frames by the same rules.

    data/ml/.venv/bin/python -m tools.thermalml.evaluate --labels data/ml/labels/<teacher> \
        --day 2026-10-09 --day 2026-10-11 [--model data/ml/models/<name>/model.json] --out data/ml/reports/<name>.json

A new model only ships if it beats what the edge already does. Both are
scored here on exactly the same frames -- labelled, with a ready background,
away from day boundaries -- against the teacher's labels, with train.py's
rules: people matched within 2 thermal px, nothing counted where the photo
could not see or where the teacher was unsure. The edge detector's points
come from the real EdgeDetector (src/tools/replay.ts output); the model's
from the exported file, run with numpy exactly as the edge would.

Scores here are agreement with the teacher on the rig. The hand-labelled
test (handtest.py) is the only score against people.
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np

from .heatnet import decode, forward_np
from .metrics import Frame, bootstrap, by_true_count, match, score_frames
from .shards import sensor_dir
from .train import H, RADIUS, W, finite, load_day


def _keep(points, known: np.ndarray, ign: list) -> list[tuple[float, float]]:
    return [(x, y) for (x, y) in points if 0 <= int(y) < H and 0 <= int(x) < W and known[int(y), int(x)] >= 0.5
            and not any(math.hypot(x - q[0], y - q[1]) <= RADIUS for q in ign)]


def score(d: dict, predict) -> dict:
    frames = []
    for i in range(len(d['at'])):
        pred = _keep(predict(i), d['footprint'], d['ign'][i])
        truth = [(p[0], p[1]) for p in d['pts'][i]]
        tp, fp, fn, dist = match(truth, pred, RADIUS)
        frames.append(Frame(int(d['at'][i]), len(truth), len(pred), tp, fp, fn, dist))
    return {'all': score_frames(frames), 'byTrueCount': by_true_count(frames), 'ci95': bootstrap(frames)}


def edge_points(replay_root: str, uid: str, day: str, at: np.ndarray):
    rep = json.load(open(os.path.join(replay_root, sensor_dir(uid), f'{day}.edge.json')))
    index = {t: i for i, t in enumerate(rep['at'])}
    return lambda i: [(x[0], x[1]) for x in rep['dets'][index[int(at[i])]]]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.evaluate')
    p.add_argument('--labels', required=True)
    p.add_argument('--day', action='append', required=True)
    p.add_argument('--model')
    p.add_argument('--features', default='data/ml/features')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--replay', default='data/ml/replay')
    p.add_argument('--uid', default='2c:cf:67:0b:c0:94')
    p.add_argument('--out', required=True)
    a = p.parse_args(argv)
    model = json.load(open(a.model)) if a.model else None
    results: dict = {'days': {}, 'labels': os.path.basename(os.path.normpath(a.labels)), 'model': model.get('id') if model else None}
    for day in a.day:
        d = load_day(a.features, a.labels, a.shards, a.uid, day)
        row = {'frames': len(d['at']), 'edge': score(d, edge_points(a.replay, a.uid, day, d['at']))}
        if model:
            def ml(i: int) -> list[tuple[float, float]]:
                hm, off = forward_np(model, d['x'][i])
                return [(x, y) for (x, y, _c) in decode(hm, off, model['threshold'])]
            row['model'] = score(d, ml)
        results['days'][day] = row
        e = row['edge']['all']
        line = f'{day}: {row["frames"]} frames | edge F1 {e["f1"]:.3f} countMAE {e["countMAE"]:.3f}'
        if model:
            mm = row['model']['all']
            line += f' | model F1 {mm["f1"]:.3f} countMAE {mm["countMAE"]:.3f}'
        print(line)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(finite(results), f, indent=1, allow_nan=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
