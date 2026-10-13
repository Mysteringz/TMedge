"""
The hand-labelled test: the only place a thermal model meets the 400 locked frames.

    python3 -m tools.thermalml.handtest data/ml/models/<name>/model.json --why "M3 first model"

Run it at milestones, not every night: a test consulted to choose between
models stops being a test. Every run is appended to a ledger
(data/ml/reports/handtest-ledger.jsonl) with the model, the date and the
reason, so how often it was looked at is on record next to what it said.

Scoring is the bake-off's (docs/THERMAL_ML.md): people as points matched
within 2 thermal px. A person is only scored where the photo -- and so the
hand labeller -- could see: a detection outside the photo's footprint is
neither right nor wrong. Test-day inputs use the rig's 19-Sept empty-room
background, as decided.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timedelta, timezone

import numpy as np

from .bakeoff import DAYS, UID, hand_labels, inside_photo
from .dataset import load as load_features
from .heatnet import decode, forward_np
from .mapping import apply
from .metrics import Frame, bootstrap, by_true_count, match, score_frames
from .shards import read_shard

RADIUS = 2.0
LEDGER = os.path.join('data', 'ml', 'reports', 'handtest-ledger.jsonl')


def run(model_path: str, why: str, mapping_path: str = 'data/ml/mapping/2ccf670bc094-sept.json',
        labels_root: str = 'data/ml/handlabels/v1', features_root: str = 'data/ml/features',
        shards_root: str = 'data/ml/shards') -> dict:
    model = json.load(open(model_path))
    m = json.load(open(mapping_path))
    labels = hand_labels(labels_root)
    frames = []
    for day in DAYS:
        f = load_features(features_root, UID, day)
        ids = read_shard(shards_root, UID, day).ids
        for i, tid in enumerate(ids):
            name = tid[:16]
            if name not in labels:
                continue
            truth = [apply(m, x, y) for (x, y) in labels[name]]
            hm, off = forward_np(model, f['x'][i].astype(np.float32))
            pred = [(x, y) for (x, y, _c) in decode(hm, off, model['threshold']) if inside_photo(m, x, y)]
            tp, fp, fn, dists = match(truth, pred, RADIUS)
            frames.append(Frame(int(f['at'][i]), len(truth), len(pred), tp, fp, fn, dists))
    if len(frames) != len(labels):
        raise SystemExit(f'only {len(frames)} of {len(labels)} hand-labelled frames were found')
    result = {'all': score_frames(frames), 'byTrueCount': by_true_count(frames), 'ci95': bootstrap(frames)}
    entry = {'at': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'), 'model': model.get('id'),
             'modelFile': model_path, 'why': why, 'frames': len(frames), 'background': '19-Sept empty room',
             'f1': result['all']['f1'], 'f1ci95': result['ci95']['f1'], 'countMAE': result['all']['countMAE']}
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    return {'ledger': entry, 'result': result}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml.handtest')
    p.add_argument('model')
    p.add_argument('--why', required=True, help='why the locked test is being used now (goes in the ledger)')
    a = p.parse_args(argv)
    previous = [json.loads(line) for line in open(LEDGER)] if os.path.exists(LEDGER) else []
    out = run(a.model, a.why)
    s, ci = out['result']['all'], out['result']['ci95']
    fmt = lambda v: '-' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:.3f}'
    print(f'hand test ({s["frames"]} frames): F1 {fmt(s["f1"])} [{fmt(ci["f1"][0])}, {fmt(ci["f1"][1])}], '
          f'P {fmt(s["precision"])}, R {fmt(s["recall"])}, count MAE {fmt(s["countMAE"])}, exact {fmt(s["exactCount"])}')
    for k, v in out['result']['byTrueCount'].items():
        print(f'  true count {k}: {v["frames"]} frames, F1 {fmt(v["f1"])}, false people per frame {fmt(v["falsePerFrame"])}')
    print(f'ledger: this is use number {len(previous) + 1} of the locked test')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
