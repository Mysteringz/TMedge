"""
What the thermal detector sees: three channels per 24x32 frame.

    c0  frame - its own median            where it is warm at all
    c1  frame - the edge background       what is not part of the room (staticbg)
    c2  frame - the last 5 minutes        what changed recently: an arrival is
                                          positive, a chair cooling after
                                          someone left is negative

All in C, clipped, divided by 4. c2 is a median over 30-second slices *by
time*, so it means the same at 1 frame a second, at the legacy recordings'
one every few seconds, or at 4 a second; until three slices exist it is 0.
Without a background there is no c1 and no detection: the node reports
not-ready, never empty.

src/algo/heatfeatures.ts computes the same thing on the edge, and
test/thermalml.test.ts fails if the two disagree.
"""
from __future__ import annotations

import math

import numpy as np

from .staticbg import _column_median, median32

GRID = 768
SLICE_MS = 30_000
WINDOW_SLICES = 10           # 5 minutes
MIN_SLICES = 3
MAX_PER_SLICE = 120          # 4 frames a second for 30 s; more is not more information
CLIP = {'c0': (-4.0, 12.0), 'c1': (-4.0, 12.0), 'c2': (-6.0, 6.0)}
SCALE = 4.0


class RecentMedian:
    """Per-pixel median of (frame - frame median) over the last 5 minutes, from closed 30 s slices."""

    def __init__(self) -> None:
        self._start: float | None = None
        self._rows: list[np.ndarray] = []
        self.slices: list[tuple[float, np.ndarray]] = []

    def add(self, temps: np.ndarray, at: float) -> None:
        t = np.asarray(temps, dtype=np.float32).ravel()
        if not math.isfinite(at) or t.size != GRID or not np.isfinite(t).all():
            return
        start = math.floor(at / SLICE_MS) * SLICE_MS
        if self._start is not None and self._start != start:
            if self._rows:
                self.slices.append((self._start, _column_median(np.stack(self._rows))))
            self._start, self._rows = None, []
        self.slices = [s for s in self.slices if s[0] >= at - WINDOW_SLICES * SLICE_MS]
        if self._start is None:
            self._start = start
        if len(self._rows) < MAX_PER_SLICE:
            level = median32(t)
            self._rows.append((t.astype(np.float64) - level).astype(np.float32))

    def recent(self) -> np.ndarray | None:
        if len(self.slices) < MIN_SLICES:
            return None
        return _column_median(np.stack([s[1] for s in self.slices]))


def _channel(v: np.ndarray, name: str) -> np.ndarray:
    lo, hi = CLIP[name]
    return (np.clip(v, lo, hi) / SCALE).astype(np.float32)


def features(temps: np.ndarray, background: np.ndarray | None, recent: np.ndarray | None) -> np.ndarray | None:
    """(3, 768) float32 for one frame, or None when there is no background (not-ready)."""
    if background is None:
        return None
    t = np.asarray(temps, dtype=np.float32).ravel().astype(np.float64)
    level = median32(t.astype(np.float32))
    c0 = _channel(t - level, 'c0')
    c1 = _channel(t - np.asarray(background, dtype=np.float32).astype(np.float64), 'c1')
    if recent is None:
        c2 = np.zeros(GRID, dtype=np.float32)
    else:
        c2 = _channel((t - level) - np.asarray(recent, dtype=np.float32).astype(np.float64), 'c2')
    return np.stack([c0, c1, c2])


def _crosscheck() -> None:
    """argv[1]: {frames:[{at, tMin, step, pixels}], bgRel:[768], probe:[i]} -> [{i, f}] (features or null)."""
    import base64
    import json
    import sys

    with open(sys.argv[1]) as f:
        doc = json.load(f)
    rel = np.asarray(doc['bgRel'], dtype=np.float32)
    rm, probe, out = RecentMedian(), set(doc['probe']), []
    for i, fr in enumerate(doc['frames']):
        px = np.frombuffer(base64.b64decode(fr['pixels']), dtype=np.uint8).astype(np.float64)
        temps = (fr['tMin'] + px * fr['step']).astype(np.float32)
        rm.add(temps, fr['at'])
        if i in probe:
            bg = (median32(temps) + rel.astype(np.float64)).astype(np.float32)
            f = features(temps, bg, rm.recent())
            out.append({'i': i, 'recent': rm.recent() is not None, 'f': None if f is None else [float(v) for v in f.ravel()]})
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    _crosscheck()
