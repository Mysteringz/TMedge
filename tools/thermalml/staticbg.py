"""
The edge's day-long background (src/edge/staticbg.ts), ported line for line.

The detector will be trained on "frame minus background" and run on the edge
against the background staticbg.ts keeps there. If the two computed different
backgrounds from the same frames, the model would see one thing in training
and another in production, and nothing would say so -- so this port follows
the TypeScript step by step, including where values are rounded to float32,
and test/thermalml.test.ts checks the two against each other.

Only the in-memory part is ported: training replays frames in order, so
there is no file to load and no stale state to recompute.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

GRID = 768


@dataclass(frozen=True)
class Options:
    bucket_ms: int = 15 * 60_000
    window_ms: int = 24 * 3600_000
    sample_ms: int = 10_000
    quantile: float = 0.2
    min_buckets: int = 4
    min_samples_per_bucket: int = 30


DEFAULT = Options()


def median32(values: np.ndarray) -> float:
    """staticbg.ts median(): sort as float32, average the middle two as doubles."""
    a = np.sort(np.asarray(values, dtype=np.float32).ravel())
    n = a.size
    if n == 0:
        return 0.0
    mid = n >> 1
    return float(a[mid]) if n % 2 else (float(a[mid - 1]) + float(a[mid])) / 2


def _column_median(samples: np.ndarray) -> np.ndarray:
    """Per-pixel median of (n, 768) float32 samples, rounded to float32 like rel[i] = median(column)."""
    a = np.sort(samples, axis=0)
    n = a.shape[0]
    mid = n >> 1
    if n % 2:
        return a[mid].astype(np.float32)
    return ((a[mid - 1].astype(np.float64) + a[mid].astype(np.float64)) / 2).astype(np.float32)


def _column_quantile(rels: np.ndarray, q: float) -> np.ndarray:
    """quantileSorted() per pixel over (k, 768) float32 bucket medians."""
    a = np.sort(rels, axis=0).astype(np.float64)
    k = a.shape[0]
    pos = q * (k - 1)
    lo = math.floor(pos)
    hi = min(k - 1, lo + 1)
    return (a[lo] + (a[hi] - a[lo]) * (pos - lo)).astype(np.float32)


@dataclass
class _Bucket:
    start: float
    samples: int
    rel: np.ndarray


class StaticBackground:
    def __init__(self, opts: Options = DEFAULT):
        if not 0 < opts.quantile < 1:
            raise ValueError('quantile must be between 0 and 1')
        self.opts = opts
        self.max_samples = math.ceil(opts.bucket_ms / opts.sample_ms) + 1
        self.buckets: list[_Bucket] = []
        self._cur_start: float | None = None
        self._cur: np.ndarray | None = None
        self._cur_n = 0
        self._last_sample_at = -math.inf
        self.rel: np.ndarray | None = None

    @property
    def ready(self) -> bool:
        return self.rel is not None

    def add(self, temps: np.ndarray, at: float) -> None:
        """Feed one frame (C, float32, 768 values) seen at `at` ms."""
        t = np.asarray(temps, dtype=np.float32).ravel()
        if not math.isfinite(at) or t.size != GRID or not np.isfinite(t).all():
            return
        if self.buckets and self.buckets[0].start < at - self.opts.window_ms:
            self._recompute(at)
        start = math.floor(at / self.opts.bucket_ms) * self.opts.bucket_ms
        if self._cur_start is not None and self._cur_start != start:
            self._close(at)
        if at - self._last_sample_at < self.opts.sample_ms:
            return
        if self._cur_start is None:
            self._cur_start = start
            self._cur = np.zeros((self.max_samples, GRID), dtype=np.float32)
            self._cur_n = 0
        if self._cur_n >= self.max_samples:
            return
        self._last_sample_at = at
        level = median32(t)
        assert self._cur is not None
        self._cur[self._cur_n] = (t.astype(np.float64) - level).astype(np.float32)
        self._cur_n += 1

    def background_for(self, level: float) -> np.ndarray | None:
        """Absolute background (C, float32, 768) for a frame whose median is `level`, or None while not ready."""
        if self.rel is None:
            return None
        return (level + self.rel.astype(np.float64)).astype(np.float32)

    def _voting(self, now: float) -> list[_Bucket]:
        return [b for b in self.buckets if now - self.opts.window_ms <= b.start <= now]

    def _close(self, now: float) -> None:
        n, samples = self._cur_n, self._cur
        start = self._cur_start
        self._cur_start, self._cur, self._cur_n = None, None, 0
        if samples is None or start is None or n < self.opts.min_samples_per_bucket:
            return
        self.buckets.append(_Bucket(start=start, samples=n, rel=_column_median(samples[:n])))
        self._recompute(now)

    def _recompute(self, now: float) -> None:
        keep = self._voting(now)
        self.buckets = keep
        if len(keep) < self.opts.min_buckets:
            self.rel = None
            return
        self.rel = _column_quantile(np.stack([b.rel for b in keep]), self.opts.quantile)


def _crosscheck() -> None:
    """stdin: {opts, frames:[{at, tMin, step, pixels(base64)}], probe:[i]}; stdout: [{i, ready, bg}]."""
    import base64
    import json
    import sys

    doc = json.load(sys.stdin)
    o = doc['opts']
    bg = StaticBackground(Options(bucket_ms=o['bucketMs'], window_ms=o['windowMs'], sample_ms=o['sampleMs'],
                                  quantile=o['quantile'], min_buckets=o['minBuckets'],
                                  min_samples_per_bucket=o['minSamplesPerBucket']))
    probe = set(doc['probe'])
    out = []
    for i, f in enumerate(doc['frames']):
        px = np.frombuffer(base64.b64decode(f['pixels']), dtype=np.uint8).astype(np.float64)
        temps = (f['tMin'] + px * f['step']).astype(np.float32)
        bg.add(temps, f['at'])
        if i in probe:
            b = bg.background_for(median32(temps))
            out.append({'i': i, 'ready': b is not None, 'bg': None if b is None else [float(v) for v in b]})
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    _crosscheck()
