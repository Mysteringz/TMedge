"""
RGB pixels -> thermal pixels for the rig, fitted per period.

    data/ml/.venv/bin/python -m tools.thermalml.mapping --name sept --day 2026-09-26 --day 2026-09-29 \
        --background empty --exclude data/ml/handlabels/rgb-ids.txt

A detector finds people in the photo; the thermal model needs them in thermal
pixels. The fit is the one in tools/train_human_location.py -- RANSAC over
every (person in the photo, warm blob in the thermal frame) pair, assuming
no correspondence, because the true geometry is the only thing consistent
across hundreds of frames -- with two changes:

  * Both orientations are tried. A similarity transform cannot mirror, and
    the rig's thermal image was flipped relative to the camera on 6 Oct, so
    the photo's x is flipped first when that explains more frames.
  * People in the photo are only those two detectors agree on (yolo11s and
    yolo26s within 30 px), and warm blobs are found against a background, so
    a warm laptop and a chair do not pass for people on either side.

The hand-labelled frames are never used: the test must not have shaped the
geometry it is scored through. Thermal coordinates follow edgedetect.ts:
pixel i spans [i, i+1), so a blob's centroid is its mean index + 0.5.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

from . import days
from .rgb import read_pairs_index
from .shards import read_shard, sensor_dir
from .staticbg import DEFAULT, StaticBackground, median32

RGB_W, RGB_H = 640, 480
TOL = 2.5                     # thermal px, as in train_human_location.py
MAX_RMS = 3.0
AGREE_PX = 30.0


def thermal_blobs(resid: np.ndarray) -> list[tuple[float, float, int]]:
    """Warm connected regions of (frame - background), as (x, y, area) in thermal pixels."""
    import cv2
    hot = resid > max(1.0, 0.6 * float(resid.max()))
    n, _lab, stats, cent = cv2.connectedComponentsWithStats(hot.astype(np.uint8), connectivity=8)
    return [(float(cent[k][0]) + 0.5, float(cent[k][1]) + 0.5, int(stats[k, cv2.CC_STAT_AREA]))
            for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= 2]


def centre(b: list[float]) -> tuple[float, float]:
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def consensus(a: list[list[float]], b: list[list[float]]) -> list[tuple[float, float]]:
    """People both detectors found: each of a's centres with one of b's within AGREE_PX, averaged."""
    out, used = [], set()
    for box in a:
        ca = centre(box)
        best, bd = None, AGREE_PX
        for j, other in enumerate(b):
            if j in used:
                continue
            d = float(np.hypot(*(np.subtract(ca, centre(other)))))
            if d <= bd:
                best, bd = j, d
        if best is not None:
            used.add(best)
            cb = centre(b[best])
            out.append(((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2))
    return out


def apply(m: dict, x: float, y: float) -> tuple[float, float]:
    """Map one photo point into thermal pixels with a fitted mapping."""
    if m['flipX']:
        x = RGB_W - x
    M = np.asarray(m['M'])
    tx, ty = M @ np.array([x, y, 1.0])
    return float(tx), float(ty)


def _ransac(src_all: np.ndarray, dst_all: np.ndarray, frames: np.ndarray, seed: int = 7):
    import cv2
    rng = np.random.default_rng(seed)
    best_keep, best_M = None, None
    for _ in range(4000):
        i, j = rng.integers(0, len(src_all), 2)
        if frames[i] == frames[j]:
            continue
        src = np.array([src_all[i], src_all[j]], dtype=np.float32)
        dst = np.array([dst_all[i], dst_all[j]], dtype=np.float32)
        if np.linalg.norm(src[0] - src[1]) < 40 or np.linalg.norm(dst[0] - dst[1]) < 3:
            continue
        M = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)[0]
        if M is None or not (0.01 < float(np.hypot(M[0, 0], M[1, 0])) < 0.2):
            continue
        err = np.linalg.norm((M @ np.hstack([src_all, np.ones((len(src_all), 1))]).T).T - dst_all, axis=1)
        by_frame: dict[int, int] = {}
        for k in np.flatnonzero(err < TOL):
            f = int(frames[k])
            if f not in by_frame or err[k] < err[by_frame[f]]:
                by_frame[f] = int(k)
        keep = np.array(sorted(by_frame.values()), dtype=int)
        if best_keep is None or len(keep) > len(best_keep):
            best_keep, best_M = keep, M
    if best_keep is None or len(best_keep) < 20:
        return None
    M = cv2.estimateAffinePartial2D(src_all[best_keep].astype(np.float32), dst_all[best_keep].astype(np.float32),
                                    method=cv2.RANSAC, ransacReprojThreshold=TOL)[0]
    if M is None:
        M = best_M
    pred = (M @ np.hstack([src_all[best_keep], np.ones((len(best_keep), 1))]).T).T
    rms = float(np.sqrt((np.linalg.norm(pred - dst_all[best_keep], axis=1) ** 2).mean()))
    return M, best_keep, rms


def collect(shards_root: str, rgb_root: str, teachers_root: str, uid: str, day_list: list[str],
            background: str, exclude: set[str]) -> list[tuple[float, float, float, float, int]]:
    """Candidate (photo x, photo y, thermal x, thermal y, frame) pairs over the period."""
    empty_rel = None
    if background == 'empty':
        empty_rel = np.load(os.path.join('rigs', 'intern-demo', 'empty_bg_rel.npy')).astype(np.float64).ravel()
    sbg = StaticBackground(DEFAULT)
    cands, frame_no = [], 0
    for day in day_list:
        shard = read_shard(shards_root, uid, day)
        pairs = read_pairs_index(rgb_root, uid, day)
        sub = (['locked'] if days.is_locked(day) else []) + [sensor_dir(uid), f'{day}.json']
        a = json.load(open(os.path.join(teachers_root, 'yolo11s', *sub)))['boxes']
        b = json.load(open(os.path.join(teachers_root, 'yolo26s', *sub)))['boxes']
        temps = shard.temps().reshape(len(shard), -1)
        for i, tid in enumerate(shard.ids):
            t = temps[i]
            if empty_rel is not None:
                bg = median32(t) + empty_rel
            else:
                sbg.add(t, float(shard.at[i]))
                bgv = sbg.background_for(median32(t))
                bg = None if bgv is None else bgv.astype(np.float64)
            p = pairs.get(tid)
            if bg is None or not p or p['rgb'] in exclude or p['rgb'] not in a or p['rgb'] not in b:
                continue
            people = consensus(a[p['rgb']], b[p['rgb']])
            blobs = thermal_blobs((t.astype(np.float64) - bg).reshape(24, 32))
            if not people or not blobs or len(people) > 6 or len(blobs) > 6:
                continue
            frame_no += 1
            for (px, py) in people:
                for (tx, ty, _area) in blobs:
                    cands.append((px, py, tx, ty, frame_no))
    return cands


def fit(cands: list[tuple[float, float, float, float, int]]) -> dict:
    arr = np.array([c[:4] for c in cands], dtype=np.float64)
    frames = np.array([c[4] for c in cands])
    tried = {}
    for flip in (False, True):
        src = arr[:, :2].copy()
        if flip:
            src[:, 0] = RGB_W - src[:, 0]
        r = _ransac(src, arr[:, 2:], frames)
        tried[flip] = None if r is None else {'M': r[0].tolist(), 'frames': int(len(set(frames[r[1]]))), 'rms': r[2]}
    ok = {k: v for k, v in tried.items() if v}
    if not ok:
        raise RuntimeError('no transform explained the data in either orientation')
    flip = max(ok, key=lambda k: ok[k]['frames'])
    best = ok[flip]
    return {'flipX': flip, 'M': best['M'], 'rms': best['rms'], 'framesUsed': best['frames'],
            'candidates': len(cands), 'candidateFrames': int(len(set(frames))),
            'otherOrientation': tried[not flip]}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.mapping')
    p.add_argument('--name', required=True, help='period name, e.g. sept or oct')
    p.add_argument('--uid', default='2c:cf:67:0b:c0:94')
    p.add_argument('--day', action='append', required=True)
    p.add_argument('--background', choices=('empty', 'staticbg'), required=True)
    p.add_argument('--exclude', help='rgb ids never to fit on (the hand-labelled frames)')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--rgb', default='data/ml/rgb')
    p.add_argument('--teachers', default='data/ml/teachers')
    p.add_argument('--out', default='data/ml/mapping')
    a = p.parse_args(argv)
    exclude = set()
    if a.exclude:
        exclude = {line.strip() for line in open(a.exclude) if line.strip()}
    cands = collect(a.shards, a.rgb, a.teachers, a.uid, a.day, a.background, exclude)
    if len(cands) < 40:
        print(f'only {len(cands)} candidates; not enough to fit', file=sys.stderr)
        return 1
    m = fit(cands)
    m.update({'uid': a.uid, 'period': a.name, 'days': a.day, 'background': a.background,
              'excludedFrames': len(exclude), 'fittedOn': 'yolo11s+yolo26s consensus centres vs warm blobs'})
    status = 'ok' if m['rms'] <= MAX_RMS else 'REFUSED'
    os.makedirs(a.out, exist_ok=True)
    dest = os.path.join(a.out, f'{sensor_dir(a.uid)}-{a.name}.json')
    if status == 'ok':
        with open(dest, 'w') as f:
            json.dump(m, f, indent=1)
    print(json.dumps({k: m[k] for k in ('flipX', 'rms', 'framesUsed', 'candidateFrames', 'otherOrientation')}))
    print(f'{status}: {dest if status == "ok" else "RMS above " + str(MAX_RMS)}', file=sys.stderr)
    return 0 if status == 'ok' else 1


if __name__ == '__main__':
    raise SystemExit(main())
