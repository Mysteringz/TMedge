"""
The thermal people detector's labelling and training, as one SLURM job (module 02 entrypoint).

    hpc_job.py --stage check | stage | label | train | all

Uploads come from tools/thermalml/hpc_pack.py; each carries this file, the
tools/thermalml code and one piece of data. Everything persistent lives under
~/thermalml (the cluster account's home), so jobs hand work to each other:

    ~/thermalml/stage/<bundle>/pack/       the training pack
    ~/thermalml/stage/<bundle>/photos/     photo tars still to be read
    ~/thermalml/stage/<bundle>/teachers/   Faster R-CNN's boxes for them
    ~/thermalml/work/<bundle>/             unpacked photos, labels
    ~/thermalml/out/<bundle>/model/        the trained model, its history, the scores
    ~/thermalml/venv/                      PyTorch, when the cluster has none

check and stage need only Python's standard library: they must work before
anything is installed. label and train need numpy and PyTorch; if the
running Python lacks them they are installed into ~/thermalml/venv from PyPI
(when the nodes can reach it) and the job re-runs itself there.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.expanduser('~'), 'thermalml')
CODE = os.path.dirname(os.path.abspath(__file__))
UID = '2c:cf:67:0b:c0:94'
SENSOR = UID.replace(':', '')
TEACHER = ['yolo11s', 'yolo26s', 'fasterrcnn_v2']
STAGE = 'all'          # the stage asked for, so a re-run in the venv repeats exactly that
QUICK = False          # a rehearsal: one short epoch, to prove the pipeline end to end


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def bundle() -> str:
    with open(os.path.join(CODE, 'BUNDLE')) as f:
        return f.read().strip()


def paths(b: str) -> dict[str, str]:
    return {'stage': os.path.join(ROOT, 'stage', b), 'work': os.path.join(ROOT, 'work', b), 'out': os.path.join(ROOT, 'out', b)}


# --- check: what this cluster has (stdlib only) ------------------------------

def reach(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return f'yes ({r.status})'
    except urllib.error.HTTPError as e:   # the server answered: the network path works
        return f'reachable (HTTP {e.code})'
    except Exception as e:  # noqa: BLE001 -- no answer at all
        return f'no ({type(e).__name__}: {str(e)[:80]})'


def reach_head(url: str) -> str:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=10) as r:
            return f'yes ({r.status}, {int(r.headers.get("Content-Length", 0)) / 1e6:.0f} MB)'
    except Exception as e:  # noqa: BLE001
        return f'no ({type(e).__name__}: {str(e)[:80]})'


def run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip() or '(no output)'
    except Exception as e:  # noqa: BLE001
        return f'(not available: {type(e).__name__})'


def stage_check() -> None:
    log('== environment check ==')
    print('host:', os.uname().nodename, '| cpus:', os.cpu_count(), '| python:', sys.version.split()[0], sys.executable)
    total, used, free = shutil.disk_usage(os.path.expanduser('~'))
    print(f'home disk: {free / 1e9:.1f} GB free of {total / 1e9:.1f} GB')
    print('gpus:', run(['bash', '-c', 'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader 2>&1']))
    print('  (NVML errors mean the GPU driver is broken until the machine is restarted; the job then runs on CPU)')
    print('slurm limits:', run(['bash', '-c', 'scontrol show config | grep -i -E "MaxJobTime|scron" ; scontrol show partition debug | grep -i -E "MaxTime|State"']))
    print('scrontab:', run(['bash', '-c', 'scrontab -l 2>&1 | head -3']))
    for name in ('numpy', 'torch', 'torchvision'):
        try:
            mod = __import__(name)
            extra = ''
            if name == 'torch':
                extra = f', cuda {mod.cuda.is_available()} ({mod.version.cuda})'
            print(f'{name}: {mod.__version__}{extra}')
        except Exception as e:  # noqa: BLE001
            print(f'{name}: missing ({type(e).__name__})')
    print('conda:', shutil.which('conda') or 'none', '| module:', shutil.which('modulecmd') or os.environ.get('MODULESHOME', 'none'))
    # The folder URL answers 403 even where downloads work; ask for the file itself.
    print('internet: pypi', reach('https://pypi.org/simple/'),
          '| Faster R-CNN weights', reach_head('https://download.pytorch.org/models/fasterrcnn_resnet50_fpn_v2_coco-dd69338a.pth'),
          '| edge', reach('https://algo.hkumyseat.com/'))
    venv = os.path.join(ROOT, 'venv', 'bin', 'python')
    print('~/thermalml/venv:', 'present' if os.path.exists(venv) else 'absent')


# --- stage: copy this upload's data into ~/thermalml/stage (stdlib only) -----

def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def stage_stage() -> None:
    b = bundle()
    dst = paths(b)['stage']
    os.makedirs(dst, exist_ok=True)
    src_pack = os.path.join(CODE, 'pack')
    if os.path.isdir(src_pack):
        shutil.copytree(src_pack, os.path.join(dst, 'pack'), dirs_exist_ok=True)
        log(f'training pack staged: {len(os.listdir(src_pack))} files -> {dst}/pack')
    manifest = os.path.join(CODE, 'data', 'manifest.json')
    if os.path.exists(manifest):
        m = json.load(open(manifest))
        src = os.path.join(CODE, m['file'])
        if sha256(src) != m['sha256']:
            raise SystemExit(f'{m["file"]} does not match its checksum: the upload is damaged, upload it again')
        os.makedirs(os.path.join(dst, 'photos'), exist_ok=True)
        shutil.copy(src, os.path.join(dst, 'photos', os.path.basename(src)))
        log(f'{os.path.basename(src)} staged ({os.path.getsize(src) / 1e6:.0f} MB, checksum ok)')
    log(f'staged so far: {sorted(os.listdir(dst))}; photos: {sorted(os.listdir(os.path.join(dst, "photos"))) if os.path.isdir(os.path.join(dst, "photos")) else []}')


# --- environment: make sure numpy + torch exist, else install and re-run ----

def ensure_torch() -> None:
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import torchvision  # noqa: F401
        return
    except ImportError:
        pass
    venv = os.path.join(ROOT, 'venv')
    py = os.path.join(venv, 'bin', 'python')
    if os.path.abspath(sys.executable) == os.path.abspath(py):
        raise SystemExit('PyTorch is still missing inside ~/thermalml/venv; see the install log above')
    if not os.path.exists(py):
        log('PyTorch is not installed here; creating ~/thermalml/venv (needs the nodes to reach pypi.org)')
        subprocess.run([sys.executable, '-m', 'venv', venv], check=True)
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], check=True)
    subprocess.run([py, '-m', 'pip', 'install', '--quiet', 'numpy', 'torch', 'torchvision'], check=True)
    log('re-running in ~/thermalml/venv')
    os.execv(py, [py, '-u', os.path.abspath(__file__), '--stage', STAGE] + (['--quick'] if QUICK else []))


def device() -> str:
    import torch
    cpus = int(os.environ.get('SLURM_CPUS_PER_TASK', os.cpu_count() or 1))
    torch.set_num_threads(cpus)
    if torch.cuda.is_available():
        return 'cuda'
    log(f'no usable GPU: running on {cpus} CPU threads')
    return 'cpu'


# --- label: Faster R-CNN on the staged photos --------------------------------

def stage_label() -> None:
    ensure_torch()
    sys.path.insert(0, CODE)
    from tools.thermalml import teachers
    p = paths(bundle())
    photos = os.path.join(p['stage'], 'photos')
    if not os.path.isdir(photos) or not os.listdir(photos):
        log('no photos staged: nothing to label')
        return
    rgb = os.path.join(p['work'], 'rgb')
    for tar in sorted(os.listdir(photos)):
        with tarfile.open(os.path.join(photos, tar)) as t:
            try:
                t.extractall(rgb, filter='data')
            except TypeError:          # Python before the extraction filters; these tars are our own
                t.extractall(rgb)
    day_list = sorted(os.listdir(os.path.join(rgb, SENSOR)))
    os.environ.setdefault('TORCH_HOME', os.path.join(ROOT, 'torch'))
    dev = device()
    log(f'Faster R-CNN on {", ".join(day_list)} with {dev}')
    args = ['--model', 'fasterrcnn_v2', '--rgb', rgb, '--out', os.path.join(p['stage'], 'teachers'), '--device', dev,
            '--batch', '8']
    for d in day_list:
        args += ['--day', d]
    teachers.main(args)


# --- train: labels from the fused teacher, the model, and its scores --------

def stage_train() -> None:
    ensure_torch()
    sys.path.insert(0, CODE)
    import numpy as np
    from tools.thermalml import days, evaluate, labels, train
    from tools.thermalml.bakeoff import wbf
    from tools.thermalml.heatnet import decode, forward_np
    p = paths(bundle())
    pack = os.path.join(p['stage'], 'pack')
    meta = json.load(open(os.path.join(pack, 'meta.json')))
    m = json.load(open(os.path.join(pack, 'mapping.json')))
    lab_root = os.path.join(p['work'], 'labels')
    os.makedirs(os.path.join(lab_root, SENSOR), exist_ok=True)
    fp = labels.footprint(m)
    for day in meta['days']:
        dm = json.load(open(os.path.join(pack, f'{day}.json')))
        per = dict(dm['teachers'])
        frcnn = os.path.join(p['stage'], 'teachers', 'fasterrcnn_v2', SENSOR, f'{day}.json')
        if 'fasterrcnn_v2' not in per and os.path.exists(frcnn):
            per['fasterrcnn_v2'] = json.load(open(frcnn))['boxes']
        missing = [t for t in TEACHER if t not in per]
        if missing:
            raise SystemExit(f'{day}: no boxes from {missing}; run --stage label first')
        common = set.intersection(*(set(per[t]) for t in TEACHER))
        fused = {rid: wbf([per[t][rid] for t in TEACHER], len(TEACHER)) for rid in common}
        rid_of = dict(zip(dm['tid'], dm['rid']))
        bright = dict(zip(dm['rid'], dm['bright']))
        frames, dark = labels.label_frames(rid_of, fused, bright, m)
        with open(os.path.join(lab_root, SENSOR, f'{day}.json'), 'w') as f:
            json.dump({'teacher': {'name': 'wbf:' + '+'.join(TEACHER)}, 'minBrightness': labels.MIN_BRIGHTNESS,
                       'mapping': {k: m[k] for k in ('period', 'flipX', 'rms', 'framesUsed')},
                       'footprint': [int(v) for v in fp.ravel()], 'frames': frames}, f, separators=(',', ':'))
        log(f'{day}: {len(frames)} labelled frames ({dark} too dark), {sum(len(v["pts"]) for v in frames.values())} people, '
            f'{sum(len(v["ign"]) for v in frames.values())} set aside')

    out = os.path.join(p['out'], 'model')
    dev = device()
    args = ['--pack', pack, '--labels', lab_root, '--device', dev, '--out', out] + (['--epochs', '1', '--samples', '512'] if QUICK else [])
    for d in meta['trainDays']:
        args += ['--train-day', d]
    for d in meta['valDays']:
        args += ['--val-day', d]
    log(f'training on {meta["trainDays"]}, validating on {meta["valDays"]}, with {dev}')
    train.main(args)

    model = json.load(open(os.path.join(out, 'model.json')))
    report = {'model': model['id'], 'threshold': model['threshold'], 'teacher': 'wbf:' + '+'.join(TEACHER), 'days': {}}
    for day in meta['valDays']:
        d = train.load_pack_day(pack, lab_root, UID, day)
        dm = json.load(open(os.path.join(pack, f'{day}.json')))
        with np.load(os.path.join(pack, f'{day}.npz')) as z:
            ready, at = z['ready'], z['at']
        lab = json.load(open(os.path.join(lab_root, SENSOR, f'{day}.json')))['frames']
        keep = [i for i, tid in enumerate(dm['tid']) if ready[i] and tid in lab and not days.near_boundary(int(at[i]))]
        edge = [dm['edge'][i] for i in keep]

        def ml(i: int):
            hm, off = forward_np(model, d['x'][i])
            return [(x, y) for (x, y, _c) in decode(hm, off, model['threshold'])]
        report['days'][day] = {'frames': len(keep), 'edge': evaluate.score(d, lambda i: edge[i]), 'model': evaluate.score(d, ml)}
    with open(os.path.join(p['out'], 'scores.json'), 'w') as f:
        json.dump(train.finite(report), f, indent=1, allow_nan=False)

    log('== results (agreement with the teacher on the rig; the hand test is separate) ==')
    for day, r in report['days'].items():
        for who in ('edge', 'model'):
            a = r[who]['all']
            z = r[who]['byTrueCount'].get('0', {})
            fmt = lambda v: '-' if v is None or v != v else f'{v:.3f}'
            print(f'{day} {who:5}: F1 {fmt(a["f1"])} {r[who]["ci95"]["f1"]}  precision {fmt(a["precision"])}  recall {fmt(a["recall"])}  '
                  f'count error {fmt(a["countMAE"])}  false people per empty frame {fmt(z.get("falsePerFrame"))}')
    log(f'model, history and scores are in {p["out"]} (model {model["id"]})')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', required=True, choices=('check', 'stage', 'label', 'train', 'all'))
    ap.add_argument('--quick', action='store_true', help='rehearsal: one short training epoch')
    a = ap.parse_args()
    global STAGE, QUICK
    STAGE, QUICK = a.stage, a.quick
    t0 = time.time()
    if a.stage in ('check', 'all'):
        stage_check()
    if a.stage == 'stage':
        stage_stage()
    if a.stage in ('label', 'all'):
        stage_label()
    if a.stage in ('train', 'all'):
        stage_train()
    log(f'done in {(time.time() - t0) / 60:.1f} min')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
