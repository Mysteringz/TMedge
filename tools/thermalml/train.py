"""
Training the thermal people detector.

    data/ml/.venv/bin/python -m tools.thermalml.train --labels data/ml/labels/<teacher> \
        --train-day 2026-10-06 --train-day 2026-10-07 --train-day 2026-10-10 \
        --val-day 2026-10-09 --val-day 2026-10-11 --out data/ml/models/<name>

Inputs come from the feature cache (dataset.py), targets from the teacher's
labels (labels.py). Validation days pick the epoch and the threshold and
nothing else; the hand-labelled test is never touched here.

What keeps a model trained on one desk honest about other rooms is the
augmentation, each aimed at a room the rig has not seen:

    flips                      sensors hung the other way round
    zoom 0.65-1.15             higher mounts: a head from 350 cm is ~0.7x its size from 280 cm
    person signal x0.35-1.3    warm rooms, where people stand out less (c1, c2 only)
    pasted people              tables of six; the rig never saw more than ~4
    thinned or no 5-min history  other frame rates, and a node that just started
    sensor noise

The loss ignores what the photo could not see and people the teacher was
unsure of: unknown is never "nobody".
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time

import numpy as np

from . import days
from .dataset import load as load_features
from .heatnet import STRIDE, decode, export, torch_model
from .metrics import Frame, match, score_frames
from .shards import read_shard, sensor_dir

H, W = 24, 32
HO, WO = H // STRIDE, W // STRIDE
RADIUS = 2.0
SIGMA = 1.0                       # target Gaussian, in output cells
CLIPS = ((-1.0, 3.0), (-1.0, 3.0), (-1.5, 1.5))   # features.py's clips, in its scaled units
THRESHOLDS = [round(0.15 + 0.05 * k, 2) for k in range(14)]


def load_day(features_root: str, labels_root: str, shards_root: str, uid: str, day: str) -> dict:
    """Ready, labelled frames of one day, away from the day's boundaries."""
    f = load_features(features_root, uid, day)
    lab = json.load(open(os.path.join(labels_root, sensor_dir(uid), f'{day}.json')))
    return assemble(f, read_shard(shards_root, uid, day).ids, lab)


def load_pack_day(pack_dir: str, labels_root: str, uid: str, day: str) -> dict:
    """The same, from a training pack (hpc_pack.py) instead of the full feature cache and shards."""
    with np.load(os.path.join(pack_dir, f'{day}.npz')) as z:
        f = {k: z[k] for k in z.files}
    meta = json.load(open(os.path.join(pack_dir, f'{day}.json')))
    lab = json.load(open(os.path.join(labels_root, sensor_dir(uid), f'{day}.json')))
    return assemble(f, meta['tid'], lab)


def assemble(f: dict, ids: list[str], lab: dict) -> dict:
    keep = [i for i, tid in enumerate(ids)
            if f['ready'][i] and tid in lab['frames'] and not days.near_boundary(int(f['at'][i]))]
    return {
        'x': f['x'][keep].astype(np.float32), 'xthin': f['xthin'][keep].astype(np.float32), 'at': f['at'][keep],
        'pts': [lab['frames'][ids[i]]['pts'] for i in keep], 'ign': [lab['frames'][ids[i]]['ign'] for i in keep],
        'footprint': np.asarray(lab['footprint'], dtype=np.float32).reshape(H, W),
    }


def concat(parts: list[dict]) -> dict:
    out = {k: np.concatenate([p[k] for p in parts]) for k in ('x', 'xthin', 'at')}
    out['pts'] = [q for p in parts for q in p['pts']]
    out['ign'] = [q for p in parts for q in p['ign']]
    out['footprint'] = np.stack([p['footprint'] for p in parts for _ in range(len(p['at']))])
    return out


# --- targets ----------------------------------------------------------------

