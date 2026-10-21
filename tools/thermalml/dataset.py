"""
The detector's inputs for every recorded frame, computed once.

    python3 -m tools.thermalml.dataset --shards data/ml/shards --out data/ml/features

Each sensor's frames go through the edge background (staticbg port) and the
5-minute channel in time order, across days, the way the edge would have
seen them, and land as one file per day:

    <out>/[locked/]<uid without colons>/<day>.npz
        x       (N, 3, 24, 32) float16  c0/c1/c2, zeros where not ready
        xthin   (N, 24, 32)    float16  c2 again, from a history thinned to one
                                        frame per 8 s: training swaps it in so
                                        the model does not lean on 1 Hz detail
        ready   (N,)           bool     the background existed (else: not-ready)
        at      (N,)           int64    ms

The locked test days are computed against the rig's 19-Sept empty-room
reference instead of the edge background, as decided in docs/THERMAL_ML.md;
their files exist for scoring only and are never listed for training.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

from . import days
from .features import RecentMedian, features
from .shards import list_shards, read_shard, sensor_dir
from .staticbg import DEFAULT, StaticBackground, median32

THIN_MS = 8_000
EMPTY_ROOM = os.path.join('rigs', 'intern-demo', 'empty_bg_rel.npy')


def build(shards_root: str, out_root: str, only: set[str] | None = None) -> list[str]:
    refs = list_shards(shards_root, include_locked=True)
    sensors = sorted({uid for uid, _ in refs})
    empty_rel = np.load(EMPTY_ROOM).astype(np.float32).ravel()
    lines = []
    for uid in sensors:
        if only and uid not in only:
            continue
        bg, recent, thin = StaticBackground(DEFAULT), RecentMedian(), RecentMedian()
        last_thin = -np.inf
        for _uid, day in [r for r in refs if r[0] == uid]:
            s = read_shard(shards_root, uid, day)
            temps = s.temps().reshape(len(s), -1)
            n = len(s)
            x = np.zeros((n, 3, 24, 32), dtype=np.float16)
            xthin = np.zeros((n, 24, 32), dtype=np.float16)
            ready = np.zeros(n, dtype=bool)
            for i in range(n):
                t, at = temps[i], float(s.at[i])
                recent.add(t, at)
                if at - last_thin >= THIN_MS:
                    thin.add(t, at)
                    last_thin = at
                if days.is_locked(day):
                    b = (median32(t) + empty_rel.astype(np.float64)).astype(np.float32)
                else:
                    bg.add(t, at)
                    b = bg.background_for(median32(t))
                f = features(t, b, recent.recent())
                if f is None:
                    continue
                ready[i] = True
                x[i] = f.reshape(3, 24, 32)
                ft = features(t, b, thin.recent())
                xthin[i] = ft[2].reshape(24, 32)
            dest = os.path.join(out_root, *(['locked'] if days.is_locked(day) else []), sensor_dir(uid), f'{day}.npz')
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            np.savez(dest + '.tmp.npz', x=x, xthin=xthin, ready=ready, at=s.at)
            os.replace(dest + '.tmp.npz', dest)
            lines.append(f'{uid} {day}{" LOCKED" if days.is_locked(day) else ""}: {n} frames, {int(ready.sum())} ready')
    return lines


def load(out_root: str, uid: str, day: str) -> dict[str, np.ndarray]:
    path = os.path.join(out_root, *(['locked'] if days.is_locked(day) else []), sensor_dir(uid), f'{day}.npz')
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml.dataset')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--out', default='data/ml/features')
    p.add_argument('--sensor', action='append')
    a = p.parse_args(argv)
    t0 = time.time()
    for line in build(a.shards, a.out, set(a.sensor) if a.sensor else None):
        print(line)
    print(f'{time.time() - t0:.0f} s', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
