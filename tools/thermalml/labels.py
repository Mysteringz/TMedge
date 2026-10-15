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
A photo darker than any the teacher was tested on (mean grey below 105, the
darkest of the 400 hand-labelled photos) gets no label either: at night the
detectors invent people in the dark, and nothing measured how often.

The teacher can be one detector's output folder, or several fused the way
the bake-off fused them (--teacher <root> --models a+b+c: weighted box fusion,
confidence summed over the members, kept from 0.25).

One mapping per period (September, October), fitted on all of it: neither
camera moved within a period (docs/THERMAL_ML.md), and fits on single days
are ambiguous because people sit in the same few seats -- they disagreed by
2-6 px where the cameras themselves had not moved at all.

Voted labels (job 2's second recipe, --vote-from): with every photo
labelled, the photos a few seconds either side of a frame vote on its
people. A person the teacher found in fewer than half of them is set aside
as uncertain (most likely a one-photo mistake), and a person it found in at
least half the photos before *and* half after, but missed in this one,
becomes a target. Votes never turn anyone into "nobody".
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import os

import numpy as np

from . import days
from .mapping import RGB_H, RGB_W, apply, centre
from .rgb import read_pairs_index
from .shards import sensor_dir

SURE = 0.5               # teacher confidence for a person to be a target, not set aside
EDGE_PX = 30             # a box centre this close to the photo's edge is a person cut off
MIN_BRIGHTNESS = 105.0   # mean grey of the darkest hand-labelled photo: the teacher's tested range
# The teacher misses people the photo's edge cuts through: on 7 Oct a person
# seated at the bottom edge was found by both thermal detectors and by no RGB
# detector, so a band this wide inside the photo's border is unknown, not empty.
FOOTPRINT_MARGIN_PX = 60
VOTE_WINDOW_S = 3.0      # photos this close in time vote on a frame's people (about 3 each side at 1 Hz)
VOTE_PX = 1.5            # the same seated person in two photos seconds apart, in thermal px


def footprint(m: dict, margin: float = FOOTPRINT_MARGIN_PX) -> np.ndarray:
    """(24, 32) bool: thermal pixels whose centre maps back inside the photo, at least `margin` px from its edge."""
    M = np.asarray(m['M'])
    A, t = M[:, :2], M[:, 2]
    inv = np.linalg.inv(A)
    out = np.zeros((24, 32), dtype=bool)
    for y in range(24):
        for x in range(32):
            px, py = inv @ (np.array([x + 0.5, y + 0.5]) - t)
            if m['flipX']:
                px = RGB_W - px
            out[y, x] = margin <= px <= RGB_W - margin and margin <= py <= RGB_H - margin
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


def teacher_boxes(teacher: str, uid: str, day: str, members: list[str] | None) -> tuple[dict, dict]:
    """(rgb id -> boxes, description) from one teacher folder, or fused from several."""
    if not members:
        doc = json.load(open(os.path.join(teacher, sensor_dir(uid), f'{day}.json')))
        return doc['boxes'], doc.get('model') or {}
    from .bakeoff import wbf
    per = [json.load(open(os.path.join(teacher, m, sensor_dir(uid), f'{day}.json')))['boxes'] for m in members]
    common = set.intersection(*(set(b) for b in per))
    return ({rid: wbf([b[rid] for b in per], len(per)) for rid in common},
            {'name': 'wbf:' + '+'.join(members), 'fusion': 'weighted box fusion, IoU 0.55, sum/n, kept from 0.25'})


def label_frames(rid_of: dict[str, str], boxes: dict[str, list], bright: dict[str, float], m: dict) -> tuple[dict, int]:
    """Labels for thermal frames whose paired photo the teacher read: {thermal id: {pts, ign}}, and how many were too dark."""
    frames, dark = {}, 0
    for tid, rid in rid_of.items():
        if rid not in boxes:
            continue
        if bright.get(rid, 0.0) < MIN_BRIGHTNESS:
            dark += 1
            continue
        frames[tid] = frame_labels(boxes[rid], m)
    return frames, dark


def vote(frames: dict[str, dict], at: dict[str, int], window_s: float = VOTE_WINDOW_S,
         radius: float = VOTE_PX) -> tuple[dict[str, dict], dict[str, int]]:
    """Each labelled frame's people put to a vote of the labelled frames within window_s.

    Returns the new labels and what changed: people kept, set aside, added,
    and those left as they were because fewer than two photos were near.
    """
    order = sorted((at[t], t) for t in frames if t in at)
    times = [a for a, _t in order]
    win = int(window_s * 1000)
    near = lambda p, pts: any(math.hypot(p[0] - q[0], p[1] - q[1]) <= radius for q in pts)
    seen = lambda p, f: near(p, f['pts']) or near(p, f['ign'])
    most = lambda p, side: 2 * sum(near(p, f['pts']) for f in side) >= len(side)
    out, n = {}, {'kept': 0, 'setAside': 0, 'added': 0, 'unvoted': 0}
    for k, (t0, tid) in enumerate(order):
        f = frames[tid]
        lo, hi = bisect.bisect_left(times, t0 - win), bisect.bisect_right(times, t0 + win)
        before = [frames[order[j][1]] for j in range(lo, k)]
        after = [frames[order[j][1]] for j in range(k + 1, hi)]
        around = before + after
        if len(around) < 2:
            out[tid] = f
            n['unvoted'] += len(f['pts'])
            continue
        pts, ign = [], [list(q) for q in f['ign']]
        for p in f['pts']:
            if 2 * sum(seen(p, g) for g in around) >= len(around):
                pts.append(list(p))
                n['kept'] += 1
            else:
                ign.append(list(p[:2]))
                n['setAside'] += 1
        if before and after:
            for q in (q for g in around for q in g['pts']):
                if seen(q, f) or near(q, pts) or near(q, ign) or not (most(q, before) and most(q, after)):
                    continue
                same = [r for g in around for r in g['pts'] if math.hypot(q[0] - r[0], q[1] - r[1]) <= radius]
                pts.append([round(sum(r[i] for r in same) / len(same), 3) for i in range(3)])
                n['added'] += 1
        out[tid] = {'pts': pts, 'ign': ign}
    return out, n


def vote_build(src: str, shards_root: str, uid: str, day_list: list[str], out: str,
               window_s: float = VOTE_WINDOW_S) -> list[str]:
    """Voted labels for each day, from the plain labels in src and the frames' times in the shards."""
    from .shards import read_shard
    lines = []
    for day in day_list:
        days.assert_trainable([day])
        doc = json.load(open(os.path.join(src, sensor_dir(uid), f'{day}.json')))
        sh = read_shard(shards_root, uid, day)
        frames, n = vote(doc['frames'], dict(zip(sh.ids, (int(v) for v in sh.at))), window_s)
        doc['frames'] = frames
        doc['teacher'] = {**doc.get('teacher', {}), 'vote': {'windowS': window_s, 'radiusPx': VOTE_PX, 'changes': n}}
        dest = os.path.join(out, sensor_dir(uid), f'{day}.json')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + '.tmp', 'w') as f:
            json.dump(doc, f, separators=(',', ':'))
        os.replace(dest + '.tmp', dest)
        voted = n['kept'] + n['setAside']
        lines.append(f'{uid} {day}: of {voted} people put to the vote, {n["setAside"]} set aside '
                     f'({n["setAside"] / voted:.1%})' if voted else f'{uid} {day}: nobody to vote on')
        lines[-1] += f'; {n["added"]} one-photo misses added; {n["unvoted"]} people with too few photos near to vote'
    return lines