def targets(pts: list, ign: list, known: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(heatmap target, loss weight, offset target, positive mask), all at 12x16."""
    hm = np.zeros((HO, WO), dtype=np.float32)
    off = np.zeros((2, HO, WO), dtype=np.float32)
    pos = np.zeros((HO, WO), dtype=np.float32)
    ii, jj = np.mgrid[0:HO, 0:WO]
    for x, y, *_ in pts:
        cx, cy = x / STRIDE, y / STRIDE
        j, i = int(math.floor(cx)), int(math.floor(cy))
        if not (0 <= i < HO and 0 <= j < WO):
            continue
        g = np.exp(-((jj - j) ** 2 + (ii - i) ** 2) / (2 * SIGMA ** 2)).astype(np.float32)
        hm = np.maximum(hm, g)
        pos[i, j] = 1
        off[:, i, j] = (cx - (j + 0.5), cy - (i + 0.5))
    # A cell is known if most of its 2x2 thermal pixels are.
    weight = (known.reshape(HO, STRIDE, WO, STRIDE).mean(axis=(1, 3)) >= 0.5).astype(np.float32)
    for x, y in ign:
        j, i = int(math.floor(x / STRIDE)), int(math.floor(y / STRIDE))
        weight[max(0, i - 1):i + 2, max(0, j - 1):j + 2] = 0
    weight = np.maximum(weight, pos)          # a sure person is always a target
    return hm, weight, off, pos


# --- augmentation -----------------------------------------------------------

def _affine(x: np.ndarray, scale: float, cx: float, cy: float, order: int) -> np.ndarray:
    """Zoom (C, H, W) about (cx, cy): out(p) = in(c + (p - c) / scale); outside the frame is 0."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64) + 0.5
    sx, sy = cx + (xs - cx) / scale - 0.5, cy + (ys - cy) / scale - 0.5
    if order == 0:
        ix, iy = np.rint(sx).astype(int), np.rint(sy).astype(int)
        ok = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H)
        out = np.zeros_like(x)
        out[:, ok] = x[:, iy[ok], ix[ok]]
        return out
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = sx - x0, sy - y0
    out = np.zeros_like(x)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            xx, yy = x0 + dx, y0 + dy
            ok = (xx >= 0) & (xx < W) & (yy >= 0) & (yy < H)
            w = (wx * wy) * ok
            out += x[:, np.clip(yy, 0, H - 1), np.clip(xx, 0, W - 1)] * w
    return out


def augment(x: np.ndarray, xthin: np.ndarray, pts: list, ign: list, known: np.ndarray, rng: np.random.Generator,
            donors: list[tuple[np.ndarray, float, float]]):
    x = x.copy()
    r = rng.random()
    if r < 0.2:
        x[2] = 0                              # no 5-minute history yet
    elif r < 0.5:
        x[2] = xthin                          # history at one frame per 8 s
    pts = [list(p) for p in pts]
    ign = [list(p) for p in ign]
    known = known.copy()
    if rng.random() < 0.5:                    # left-right
        x, known = x[:, :, ::-1].copy(), known[:, ::-1].copy()
        pts = [[W - p[0], p[1], *p[2:]] for p in pts]
        ign = [[W - p[0], p[1]] for p in ign]
    if rng.random() < 0.5:                    # up-down
        x, known = x[:, ::-1, :].copy(), known[::-1, :].copy()
        pts = [[p[0], H - p[1], *p[2:]] for p in pts]
        ign = [[p[0], H - p[1]] for p in ign]
    if rng.random() < 0.6:                    # mounted higher or lower
        s = float(rng.uniform(0.65, 1.15))
        cx, cy = float(rng.uniform(8, 24)), float(rng.uniform(6, 18))
        x = _affine(x, s, cx, cy, 1)
        known = _affine(known[None], s, cx, cy, 0)[0]
        move = lambda p: [cx + (p[0] - cx) * s, cy + (p[1] - cy) * s]
        pts = [[*move(p), *p[2:]] for p in pts]
        ign = [move(p) for p in ign]
        inside = lambda p: 0 <= p[0] < W and 0 <= p[1] < H
        pts, ign = [p for p in pts if inside(p)], [p for p in ign if inside(p)]
    if rng.random() < 0.5:                    # a warmer room: people stand out less
        x[1:] *= float(rng.uniform(0.35, 1.3))
    if donors and rng.random() < 0.3:         # more people than the rig ever had
        for _ in range(int(rng.integers(1, 3))):
            patch, _px, _py = donors[int(rng.integers(len(donors)))]
            tx, ty = int(rng.integers(2, W - 2)), int(rng.integers(2, H - 2))
            if known[ty, tx] < 0.5 or any(math.hypot(p[0] - tx - 0.5, p[1] - ty - 0.5) < 3 for p in pts + ign):
                continue
            arrived = rng.random() < 0.3
            x[0, ty - 2:ty + 3, tx - 2:tx + 3] += patch
            x[1, ty - 2:ty + 3, tx - 2:tx + 3] += patch
            if arrived:
                x[2, ty - 2:ty + 3, tx - 2:tx + 3] += patch
            pts.append([tx + 0.5, ty + 0.5, 1.0])
    x += rng.normal(0, 0.02, x.shape).astype(np.float32)
    for c, (lo, hi) in enumerate(CLIPS):
        np.clip(x[c], lo, hi, out=x[c])
    return x.astype(np.float32), pts, ign, known


