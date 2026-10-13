"""
The thermal people detector: a small heatmap network, and the file the edge runs.

Trained in PyTorch, shipped as JSON, run on the edge by src/algo/heatmodel.ts
with no ML runtime. The JSON is a short list of layers -- 3x3 and 1x1
convolutions (stride 1 or 2, zero padding), ReLU, nearest 2x upsampling, add
-- with batch norm already folded into the weights, so the edge implements
four operations and nothing else.

    input  (3, 24, 32)  c0/c1/c2 from features.py / heatfeatures.ts
    output (1, 12, 16)  person-centre logits, one cell per 2x2 thermal pixels
           (2, 12, 16)  sub-cell offset of the centre, in cells

forward_np() is the same arithmetic in numpy: CI has numpy but not PyTorch,
so the TypeScript is checked against golden files this produces, and this is
checked against PyTorch wherever PyTorch is installed.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np

FORMAT = 'cnn-heatmap'
VERSION = 2
STRIDE = 2               # output cell = 2x2 thermal pixels
WIDTHS = (12, 24, 32)


# --- PyTorch: training only -------------------------------------------------

def torch_model(widths: tuple[int, int, int] = WIDTHS):
    import torch
    from torch import nn

    def cbr(i: int, o: int, s: int) -> nn.Sequential:
        return nn.Sequential(nn.Conv2d(i, o, 3, s, 1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True))

    class HeatNet(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            a, b, c = widths
            self.enc1, self.down1, self.enc2 = cbr(3, a, 1), cbr(a, b, 2), cbr(b, b, 1)
            self.down2, self.enc3 = cbr(b, c, 2), cbr(c, c, 1)
            self.lat = nn.Conv2d(c, b, 1)
            self.dec = cbr(b, b, 1)
            self.hm = nn.Conv2d(b, 1, 1)
            self.off = nn.Conv2d(b, 2, 1)
            nn.init.constant_(self.hm.bias, -2.19)   # start by believing a cell is rarely a person

        def forward(self, x):
            e2 = self.enc2(self.down1(self.enc1(x)))
            e3 = self.enc3(self.down2(e2))
            u = torch.nn.functional.interpolate(self.lat(e3), scale_factor=2, mode='nearest') + e2
            d = self.dec(u)
            return self.hm(d), self.off(d)

    return HeatNet()


def _fold(seq) -> tuple[np.ndarray, np.ndarray, int]:
    """Conv + BatchNorm (+ ReLU) -> one conv with bias."""
    conv, bn = seq[0], seq[1]
    w = conv.weight.detach().double().cpu().numpy()
    scale = (bn.weight.detach().double() / (bn.running_var.detach().double() + bn.eps).sqrt()).cpu().numpy()
    shift = (bn.bias.detach().double() - bn.running_mean.detach().double() * torch_tensor(scale)).cpu().numpy()
    return (w * scale[:, None, None, None]).astype(np.float32), shift.astype(np.float32), conv.stride[0]


def torch_tensor(a: np.ndarray):
    import torch
    return torch.from_numpy(a)


def export(model, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """The JSON the edge loads. Layers are listed in the order they run."""
    model = model.eval()
    layers: list[dict[str, Any]] = []

    def conv(name: str, src: str, dst: str, w: np.ndarray, b: np.ndarray, stride: int, relu: bool) -> None:
        layers.append({'op': 'conv', 'name': name, 'input': src, 'output': dst, 'in': int(w.shape[1]), 'out': int(w.shape[0]),
                       'k': int(w.shape[2]), 'stride': int(stride), 'relu': relu,
                       'w': [round(float(v), 7) for v in w.ravel()], 'b': [round(float(v), 7) for v in b.ravel()]})

    for name, src, dst in (('enc1', 'x', 'e1'), ('down1', 'e1', 'd1'), ('enc2', 'd1', 'e2'),
                           ('down2', 'e2', 'd2'), ('enc3', 'd2', 'e3')):
        w, b, s = _fold(getattr(model, name))
        conv(name, src, dst, w, b, s, True)
    lat = model.lat
    conv('lat', 'e3', 'l', lat.weight.detach().cpu().numpy(), lat.bias.detach().cpu().numpy(), 1, False)
    layers.append({'op': 'up2', 'input': 'l', 'output': 'u'})
    layers.append({'op': 'add', 'inputs': ['u', 'e2'], 'output': 's'})
    w, b, s = _fold(model.dec)
    conv('dec', 's', 'd', w, b, s, True)
    for name in ('hm', 'off'):
        c = getattr(model, name)
        conv(name, 'd', name, c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy(), 1, False)
    doc: dict[str, Any] = {
        'version': VERSION, 'kind': FORMAT, 'features': 'heatfeatures-v1', 'input': [3, 24, 32],
        'outputs': {'heatmap': 'hm', 'offset': 'off', 'stride': STRIDE}, 'layers': layers,
    }
    doc['id'] = hashlib.sha256(json.dumps(doc['layers'], sort_keys=True).encode()).hexdigest()[:16]
    doc.update(meta or {})
    return doc


# --- numpy: the reference the edge is checked against -----------------------

def _conv_np(x: np.ndarray, w: np.ndarray, b: np.ndarray, stride: int) -> np.ndarray:
    c_out, c_in, k, _ = w.shape
    pad = k // 2
    _, h, wd = x.shape
    ho, wo = (h + 2 * pad - k) // stride + 1, (wd + 2 * pad - k) // stride + 1
    xp = np.zeros((c_in, h + 2 * pad, wd + 2 * pad), dtype=np.float64)
    xp[:, pad:pad + h, pad:pad + wd] = x
    out = np.zeros((c_out, ho, wo), dtype=np.float64)
    for ky in range(k):
        for kx in range(k):
            patch = xp[:, ky:ky + stride * ho:stride, kx:kx + stride * wo:stride]
            out += np.einsum('oc,chw->ohw', w[:, :, ky, kx].astype(np.float64), patch)
    return (out + b.astype(np.float64)[:, None, None])


def forward_np(doc: dict[str, Any], x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(heatmap logits (1,12,16), offsets (2,12,16)) for one (3,24,32) input, in float64."""
    t: dict[str, np.ndarray] = {'x': np.asarray(x, dtype=np.float64)}
    for L in doc['layers']:
        if L['op'] == 'conv':
            w = np.asarray(L['w'], dtype=np.float32).reshape(L['out'], L['in'], L['k'], L['k'])
            y = _conv_np(t[L['input']], w, np.asarray(L['b'], dtype=np.float32), L['stride'])
            t[L['output']] = np.maximum(y, 0) if L['relu'] else y
        elif L['op'] == 'up2':
            t[L['output']] = t[L['input']].repeat(2, axis=1).repeat(2, axis=2)
        elif L['op'] == 'add':
            a, b = (t[n] for n in L['inputs'])
            t[L['output']] = a + b
        else:
            raise ValueError(f'unknown layer op {L["op"]}')
    o = doc['outputs']
    return t[o['heatmap']], t[o['offset']]


