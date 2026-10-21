"""
Fine-tuning the RGB teacher on the hand labels, scored two-fold by day.

    data/ml/.venv/bin/python -m tools.thermalml.finetune prepare
    data/ml/.venv/bin/python -m tools.thermalml.finetune train --model yolo11s --fold A   # A, B or all
    data/ml/.venv/bin/python -m tools.thermalml.finetune predict --model yolo11s

The settings are the ones docs/THERMAL_ML.md fixed before any fine-tuned
model was trained. Fold A learns 26 Sept and predicts 29 Sept, fold B the
reverse, so every hand-labelled frame gets a prediction from a model that
never saw its day; `predict` writes those, in teachers.py's format, as
data/ml/teachers/ft-<model>/, and the bake-off scores them like any other
candidate. Fold `all` is the teacher that labels October -- its quality is
the two-fold score, never a score on frames it trained on.

Training uses the original photos from the frames export (what the teacher
will see in October) with the hand-drawn boxes from the Roboflow export.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil

from .rgb import read_pairs_index
from .shards import read_shard, sensor_dir

UID = '2c:cf:67:0b:c0:94'
DAY_A, DAY_B = '2026-09-26', '2026-09-29'
FOLDS = {'A': [DAY_A], 'B': [DAY_B], 'all': [DAY_A, DAY_B]}
PREDICTS = {'A': DAY_B, 'B': DAY_A}
VAL_SHARE = 0.2
ROOT = os.path.join('data', 'ml', 'finetune')
LABELS = os.path.join('data', 'ml', 'handlabels', 'v1')
SETTINGS = {'imgsz': 640, 'epochs': 60, 'batch': 16, 'patience': 20, 'seed': 0, 'flipud': 0.5}
CONF, NMS_IOU = 0.25, 0.7


def labelled_frames() -> dict[str, list[tuple[int, str, str]]]:
    """day -> [(at, rgb id, label file)] for the hand-labelled frames, in time order."""
    label_file = {}
    for img in glob.glob(os.path.join(LABELS, '*', 'images', '*.jpg')):
        name = os.path.basename(img).split('_jpg')[0]
        label_file[name] = img.replace(f'{os.sep}images{os.sep}', f'{os.sep}labels{os.sep}').rsplit('.', 1)[0] + '.txt'
    out: dict[str, list[tuple[int, str, str]]] = {}
    for day in (DAY_A, DAY_B):
        s = read_shard(os.path.join('data', 'ml', 'shards'), UID, day)
        pairs = read_pairs_index(os.path.join('data', 'ml', 'rgb'), UID, day)
        rows = [(int(s.at[i]), pairs[tid]['rgb'], label_file[tid[:16]])
                for i, tid in enumerate(s.ids) if tid[:16] in label_file and tid in pairs]
        out[day] = sorted(rows)
    return out


def photo(day: str, rgb_id: str) -> str:
    return os.path.abspath(os.path.join('data', 'ml', 'rgb', 'locked', sensor_dir(UID), day, f'{rgb_id}.jpg'))


def prepare() -> None:
    frames = labelled_frames()
    for fold, train_days in FOLDS.items():
        base = os.path.join(ROOT, fold)
        shutil.rmtree(base, ignore_errors=True)
        counts = {'train': 0, 'val': 0}
        for day in train_days:
            rows = frames[day]
            cut = int(round(len(rows) * (1 - VAL_SHARE)))
            for k, (_at, rid, lab) in enumerate(rows):
                split = 'train' if k < cut else 'val'
                os.makedirs(os.path.join(base, split, 'images'), exist_ok=True)
                os.makedirs(os.path.join(base, split, 'labels'), exist_ok=True)
                os.symlink(photo(day, rid), os.path.join(base, split, 'images', f'{rid}.jpg'))
                shutil.copyfile(lab, os.path.join(base, split, 'labels', f'{rid}.txt'))
                counts[split] += 1
        with open(os.path.join(base, 'data.yaml'), 'w') as f:
            f.write(f'path: {os.path.abspath(base)}\ntrain: train/images\nval: val/images\nnames:\n  0: person\n')
        print(f'fold {fold}: train on {", ".join(train_days)}: {counts["train"]} train, {counts["val"]} val'
              + (f'; predicts {PREDICTS[fold]}' if fold in PREDICTS else ''))


def weights(model: str, fold: str) -> str:
    return os.path.join(ROOT, 'runs', f'{model}-{fold}', 'weights', 'best.pt')


def train(model: str, fold: str, device: str) -> None:
    from ultralytics import YOLO
    y = YOLO(os.path.join('data', 'ml', 'weights', f'{model}.pt'))
    y.train(data=os.path.join(ROOT, fold, 'data.yaml'), device=device, project=os.path.abspath(os.path.join(ROOT, 'runs')),
            name=f'{model}-{fold}', exist_ok=True, deterministic=True, plots=False, verbose=False, workers=2, **SETTINGS)
    print(f'{model} fold {fold}: {weights(model, fold)}')


def predict(model: str, device: str) -> None:
    from ultralytics import YOLO
    import ultralytics
    frames = labelled_frames()
    for fold, day in PREDICTS.items():
        y = YOLO(weights(model, fold))
        rids = [rid for _at, rid, _lab in frames[day]]
        boxes = {}
        for i in range(0, len(rids), 16):
            chunk = rids[i:i + 16]
            for rid, r in zip(chunk, y.predict(source=[photo(day, x) for x in chunk], imgsz=SETTINGS['imgsz'], conf=CONF,
                                                iou=NMS_IOU, classes=[0], device=device, verbose=False)):
                boxes[rid] = [[round(float(v), 2) for v in b.xyxy[0].tolist()] + [round(float(b.conf[0]), 4)] for b in r.boxes]
        dest = os.path.join('data', 'ml', 'teachers', f'ft-{model}', 'locked', sensor_dir(UID), f'{day}.json')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        meta = {'name': f'ft-{model}', 'framework': f'ultralytics {ultralytics.__version__}', 'fold': fold,
                'trainedOn': FOLDS[fold], 'conf': CONF, 'iou': NMS_IOU, **SETTINGS}
        with open(dest, 'w') as f:
            json.dump({'model': meta, 'day': day, 'boxes': boxes}, f, separators=(',', ':'))
        print(f'ft-{model} fold {fold} -> {day}: {len(boxes)} photos, {sum(len(v) for v in boxes.values())} people')


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m tools.thermalml.finetune')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('prepare')
    t = sub.add_parser('train')
    t.add_argument('--model', required=True, choices=('yolo11s', 'yolo26s'))
    t.add_argument('--fold', required=True, choices=tuple(FOLDS))
    t.add_argument('--device', default='mps')
    q = sub.add_parser('predict')
    q.add_argument('--model', required=True, choices=('yolo11s', 'yolo26s'))
    q.add_argument('--device', default='mps')
    a = p.parse_args(argv)
    if a.cmd == 'prepare':
        prepare()
    elif a.cmd == 'train':
        train(a.model, a.fold, a.device)
    else:
        predict(a.model, a.device)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
