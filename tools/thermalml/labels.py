"""
Training labels for the thermal detector: the teacher's people, in thermal pixels.

    data/ml/.venv/bin/python -m tools.thermalml.labels --teacher data/ml/teachers/<name> \
        --mapping data/ml/mapping/2ccf670bc094-oct.json --day 2026-10-06 ... --out data/ml/labels/<name>

A teacher sees the photo, which covers about half of the thermal view. What
it cannot see is *unknown* -- never "nobody there" -- so each label file
carries the footprint of the photo in thermal pixels, and the loss ignores
everything outside it. Inside it, a person the teacher is unsure of (a box
under 0.5 confidence) or one cut off at the photo's edge is set aside as
*uncertain*: the loss neither rewards nor punishes the model there.

    <out>/<uid without colons>/<day>.json
        {"teacher": ..., "mapping": ..., "footprint": [768 x 0/1],
         "frames": {thermal id: {"pts": [[x, y, conf]], "ign": [[x, y]]}}}

Only thermal frames with a paired photo get a label; the rest are unlabelled.
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

from . import days
from .mapping import RGB_H, RGB_W, apply, centre
from .rgb import read_pairs_index
from .shards import sensor_dir

SURE = 0.5               # teacher confidence for a person to be a target, not set aside
EDGE_PX = 30             # a box centre this close to the photo's edge is a person cut off


def footprint(m: dict) -> np.ndarray:
    """(24, 32) bool: thermal pixels whose centre maps back inside the photo."""
    M = np.asarray(m['M'])
    A, t = M[:, :2], M[:, 2]
    inv = np.linalg.inv(A)
    out = np.zeros((24, 32), dtype=bool)
    for y in range(24):
        for x in range(32):
            px, py = inv @ (np.array([x + 0.5, y + 0.5]) - t)
            if m['flipX']:
                px = RGB_W - px
            out[y, x] = 0 <= px <= RGB_W and 0 <= py <= RGB_H
    return out


def frame_labels(boxes: list[list[float]], m: dict) -> dict:
    pts, ign = [], []
    for b in boxes:
        cx, cy = centre(b)
        tx, ty = apply(m, cx, cy)
        edge = min(cx, RGB_W - cx, cy, RGB_H - cy) < EDGE_PX
        if b[4] >= SURE and not edge:
            pts.append([round(tx, 3), round(ty, 3), round(b[4], 3)])
        else:
            ign.append([round(tx, 3), round(ty, 3)])
    return {'pts': pts, 'ign': ign}


def build(teacher_dir: str, mapping_path: str, rgb_root: str, uid: str, day_list: list[str], out: str) -> list[str]:
    m = json.load(open(mapping_path))
    fp = footprint(m)
    lines = []
    for day in day_list:
        days.assert_trainable([day])
        doc = json.load(open(os.path.join(teacher_dir, sensor_dir(uid), f'{day}.json')))
        boxes = doc['boxes']
        pairs = read_pairs_index(rgb_root, uid, day)
        frames = {tid: frame_labels(boxes[p['rgb']], m) for tid, p in pairs.items() if p['rgb'] in boxes}
        dest = os.path.join(out, sensor_dir(uid), f'{day}.json')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + '.tmp', 'w') as f:
            json.dump({'teacher': doc.get('model'), 'mapping': {k: m[k] for k in ('period', 'flipX', 'rms', 'framesUsed')},
                       'footprint': [int(v) for v in fp.ravel()], 'frames': frames}, f, separators=(',', ':'))
        os.replace(dest + '.tmp', dest)
        people = sum(len(v['pts']) for v in frames.values())
        unsure = sum(len(v['ign']) for v in frames.values())
        lines.append(f'{uid} {day}: {len(frames)} labelled frames, {people} people, {unsure} set aside as uncertain; '
                     f'footprint {int(fp.sum())} of 768 px')
    return lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.labels')
    p.add_argument('--teacher', required=True, help='a teacher output folder, e.g. data/ml/teachers/<name>')
    p.add_argument('--mapping', required=True)
    p.add_argument('--uid', default='2c:cf:67:0b:c0:94')
    p.add_argument('--day', action='append', required=True)
    p.add_argument('--rgb', default='data/ml/rgb')
    p.add_argument('--out', required=True)
    a = p.parse_args(argv)
    for line in build(a.teacher, a.mapping, a.rgb, a.uid, a.day, a.out):
        print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
