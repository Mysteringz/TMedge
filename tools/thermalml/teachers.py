"""
Off-the-shelf person detectors run over the rig's RGB photos: candidate teachers.

    data/ml/.venv/bin/python -m tools.thermalml.teachers --model yolo11s --rgb data/ml/rgb \
        --out data/ml/teachers --day 2026-09-26 --day 2026-09-29 [--only ids.txt]

Their settings are the ones docs/THERMAL_ML.md fixed before anything was
scored; changing them here without changing that page would quietly redo the
bake-off with different rules. Output, per model and day:

    <out>/<model>/[locked/]<uid without colons>/<day>.json
        {"model": {...settings, versions}, "boxes": {rgb id: [[x1, y1, x2, y2, conf], ...]}}

Ultralytics is AGPL-3.0: it runs here, offline, as a labelling tool, and is
never shipped with the edge.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import days
from .shards import sensor_dir

CONF = 0.25
NMS_IOU = 0.7
IMGSZ = 640
WEIGHTS_DIR = os.path.join('data', 'ml', 'weights')
MODELS = ('yolo11s', 'yolo26s', 'fasterrcnn_v2')


def day_folders(rgb_root: str, wanted: set[str] | None) -> list[tuple[str, str, str, bool]]:
    """(uid dir, day, folder, locked) for every extracted day."""
    out = []
    for base, locked in ((rgb_root, False), (os.path.join(rgb_root, 'locked'), True)):
        if not os.path.isdir(base):
            continue
        for sdir in sorted(os.listdir(base)):
            if sdir == 'locked' or not os.path.isdir(os.path.join(base, sdir)):
                continue
            for day in sorted(os.listdir(os.path.join(base, sdir))):
                folder = os.path.join(base, sdir, day)
                if os.path.isdir(folder) and (not wanted or day in wanted):
                    out.append((sdir, day, folder, locked))
    return out


def yolo_runner(name: str, device: str):
    from ultralytics import YOLO
    import ultralytics
    os.makedirs(WEIGHTS_DIR, exist_ok=True)
    model = YOLO(os.path.join(WEIGHTS_DIR, f'{name}.pt'))
    meta = {'name': name, 'framework': f'ultralytics {ultralytics.__version__}', 'imgsz': IMGSZ, 'conf': CONF,
            'iou': NMS_IOU, 'classes': [0], 'license': 'AGPL-3.0', 'device': device}

    def run(paths: list[str]) -> list[list[list[float]]]:
        res = model.predict(source=paths, imgsz=IMGSZ, conf=CONF, iou=NMS_IOU, classes=[0], device=device,
                            verbose=False, batch=16)
        return [[[*map(float, b.xyxy[0].tolist()), float(b.conf[0])] for b in r.boxes] for r in res]
    return run, meta


def frcnn_runner(device: str):
    import torch
    import torchvision
    from torchvision.io import decode_jpeg, read_file
    from torchvision.models.detection import FasterRCNN_ResNet50_FPN_V2_Weights, fasterrcnn_resnet50_fpn_v2
    os.environ.setdefault('TORCH_HOME', os.path.join(WEIGHTS_DIR, 'torch'))
    weights = FasterRCNN_ResNet50_FPN_V2_Weights.COCO_V1
    # progress=False: a percentage bar is thousands of characters in a SLURM log.
    model = fasterrcnn_resnet50_fpn_v2(weights=weights, progress=False, box_score_thresh=CONF).eval().to(device)
    meta = {'name': 'fasterrcnn_v2', 'framework': f'torchvision {torchvision.__version__}', 'weights': str(weights),
            'conf': CONF, 'label': 'person (COCO 1)', 'device': device}

    @torch.no_grad()
    def run(paths: list[str]) -> list[list[list[float]]]:
        imgs = [weights.transforms()(decode_jpeg(read_file(p))).to(device) for p in paths]
        out = []
        for det in model(imgs):
            keep = (det['labels'] == 1) & (det['scores'] >= CONF)
            out.append([[*map(float, b.tolist()), float(s)] for b, s in zip(det['boxes'][keep].cpu(), det['scores'][keep].cpu())])
        return out
    return run, meta


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.teachers')
    p.add_argument('--model', required=True, choices=MODELS)
    p.add_argument('--rgb', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--day', action='append')
    p.add_argument('--only', help='file with one rgb id per line: run on these photos only')
    p.add_argument('--every', type=int, default=1, help='every Nth photo of a day (by name, an arbitrary sample)')
    p.add_argument('--device', default='mps')
    p.add_argument('--batch', type=int, default=32)
    a = p.parse_args(argv)

    only = None
    if a.only:
        with open(a.only) as f:
            only = {line.strip() for line in f if line.strip()}
    run, meta = frcnn_runner(a.device) if a.model == 'fasterrcnn_v2' else yolo_runner(a.model, a.device)
    for sdir, day, folder, locked in day_folders(a.rgb, set(a.day) if a.day else None):
        if locked != days.is_locked(day):
            raise RuntimeError(f'{folder}: locked day filed in the wrong place')
        files = sorted(f for f in os.listdir(folder) if f.endswith('.jpg'))
        if only is not None:
            files = [f for f in files if f[:-4] in only]
        files = files[::a.every]
        dest = os.path.join(a.out, a.model, *(['locked'] if locked else []), sdir, f'{day}.json')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest):
            print(f'{a.model} {sdir} {day}: already done', file=sys.stderr)
            continue
        # Progress is saved as it goes: a long day (hours for Faster R-CNN on
        # a laptop) that is interrupted resumes instead of starting over.
        partial = dest + '.partial.json'
        boxes = json.load(open(partial))['boxes'] if os.path.exists(partial) else {}
        files = [f for f in files if f[:-4] not in boxes]
        t0, last = time.time(), time.time()
        for i in range(0, len(files), a.batch):
            chunk = files[i:i + a.batch]
            for f, b in zip(chunk, run([os.path.join(folder, f) for f in chunk])):
                boxes[f[:-4]] = [[round(v, 2) for v in box[:4]] + [round(box[4], 4)] for box in b]
            if a.device == 'mps':
                # PyTorch's MPS cache otherwise grows batch after batch until a
                # 16 GB Mac swaps (seen: 12 GB wired after three hours).
                import torch
                torch.mps.empty_cache()
            if time.time() - last > 60:
                with open(partial + '.tmp', 'w') as f:
                    json.dump({'boxes': boxes}, f, separators=(',', ':'))
                os.replace(partial + '.tmp', partial)
                done = i + len(chunk)
                print(f'[{time.strftime("%H:%M:%S")}] {a.model} {sdir} {day}: {done}/{len(files)} new photos, {done / (time.time() - t0):.2f}/s', file=sys.stderr, flush=True)
                last = time.time()
        with open(dest + '.tmp', 'w') as f:
            json.dump({'model': meta, 'day': day, 'boxes': boxes}, f, separators=(',', ':'))
        os.replace(dest + '.tmp', dest)
        if os.path.exists(partial):
            os.remove(partial)
        print(f'{a.model} {sdir} {day}: {len(boxes)} photos, {sum(len(v) for v in boxes.values())} people, '
              f'{time.time() - t0:.0f} s', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