def decode(logits: np.ndarray, offset: np.ndarray, threshold: float) -> list[tuple[float, float, float]]:
    """People as (x, y, confidence) in thermal pixels: local maxima of the heatmap above threshold.

    A cell is a peak if no 3x3 neighbour is higher, ties going to raster order
    (as edgedetect.ts splits blobs), so a flat top gives one person.
    """
    p = 1 / (1 + np.exp(-logits[0]))
    h, w = p.shape
    out = []
    for i in range(h):
        for j in range(w):
            v = p[i, j]
            if v < threshold:
                continue
            peak = True
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    if (di or dj) and 0 <= i + di < h and 0 <= j + dj < w:
                        n = p[i + di, j + dj]
                        if n > v or (n == v and (i + di) * w + (j + dj) < i * w + j):
                            peak = False
            if peak:
                out.append((STRIDE * (j + 0.5 + float(offset[0, i, j])), STRIDE * (i + 0.5 + float(offset[1, i, j])), float(v)))
    return out


def golden(seed: int = 3, widths: tuple[int, int, int] = (4, 6, 8)) -> dict[str, Any]:
    """A deterministic random model, an input and its outputs, for test/golden/heatmodel (numpy only).

    Narrower than the real network so the committed file stays small; the
    operations, and so what the test proves about the edge's arithmetic, are the same.
    """
    rng = np.random.default_rng(seed)
    a, b, c = widths
    shapes = [('enc1', 'x', 'e1', 3, a, 3, 1, True), ('down1', 'e1', 'd1', a, b, 3, 2, True), ('enc2', 'd1', 'e2', b, b, 3, 1, True),
              ('down2', 'e2', 'd2', b, c, 3, 2, True), ('enc3', 'd2', 'e3', c, c, 3, 1, True), ('lat', 'e3', 'l', c, b, 1, 1, False)]
    layers: list[dict[str, Any]] = []
    for name, src, dst, i, o, k, s, relu in shapes:
        layers.append({'op': 'conv', 'name': name, 'input': src, 'output': dst, 'in': i, 'out': o, 'k': k, 'stride': s, 'relu': relu,
                       'w': [round(float(v), 7) for v in rng.normal(0, math.sqrt(2 / (i * k * k)), o * i * k * k)],
                       'b': [round(float(v), 7) for v in rng.normal(0, 0.1, o)]})
    layers += [{'op': 'up2', 'input': 'l', 'output': 'u'}, {'op': 'add', 'inputs': ['u', 'e2'], 'output': 's'}]
    for name, src, dst, i, o, k, s, relu in (('dec', 's', 'd', b, b, 3, 1, True), ('hm', 'd', 'hm', b, 1, 1, 1, False),
                                              ('off', 'd', 'off', b, 2, 1, 1, False)):
        layers.append({'op': 'conv', 'name': name, 'input': src, 'output': dst, 'in': i, 'out': o, 'k': k, 'stride': s, 'relu': relu,
                       'w': [round(float(v), 7) for v in rng.normal(0, math.sqrt(2 / (i * k * k)), o * i * k * k)],
                       'b': [round(float(v), 7) for v in rng.normal(0, 0.1, o)]})
    doc = {'version': VERSION, 'kind': FORMAT, 'features': 'heatfeatures-v1', 'input': [3, 24, 32],
           'outputs': {'heatmap': 'hm', 'offset': 'off', 'stride': STRIDE}, 'layers': layers, 'threshold': 0.5}
    doc['id'] = hashlib.sha256(json.dumps(layers, sort_keys=True).encode()).hexdigest()[:16]
    x = rng.normal(0, 0.5, (3, 24, 32)).astype(np.float32)
    hm, off = forward_np(doc, x)
    return {'model': doc, 'x': [float(v) for v in x.ravel()], 'heatmap': [float(v) for v in hm.ravel()],
            'offset': [float(v) for v in off.ravel()], 'people': [list(p) for p in decode(hm, off, 0.5)]}


if __name__ == '__main__':
    import sys
    json.dump(golden(int(sys.argv[1]) if len(sys.argv) > 1 else 3), sys.stdout)
