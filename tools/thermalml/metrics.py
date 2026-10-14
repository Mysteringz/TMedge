"""
How a detector is scored: people as points, matched one to one.

Every score the team sees -- the teacher bake-off, the nightly gate, the
report -- comes from these functions, so they are kept small and numpy-only.

  * A person is a point. Detections and labels are matched per frame by a
    minimum-cost assignment (Hungarian); a pair counts only within `radius`
    pixels, and the assignment first maximises how many pairs count, then
    minimises their distance.
  * F1 is summed over frames (micro), not averaged per frame: a frame with
    three people weighs three times as much as a frame with one.
  * Count error is per frame, |predicted - true|.
  * Intervals come from a bootstrap over blocks of time, not single frames:
    frames seconds apart are nearly the same picture, and treating them as
    independent would make every interval look far too narrow.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

_BIG = 1e6


def assign(cost: np.ndarray) -> list[tuple[int, int]]:
    """Minimum-cost assignment for an (n, m) cost matrix; returns (row, col) pairs, min(n, m) of them."""
    cost = np.asarray(cost, dtype=np.float64)
    n, m = cost.shape
    if n == 0 or m == 0:
        return []
    if n > m:
        return [(i, j) for j, i in assign(cost.T)]
    INF = math.inf
    u, v = [0.0] * (n + 1), [0.0] * (m + 1)
    p, way = [0] * (m + 1), [0] * (m + 1)
    for i in range(1, n + 1):
        p[0], j0 = i, 0
        minv, used = [INF] * (m + 1), [False] * (m + 1)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], INF, 0
            for j in range(1, m + 1):
                if not used[j]:
                    cur = cost[i0 - 1, j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j], way[j] = cur, j0
                    if minv[j] < delta:
                        delta, j1 = minv[j], j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    return [(p[j] - 1, j - 1) for j in range(1, m + 1) if p[j] != 0]


def match(truth: list[tuple[float, float]], pred: list[tuple[float, float]], radius: float) -> tuple[int, int, int, list[float]]:
    """(true positives, false positives, false negatives, matched distances) for one frame."""
    if not truth or not pred:
        return 0, len(pred), len(truth), []
    t, q = np.asarray(truth, dtype=np.float64), np.asarray(pred, dtype=np.float64)
    d = np.linalg.norm(t[:, None, :] - q[None, :, :], axis=2)
    cost = np.where(d <= radius, d, _BIG)
    dists = [float(d[i, j]) for i, j in assign(cost) if d[i, j] <= radius]
    tp = len(dists)
    return tp, len(pred) - tp, len(truth) - tp, dists


@dataclass
class Frame:
    at: int
    truth: int
    pred: int
    tp: int
    fp: int
    fn: int
    dists: list[float] = field(default_factory=list)


def score_frames(frames: list[Frame]) -> dict:
    tp = sum(f.tp for f in frames)
    fp = sum(f.fp for f in frames)
    fn = sum(f.fn for f in frames)
    prec = tp / (tp + fp) if tp + fp else math.nan
    rec = tp / (tp + fn) if tp + fn else math.nan
    f1 = 2 * tp / (2 * tp + fp + fn) if tp + fp + fn else math.nan
    errs = [abs(f.pred - f.truth) for f in frames]
    dists = [d for f in frames for d in f.dists]
    return {
        'frames': len(frames), 'tp': tp, 'fp': fp, 'fn': fn,
        'precision': prec, 'recall': rec, 'f1': f1,
        # On empty frames F1 has nothing to find; what matters is people invented.
        'falsePerFrame': fp / len(frames) if frames else math.nan,
        'countMAE': float(np.mean(errs)) if errs else math.nan,
        'exactCount': float(np.mean([e == 0 for e in errs])) if errs else math.nan,
        'medianErrorPx': float(np.median(dists)) if dists else math.nan,
    }


def by_true_count(frames: list[Frame]) -> dict[str, dict]:
    groups: dict[str, list[Frame]] = {}
    for f in frames:
        groups.setdefault(str(min(f.truth, 3)) + ('+' if f.truth >= 3 else ''), []).append(f)
    return {k: score_frames(v) for k, v in sorted(groups.items())}


def confusion(frames: list[Frame], cap: int = 4) -> dict[str, int]:
    """How often a frame with t people was read as p people, as {"t,p": frames}; counts above `cap` share a row."""
    out: dict[str, int] = {}
    for f in frames:
        key = f'{min(f.truth, cap)},{min(f.pred, cap)}'
        out[key] = out.get(key, 0) + 1
    return dict(sorted(out.items()))


def bootstrap(frames: list[Frame], block_ms: int = 600_000, n: int = 2000, seed: int = 11) -> dict[str, list[float]]:
    """95% intervals for F1 and count MAE, resampling whole blocks of time."""
    blocks: dict[int, list[Frame]] = {}
    for f in frames:
        blocks.setdefault(f.at // block_ms, []).append(f)
    keys = list(blocks)
    rng = np.random.default_rng(seed)
    f1s, maes = [], []
    for _ in range(n):
        pick = [f for k in rng.choice(len(keys), len(keys), replace=True) for f in blocks[keys[k]]]
        s = score_frames(pick)
        f1s.append(s['f1'])
        maes.append(s['countMAE'])
    q = lambda xs: [float(np.nanpercentile(xs, 2.5)), float(np.nanpercentile(xs, 97.5))]
    return {'f1': q(f1s), 'countMAE': q(maes), 'blocks': [len(keys)]}


def paired_bootstrap(a: list[Frame], b: list[Frame], block_ms: int = 600_000, n: int = 2000, seed: int = 11) -> dict:
    """b minus a on the same frames: the observed difference in F1 and count MAE, and 95% intervals.

    Both are resampled with the same blocks of time, so what the two models
    have in common (an easy evening, a crowded one) cancels out of the
    difference instead of widening it.
    """
    if [f.at for f in a] != [f.at for f in b]:
        raise ValueError('a paired comparison needs both models scored on the same frames, in the same order')
    blocks: dict[int, list[int]] = {}
    for i, f in enumerate(a):
        blocks.setdefault(f.at // block_ms, []).append(i)
    keys = list(blocks)
    rng = np.random.default_rng(seed)
    d_f1, d_mae = [], []
    for _ in range(n):
        idx = [i for k in rng.choice(len(keys), len(keys), replace=True) for i in blocks[keys[k]]]
        sa, sb = score_frames([a[i] for i in idx]), score_frames([b[i] for i in idx])
        d_f1.append(sb['f1'] - sa['f1'])
        d_mae.append(sb['countMAE'] - sa['countMAE'])
    q = lambda xs: [float(np.nanpercentile(xs, 2.5)), float(np.nanpercentile(xs, 97.5))]
    sa, sb = score_frames(a), score_frames(b)
    return {'f1': sb['f1'] - sa['f1'], 'f1ci95': q(d_f1), 'countMAE': sb['countMAE'] - sa['countMAE'],
            'countMAEci95': q(d_mae), 'blocks': len(keys)}
