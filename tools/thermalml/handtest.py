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
neither right nor wrong.

The inputs are the ones a deployed sensor would compute (background='live',
decided 2026-10-15): the edge's own background, learned as the test days'
frames arrive. Frames before it is ready -- about the first hour of each
recording, 54% of the hand-labelled ones -- are not scored, because a real
sensor reports not-ready there. Until 2026-10-15 the test days used the
rig's 19-Sept empty-room reference instead, so that all 400 frames counted
(background='fixed', kept for the record). On the test days' other frames it
turned most of a learned model's detections into false people: the room was
not as it had been on 19 Sept (docs/THERMAL_ML.md).
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
from .features import RecentMedian, features
from .heatnet import decode, forward_np
from .mapping import apply
from .metrics import Frame, bootstrap, by_true_count, confusion, match, score_frames
from .shards import read_shard
from .staticbg import DEFAULT, StaticBackground, median32

RADIUS = 2.0
LEDGER = os.path.join('data', 'ml', 'reports', 'handtest-ledger.jsonl')


BACKGROUNDS = {'live': 'the edge background, learned as the frames arrive (as deployed)', 'fixed': '19-Sept empty room'}


def live_inputs(shards_root: str) -> dict[tuple[str, int], np.ndarray]:
    """(day, frame index) -> the inputs a deployed sensor computes; frames before its background is ready are absent."""
    bg, recent, out = StaticBackground(DEFAULT), RecentMedian(), {}
    for day in DAYS:
        s = read_shard(shards_root, UID, day)
        t = s.temps().reshape(len(s), -1)
        for i in range(len(s)):
            at = float(s.at[i])
            recent.add(t[i], at)
            bg.add(t[i], at)
            f = features(t[i], bg.background_for(median32(t[i])), recent.recent())
            if f is not None:
                out[(day, i)] = f.reshape(3, 24, 32)
    return out


def run(model_path: str, why: str, mapping_path: str = 'data/ml/mapping/2ccf670bc094-sept.json',
        labels_root: str = 'data/ml/handlabels/v1', features_root: str = 'data/ml/features',
        shards_root: str = 'data/ml/shards', frames_out: list | None = None, background: str = 'live',
        inputs: dict | None = None) -> dict:
    """Score one model on the locked frames and append the use to the ledger.

    frames_out, if given, receives the per-frame scores; inputs, if given, are
    live_inputs() already computed (they are the same for every model).
    """
    if background not in BACKGROUNDS:
        raise ValueError(f'background is one of {sorted(BACKGROUNDS)}')
    model = json.load(open(model_path))
    m = json.load(open(mapping_path))
    labels = hand_labels(labels_root)
    live = (inputs if inputs is not None else live_inputs(shards_root)) if background == 'live' else None
    frames, seen = [], 0
    for day in DAYS:
        f = load_features(features_root, UID, day) if background == 'fixed' else None
        shard = read_shard(shards_root, UID, day)
        ids = shard.ids
        for i, tid in enumerate(ids):
            name = tid[:16]
            if name not in labels:
                continue
            seen += 1
            if live is not None and (day, i) not in live:
                continue                          # not ready: a deployed sensor reports nothing here
            inputs_i = live[(day, i)] if live is not None else f['x'][i].astype(np.float32)
            truth = [apply(m, x, y) for (x, y) in labels[name]]
            hm, off = forward_np(model, inputs_i)
            pred = [(x, y) for (x, y, _c) in decode(hm, off, model['threshold']) if inside_photo(m, x, y)]
            tp, fp, fn, dists = match(truth, pred, RADIUS)
            frames.append(Frame(int(shard.at[i]), len(truth), len(pred), tp, fp, fn, dists))
    if seen != len(labels):
        raise SystemExit(f'only {seen} of {len(labels)} hand-labelled frames were found')
    if frames_out is not None:
        frames_out.extend(frames)
    result = {'all': score_frames(frames), 'byTrueCount': by_true_count(frames), 'confusion': confusion(frames), 'ci95': bootstrap(frames)}
    entry = {'at': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'), 'model': model.get('id'),
             'modelFile': model_path, 'why': why, 'frames': len(frames), 'notReady': seen - len(frames),
             'background': BACKGROUNDS[background],
             'f1': result['all']['f1'], 'f1ci95': result['ci95']['f1'], 'countMAE': result['all']['countMAE']}
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    return {'ledger': entry, 'result': result}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml.handtest')
    p.add_argument('model')
    p.add_argument('--why', required=True, help='why the locked test is being used now (goes in the ledger)')
    p.add_argument('--background', default='live', choices=sorted(BACKGROUNDS), help='live decides; fixed is the pre-2026-10-15 rule')
    a = p.parse_args(argv)
    previous = [json.loads(line) for line in open(LEDGER)] if os.path.exists(LEDGER) else []
    out = run(a.model, a.why, background=a.background)
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