def brightness(path: str) -> float:
    import cv2
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    return float(img.mean()) if img is not None else 0.0


def build(teacher_dir: str, mapping_path: str, rgb_root: str, uid: str, day_list: list[str], out: str,
          members: list[str] | None = None) -> list[str]:
    m = json.load(open(mapping_path))
    fp = footprint(m)
    lines = []
    for day in day_list:
        days.assert_trainable([day])
        boxes, model = teacher_boxes(teacher_dir, uid, day, members)
        pairs = read_pairs_index(rgb_root, uid, day)
        folder = os.path.join(rgb_root, sensor_dir(uid), day)
        rid_of = {tid: p['rgb'] for tid, p in pairs.items() if p['rgb'] in boxes}
        bright = {rid: brightness(os.path.join(folder, f'{rid}.jpg')) for rid in rid_of.values()}
        frames, dark = label_frames(rid_of, boxes, bright, m)
        dest = os.path.join(out, sensor_dir(uid), f'{day}.json')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + '.tmp', 'w') as f:
            json.dump({'teacher': model, 'minBrightness': MIN_BRIGHTNESS, 'mapping': {k: m[k] for k in ('period', 'flipX', 'rms', 'framesUsed')},
                       'footprint': [int(v) for v in fp.ravel()], 'frames': frames}, f, separators=(',', ':'))
        os.replace(dest + '.tmp', dest)
        people = sum(len(v['pts']) for v in frames.values())
        unsure = sum(len(v['ign']) for v in frames.values())
        lines.append(f'{uid} {day}: {len(frames)} labelled frames ({dark} photos too dark to label), {people} people, '
                     f'{unsure} set aside as uncertain; footprint {int(fp.sum())} of 768 px')
    return lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.labels')
    p.add_argument('--teacher', help='a teacher output folder, or with --models the root holding several')
    p.add_argument('--models', help='fuse these teachers under --teacher, e.g. yolo11s+yolo26s+fasterrcnn_v2')
    p.add_argument('--mapping')
    p.add_argument('--vote-from', help='instead of a teacher: plain labels to put to the vote of nearby photos')
    p.add_argument('--shards', default='data/ml/shards', help='with --vote-from: where the frames\' times are')
    p.add_argument('--uid', default='2c:cf:67:0b:c0:94')
    p.add_argument('--day', action='append', required=True)
    p.add_argument('--rgb', default='data/ml/rgb')
    p.add_argument('--out', required=True)
    a = p.parse_args(argv)
    if a.vote_from:
        lines = vote_build(a.vote_from, a.shards, a.uid, a.day, a.out)
    elif a.teacher and a.mapping:
        lines = build(a.teacher, a.mapping, a.rgb, a.uid, a.day, a.out, a.models.split('+') if a.models else None)
    else:
        p.error('give --teacher and --mapping, or --vote-from')
    for line in lines:
        print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