def donor_patches(d: dict, rng: np.random.Generator, n: int = 2000) -> list[tuple[np.ndarray, float, float]]:
    """5x5 positive parts of c1 around sure, isolated people: what a person adds to a frame."""
    out = []
    idx = [i for i, p in enumerate(d['pts']) if len(p) == 1]
    for i in rng.choice(idx, size=min(n, len(idx)), replace=False) if idx else []:
        x, y = d['pts'][i][0][0], d['pts'][i][0][1]
        cx, cy = int(x), int(y)
        if 2 <= cx < W - 2 and 2 <= cy < H - 2:
            out.append((np.clip(d['x'][i][1, cy - 2:cy + 3, cx - 2:cx + 3], 0, None).copy(), x, y))
    return out


# --- training ---------------------------------------------------------------

def focal(logits, target, weight, pos):
    import torch
    p = torch.sigmoid(logits).clamp(1e-4, 1 - 1e-4)
    pos_l = torch.log(p) * (1 - p) ** 2 * pos
    neg_l = torch.log(1 - p) * p ** 2 * (1 - target) ** 4 * (1 - pos)
    return -((pos_l + neg_l) * weight).sum() / pos.sum().clamp(min=1)


def evaluate(model, d: dict, every: int = 3) -> dict[float, dict]:
    """Validation F1 per threshold. Predictions on unknown pixels or on a set-aside person do not count."""
    import torch
    model.eval()
    idx = list(range(0, len(d['at']), every))
    frames = {t: [] for t in THRESHOLDS}
    with torch.no_grad():
        for s in range(0, len(idx), 512):
            b = idx[s:s + 512]
            dev = next(model.parameters()).device
            hm, off = model(torch.from_numpy(d['x'][b]).to(dev))
            hm, off = hm.cpu().numpy(), off.cpu().numpy()
            for k, i in enumerate(b):
                known = d['footprint'][i]
                truth = [(p[0], p[1]) for p in d['pts'][i]]
                cand = decode(hm[k], off[k], min(THRESHOLDS))
                for t in THRESHOLDS:
                    pred = [(x, y) for (x, y, c) in cand if c >= t and 0 <= int(y) < H and 0 <= int(x) < W
                            and known[int(y), int(x)] >= 0.5
                            and not any(math.hypot(x - q[0], y - q[1]) <= RADIUS for q in d['ign'][i])]
                    tp, fp, fn, dist = match(truth, pred, RADIUS)
                    frames[t].append(Frame(int(d['at'][i]), len(truth), len(pred), tp, fp, fn, dist))
    return {t: score_frames(f) for t, f in frames.items()}


def finite(v):
    """JSON the edge can parse: NaN and infinity (a precision with no predictions) become null."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [finite(x) for x in v]
    return v


def main(argv: list[str] | None = None) -> int:
    import torch
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.train')
    p.add_argument('--labels', required=True)
    p.add_argument('--features', default='data/ml/features')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--pack', help='read frames from a training pack (hpc_pack.py) instead of --features/--shards')
    p.add_argument('--device', default='cpu', help='cpu, cuda or mps')
    p.add_argument('--uid', default='2c:cf:67:0b:c0:94')
    p.add_argument('--train-day', action='append', required=True)
    p.add_argument('--val-day', action='append', required=True)
    p.add_argument('--epochs', type=int, default=25)
    p.add_argument('--samples', type=int, default=20000, help='frames per epoch, half of them with people')
    p.add_argument('--batch', type=int, default=256)
    p.add_argument('--lr', type=float, default=2e-3)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--out', required=True)
    a = p.parse_args(argv)

    days.assert_trainable(set(a.train_day) | set(a.val_day))
    if set(a.train_day) & set(a.val_day):
        raise SystemExit('a day cannot be both trained and validated on')
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    load = (lambda d: load_pack_day(a.pack, a.labels, a.uid, d)) if a.pack else (lambda d: load_day(a.features, a.labels, a.shards, a.uid, d))
    tr = concat([load(d) for d in a.train_day])
    va = concat([load(d) for d in a.val_day])
    with_people = np.array([len(q) > 0 for q in tr['pts']])
    donors = donor_patches(tr, rng)
    print(f'train {len(tr["at"])} frames ({int(with_people.sum())} with people), val {len(va["at"])}, donors {len(donors)}', flush=True)

    dev = torch.device(a.device)
    model = torch_model().to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * math.ceil(a.samples / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps, pct_start=0.1)
    pos_idx, neg_idx = np.flatnonzero(with_people), np.flatnonzero(~with_people)
    history, best = [], None
    os.makedirs(a.out, exist_ok=True)
    for epoch in range(1, a.epochs + 1):
        model.train()
        t0, total = time.time(), 0.0
        order = np.concatenate([rng.choice(pos_idx, a.samples // 2), rng.choice(neg_idx, a.samples - a.samples // 2)])
        rng.shuffle(order)
        for s in range(0, len(order), a.batch):
            xs, hms, ws, offs, poss = [], [], [], [], []
            for i in order[s:s + a.batch]:
                x, pts, ign, known = augment(tr['x'][i], tr['xthin'][i], tr['pts'][i], tr['ign'][i], tr['footprint'][i], rng, donors)
                hm, w, off, pos = targets(pts, ign, known)
                xs.append(x); hms.append(hm); ws.append(w); offs.append(off); poss.append(pos)
            X = torch.from_numpy(np.stack(xs)).to(dev)
            HM, WGT = torch.from_numpy(np.stack(hms))[:, None].to(dev), torch.from_numpy(np.stack(ws))[:, None].to(dev)
            OFF, POS = torch.from_numpy(np.stack(offs)).to(dev), torch.from_numpy(np.stack(poss))[:, None].to(dev)
            logits, off_pred = model(X)
            loss = focal(logits, HM, WGT, POS) + (torch.abs(off_pred - OFF) * POS).sum() / POS.sum().clamp(min=1)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(xs)
        scores = evaluate(model, va)
        t_best = max(scores, key=lambda t: (scores[t]['f1'] if not math.isnan(scores[t]['f1']) else -1))
        s = scores[t_best]
        row = {'epoch': epoch, 'loss': total / len(order), 'threshold': t_best, **{k: s[k] for k in
               ('f1', 'precision', 'recall', 'countMAE', 'exactCount', 'falsePerFrame')}, 'seconds': round(time.time() - t0)}
        history.append(row)
        print(json.dumps(row), flush=True)
        if best is None or s['f1'] > best['f1']:
            best = row
            torch.save(model.state_dict(), os.path.join(a.out, 'best.pt'))

    model.load_state_dict(torch.load(os.path.join(a.out, 'best.pt'), map_location=dev))
    model = model.cpu()
    meta = {'threshold': best['threshold'], 'trainedAt': int(time.time() * 1000), 'trainDays': a.train_day, 'valDays': a.val_day,
            'labels': os.path.basename(os.path.normpath(a.labels)), 'metrics': {'validation': best}, 'seed': a.seed}
    doc = finite(export(model, meta))
    with open(os.path.join(a.out, 'model.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'), allow_nan=False)
    with open(os.path.join(a.out, 'history.json'), 'w') as f:
        json.dump(finite(history), f, indent=1, allow_nan=False)
    print(f'best epoch {best["epoch"]}: validation F1 {best["f1"]:.3f} at threshold {best["threshold"]}; model {doc["id"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
