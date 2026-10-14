"""
The thermal people detector's labelling and training, as one SLURM job (module 02 entrypoint).

    hpc_job.py --stage check | stage | label | train | all      (uploaded data, 1-in-5 photos)
    hpc_job.py --stage full                                       (every photo, fetched with a download key)
    hpc_job.py --stage compare                                    (job 2: two recipes on the same teacher boxes)

`full` needs nothing uploaded but this code: it fetches the newest export of
training.frames and training.pairs from the edge with the download key saved
in ~/thermalml/download.key (ML Data page -> Download keys), then builds the
shards, extracts every paired photo, runs all three teachers on every
October photo, labels, trains, scores against today's edge detector, runs the
hand-labelled test once, and deletes the photos it extracted.

`compare` (job 2) prepares the same way under ~/thermalml/job2, also
labelling rig days after 11 Oct whose cameras have not moved, then trains
two recipes three times each from the same teacher boxes: today's recipe
(job 1's), and a model with about twice the weights trained on labels the
nearby photos voted on. Each recipe keeps its best run on the validation
day; the hand-labelled test then compares the two, paired on its 400 frames.
Last, the winner is retrained on every labelled day, 10 Oct included.

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
# Cloudflare in front of the console answers Python's default user agent with
# 403 (error 1010) before the request reaches the edge; say what this is.
UA = 'thermalml-hpc-job/1.0 (+TMedge tools/thermalml)'
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
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=10) as r:
            return f'yes ({r.status})'
    except urllib.error.HTTPError as e:   # the server answered: the network path works
        return f'reachable (HTTP {e.code})'
    except Exception as e:  # noqa: BLE001 -- no answer at all
        return f'no ({type(e).__name__}: {str(e)[:80]})'


def reach_head(url: str) -> str:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA}), timeout=10) as r:
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
    print('rocm:', run(['bash', '-c', 'cat /opt/rocm/.info/version 2>/dev/null || echo none; rocminfo 2>/dev/null | grep -m1 -o "gfx[0-9a-f]*" || true']))
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

def rocm_indexes(version: str | None) -> list[str]:
    """PyTorch wheel indexes to try on an AMD/ROCm machine, newest that matches its ROCm first.

    PyPI's torch is the CUDA build. PyTorch publishes ROCm builds per ROCm
    release (download.pytorch.org/whl/rocmX.Y); the wheels carry their own
    runtime, so the closest release at or below the system's is tried first.
    """
    m = __import__('re').match(r'(\d+)\.(\d+)', version or '')
    major, minor = (int(m.group(1)), int(m.group(2))) if m else (6, 4)
    tags = [f'rocm{major}.{n}' for n in range(minor, -1, -1)]
    if major >= 7:
        tags += ['rocm6.4', 'rocm6.3', 'rocm6.2']
    return [f'https://download.pytorch.org/whl/{t}' for t in tags]


def torch_indexes() -> list[str] | None:
    """Where to get PyTorch here: THERMALML_TORCH_INDEX, the ROCm builds on an AMD machine, else PyPI (None).

    The ROCm wheels carry their own runtime, so the kernel driver's /dev/kfd
    is enough to call a machine AMD even where ROCm itself is not installed.
    """
    if os.environ.get('THERMALML_TORCH_INDEX'):
        return [os.environ['THERMALML_TORCH_INDEX']]
    version = None
    for f in ('/opt/rocm/.info/version', '/opt/rocm/.info/version-dev'):
        if os.path.exists(f):
            version = open(f).read().strip()
            break
    if version is None and not shutil.which('rocminfo') and not os.path.exists('/dev/kfd'):
        return None
    return rocm_indexes(version)


def ensure_pip(py: str) -> None:
    """pip inside the venv, bootstrapped from PyPA if the venv was made without it (or a run died half-way)."""
    if subprocess.run([py, '-m', 'pip', '--version'], capture_output=True).returncode == 0:
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], check=True)
        return
    script = os.path.join(ROOT, 'get-pip.py')
    log('installing pip into ~/thermalml/venv from bootstrap.pypa.io')
    with urllib.request.urlopen(urllib.request.Request('https://bootstrap.pypa.io/get-pip.py', headers={'User-Agent': UA}), timeout=60) as r, open(script, 'wb') as f:
        f.write(r.read())
    subprocess.run([py, script, '--quiet'], check=True)


def ensure_torch() -> None:
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import torchvision  # noqa: F401
        if STAGE in ('full', 'compare'):
            import cv2  # noqa: F401
            import ultralytics  # noqa: F401
        return
    except ImportError:
        pass
    venv = os.path.join(ROOT, 'venv')
    py = os.path.join(venv, 'bin', 'python')
    if os.path.abspath(sys.executable) == os.path.abspath(py):
        raise SystemExit('PyTorch is still missing inside ~/thermalml/venv; see the install log above')
    if not os.path.exists(py):
        log('PyTorch is not installed here; creating ~/thermalml/venv (needs the nodes to reach pypi.org)')
        if subprocess.run([sys.executable, '-m', 'venv', venv]).returncode != 0:
            # Ubuntu ships venv without ensurepip unless python3-venv is installed,
            # which needs an admin. A venv without pip, plus PyPA's own bootstrap, does not.
            log('python3-venv is not installed; making the venv without pip and bootstrapping pip')
            shutil.rmtree(venv, ignore_errors=True)
            subprocess.run([sys.executable, '-m', 'venv', '--without-pip', venv], check=True)
    ensure_pip(py)
    indexes = torch_indexes()
    if indexes is None:
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', 'numpy', 'torch', 'torchvision'], check=True)
    else:
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', 'numpy'], check=True)
        for index in indexes:
            log(f'installing PyTorch for ROCm from {index}')
            if subprocess.run([py, '-m', 'pip', 'install', '--quiet', 'torch', 'torchvision', '--index-url', index]).returncode == 0:
                break
        else:
            raise SystemExit('no PyTorch ROCm build installed; set THERMALML_TORCH_INDEX to a wheel index from pytorch.org')
    if STAGE in ('full', 'compare'):
        # Ultralytics pulls in opencv-python, whose GUI build needs libGL that a
        # server may not have; the headless build is the same library without it.
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', 'ultralytics'], check=True)
        subprocess.run([py, '-m', 'pip', 'uninstall', '--quiet', '-y', 'opencv-python'], check=False)
        subprocess.run([py, '-m', 'pip', 'install', '--quiet', '--force-reinstall', '--no-deps', 'opencv-python-headless'], check=True)
    log('re-running in ~/thermalml/venv')
    os.execv(py, [py, '-u', os.path.abspath(__file__), '--stage', STAGE] + (['--quick'] if QUICK else []))


def device() -> str:
    import torch
    cpus = int(os.environ.get('SLURM_CPUS_PER_TASK', os.cpu_count() or 1))
    torch.set_num_threads(cpus)
    if torch.cuda.is_available():
        log(f'GPU: {torch.cuda.get_device_name(0)}')
        return 'cuda'
    if os.path.exists('/dev/kfd') and not os.environ.get('THERMALML_ALLOW_CPU'):
        # An AMD GPU PyTorch cannot open would leave Faster R-CNN on the CPU for
        # a day; nobody is watching overnight, so stop and say why instead.
        raise SystemExit('this machine has an AMD GPU but PyTorch cannot use it. Usually the account is not in the '
                         f'render and video groups (sudo usermod -aG render,video {os.environ.get("USER", "<user>")}, then log in '
                         f'again); torch {torch.__version__}, HIP {getattr(torch.version, "hip", None)}. '
                         'THERMALML_ALLOW_CPU=1 runs on the CPU anyway.')
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


# --- fetch: the newest frames + pairs export, with the download key ----------

EDGE = os.environ.get('THERMALML_EDGE', 'https://algo.hkumyseat.com')
NEEDED = ('training.frames', 'training.pairs')


def keyed(path: str, key: str, extra: dict | None = None):
    req = urllib.request.Request(EDGE + '/api/ml-data/keyed' + path, headers={'Authorization': 'Bearer ' + key, 'User-Agent': UA, **(extra or {})})
    return urllib.request.urlopen(req, timeout=60)


class NotListed(SystemExit):
    """The edge did not hand over an export list: no key, a refused key, no answer, or no export of a table."""


def other_downloads() -> list[int]:
    """Process ids of other runs of this job that may be downloading into ~/thermalml/data (Linux only)."""
    found = []
    for pid in (d for d in os.listdir('/proc') if d.isdigit()) if os.path.isdir('/proc') else []:
        try:
            argv = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
        except OSError:
            continue
        if int(pid) != os.getpid() and any(a.endswith(b'hpc_job.py') for a in argv) and \
                any(a in (b'fetch', b'full', b'compare') for a in argv):
            found.append(int(pid))
    return found


def local_export() -> str | None:
    """The newest export already downloaded here. A ZIP gets its final name only after its checksum matched."""
    folder = os.path.join(ROOT, 'data')
    zips = [os.path.join(folder, f) for f in os.listdir(folder) if f.startswith('ml-data-') and f.endswith('.zip')] \
        if os.path.isdir(folder) else []
    return max(zips, key=os.path.getmtime) if zips else None


def stage_fetch() -> dict[str, str]:
    """{table: local ZIP} for training.frames and training.pairs, downloaded (resumably) and checksummed."""
    if os.environ.get('THERMALML_ZIPS'):     # rehearsal: frames=path,pairs=path instead of downloading
        given = dict(item.split('=', 1) for item in os.environ['THERMALML_ZIPS'].split(','))
        return {'training.frames': given['frames'], 'training.pairs': given['pairs']}
    # Two runs appending to the same partial download would corrupt it: a job
    # started while the download runs waits for it, then finds the file here.
    while other_downloads():
        log(f'waiting for another run of this job to finish its download or its work (process {", ".join(map(str, other_downloads()))})')
        time.sleep(300)
    try:
        return download()
    except NotListed as e:
        # Exports expire on the edge, and keys do; the copy here does not.
        have = local_export()
        if have is None:
            raise
        log(f'{e} -- using the export already downloaded here instead: {os.path.basename(have)}')
        return {table: have for table in NEEDED}


def download() -> dict[str, str]:
    key_file = os.path.join(ROOT, 'download.key')
    if not os.path.exists(key_file):
        raise NotListed('no download key: create one on the ML Data page and save it with the command shown there')
    # A paste into a terminal can bring company (page text, a second paste): use
    # the one key-shaped token in the file, and say so if there is not exactly one.
    found = sorted(set(__import__('re').findall(r'tmdata_[0-9a-f]{64}', open(key_file).read())))
    if len(found) != 1:
        raise NotListed(f'~/thermalml/download.key holds {len(found)} download keys, not 1: save the key again')
    key = found[0]
    try:
        with keyed('/exports', key) as r:
            jobs = json.load(r)['jobs']
    except urllib.error.URLError as e:
        if not isinstance(e, urllib.error.HTTPError):
            raise NotListed(f'the edge could not be reached ({e.reason})')
        if e.code == 401:
            raise NotListed('the edge refused the download key (HTTP 401): it has expired, been revoked, or was saved wrongly '
                             '(wc -c < ~/thermalml/download.key should print 71)')
        raise NotListed(f'the edge did not answer the request (HTTP {e.code}: {e.read()[:80]!r}); the key was not checked')
    done = sorted((j for j in jobs if j['state'] == 'completed'), key=lambda j: -j['createdAt'])
    picked: dict[str, dict] = {}
    for table in NEEDED:
        job = next((j for j in done if table in j['tables']), None)
        if job is None:
            raise NotListed(f'no completed export contains {table}: prepare one on the ML Data page (tick training.frames and training.pairs)')
        picked[table] = job
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    out: dict[str, str] = {}
    for table, job in picked.items():
        dest = os.path.join(ROOT, 'data', f'ml-data-{job["id"]}.zip')
        out[table] = dest
        if os.path.exists(dest) and os.path.getsize(dest) == job['bytes'] and sha256(dest) == job['sha256']:
            log(f'{table}: export {job["id"]} already here')
            continue
        part = dest + '.part'
        have = os.path.getsize(part) if os.path.exists(part) else 0
        log(f'{table}: downloading export {job["id"]} ({job["bytes"] / 1e9:.2f} GB) from {have / 1e9:.2f} GB')
        with keyed(f'/exports/{job["id"]}/download', key, {'Range': f'bytes={have}-'} if have else None) as r, open(part, 'ab') as f:
            last = time.time()
            for chunk in iter(lambda: r.read(8 << 20), b''):
                f.write(chunk)
                have += len(chunk)
                if time.time() - last > 60:
                    log(f'  {have / 1e9:.2f} / {job["bytes"] / 1e9:.2f} GB')
                    last = time.time()
        if os.path.getsize(part) != job['bytes'] or sha256(part) != job['sha256']:
            raise SystemExit(f'{table}: the download does not match the export\'s checksum; run the job again to resume')
        os.replace(part, dest)
        log(f'{table}: export {job["id"]} downloaded and verified')
    return out


# --- full: every photo, end to end ------------------------------------------

OCT_DAYS = ['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11']
TRAIN_DAYS = ['2026-10-06', '2026-10-07', '2026-10-11']
VAL_DAYS = ['2026-10-10']


def prepare(w: str, more_days: bool = False) -> tuple[dict[str, str], str, list[str]]:
    """Data, inputs, every photo's teacher boxes and labels under w, the device to train on, and the days labelled.

    Each step is skipped when its output is already there, so a job that
    was stopped resumes; Faster R-CNN also keeps its place within a day.
    With more_days, rig days after 11 Oct in the export are labelled too,
    if both cameras are where they were on 6 Oct (choose_days).
    """
    os.environ.setdefault('YOLO_CONFIG_DIR', os.path.join(ROOT, 'ultralytics'))   # its settings stay under ~/thermalml
    os.makedirs(os.environ['YOLO_CONFIG_DIR'], exist_ok=True)
    ensure_torch()
    sys.path.insert(0, CODE)
    os.chdir(CODE)                       # assets (rigs/, data/ml/...) are found relative to the code
    from tools.thermalml import __main__ as tm, dataset, labels, teachers
    zips = stage_fetch()
    d = {k: os.path.join(w, k) for k in ('shards', 'rgb', 'features', 'teachers', 'labels', 'model', 'reports')}
    for v in d.values():
        os.makedirs(v, exist_ok=True)
    if not os.listdir(d['shards']):
        log('shards: every thermal frame, per sensor per day')
        tm.main(['shards', '--dump', zips['training.frames'], '--out', d['shards']])
    days_file = os.path.join(w, 'days.json')
    chosen = json.load(open(days_file))['label'] if os.path.exists(days_file) else None
    done = lambda ds: all(os.path.exists(os.path.join(d['labels'], SENSOR, f'{day}.json')) for day in ds)
    labelled = done(chosen) if chosen else (not more_days and done(OCT_DAYS))
    if not labelled and not os.listdir(d['rgb']):
        log('photos: every one paired with a thermal frame')
        tm.main(['rgb', '--dump', zips['training.frames'], '--pairs', zips['training.pairs'], '--shards', d['shards'], '--out', d['rgb']])
    if not os.listdir(d['features']):
        log('inputs: c0/c1/c2 for every frame')
        dataset.main(['--shards', d['shards'], '--out', d['features']])
    dev = device()
    if not labelled and chosen is None:
        chosen = choose_days(d, days_file) if more_days else list(OCT_DAYS)
    chosen = chosen or list(OCT_DAYS)
    if not labelled:
        for model in TEACHER:
            log(f'teacher {model} on every October photo ({dev})')
            # Every photo (THERMALML_EVERY is only for rehearsals on a laptop).
            teachers.main(['--model', model, '--rgb', d['rgb'], '--out', d['teachers'], '--device', dev, '--batch', '16',
                           '--every', os.environ.get('THERMALML_EVERY', '1')]
                          + [x for day in chosen for x in ('--day', day)])
        log('labels: fused teacher, lit photos only, unknown outside the photo')
        labels.main(['--teacher', d['teachers'], '--models', '+'.join(TEACHER), '--mapping', 'data/ml/mapping/2ccf670bc094-oct.json',
                     '--rgb', d['rgb'], '--out', d['labels']] + [x for day in chosen for x in ('--day', day)])
        # The photos were only ever needed to make labels.
        shutil.rmtree(d['rgb'], ignore_errors=True)
        log('photos deleted: the labels are kept')
    return d, dev, chosen


def choose_days(d: dict[str, str], days_file: str) -> list[str]:
    """6-11 Oct, plus each later rig day with enough photos whose cameras have not moved; written down once."""
    from tools.thermalml import alignment, days as daymod
    folder = os.path.join(d['rgb'], SENSOR)
    found = sorted(x for x in os.listdir(folder) if __import__('re').fullmatch(r'\d{4}-\d{2}-\d{2}', x)) if os.path.isdir(folder) else []
    minimum = int(os.environ.get('THERMALML_MIN_DAY_PHOTOS', '500'))
    chosen, why = list(OCT_DAYS), {}
    for day in (x for x in found if x > OCT_DAYS[-1] and x not in daymod.LOCKED_DAYS):
        n = len(os.listdir(os.path.join(folder, day)))
        if n < minimum:
            why[day] = f'left out: {n} photos'
        else:
            ok, said = alignment.same_place(OCT_DAYS[0], day, d['rgb'], d['shards'], UID)
            why[day] = said
            if ok:
                chosen.append(day)
        log(f'{day}: {why[day]}')
    with open(days_file + '.tmp', 'w') as f:
        json.dump({'label': chosen, 'checked': why}, f, indent=1)
    os.replace(days_file + '.tmp', days_file)
    log(f'days to label: {", ".join(chosen)}')
    return chosen


def stage_full() -> None:
    w = os.path.join(ROOT, 'full')
    d, dev, _days = prepare(w)
    from tools.thermalml import evaluate, handtest, train
    model_json = os.path.join(d['model'], 'model.json')
    if not os.path.exists(model_json):
        log(f'training on {TRAIN_DAYS}, validating on {VAL_DAYS} ({dev})')
        train.main(['--labels', d['labels'], '--features', d['features'], '--shards', d['shards'], '--device', dev, '--out', d['model']]
                   + (['--epochs', '1', '--samples', '512'] if QUICK else [])
                   + [x for day in TRAIN_DAYS for x in ('--train-day', day)] + [x for day in VAL_DAYS for x in ('--val-day', day)])
    log('scoring against today\'s edge detector on the validation days')
    evaluate.main(['--labels', d['labels'], '--model', model_json, '--features', d['features'], '--shards', d['shards'],
                   '--replay', 'data/ml/replay', '--out', os.path.join(d['reports'], 'validation.json')]
                  + [x for day in VAL_DAYS for x in ('--day', day)])
    handtest.LEDGER = os.path.join(d['reports'], 'handtest-ledger.jsonl')
    model_id = json.load(open(model_json))['id']
    if not (os.path.exists(handtest.LEDGER) and model_id in open(handtest.LEDGER).read()):
        out = handtest.run(model_json, 'first every-photo model on iw-g2', mapping_path='data/ml/mapping/2ccf670bc094-sept.json',
                           labels_root='data/ml/handlabels/v1', features_root=d['features'], shards_root=d['shards'])
        with open(os.path.join(d['reports'], 'handtest.json'), 'w') as f:
            json.dump(train.finite(out), f, indent=1, allow_nan=False)
        r = out['result']['all']
        log(f'HAND TEST (400 frames, 19-Sept empty-room background): F1 {r["f1"]:.3f} {out["result"]["ci95"]["f1"]} '
            f'precision {r["precision"]:.3f} recall {r["recall"]:.3f} count error {r["countMAE"]:.3f}')
    log(f'everything is in {w}: model/model.json, reports/validation.json, reports/handtest.json')


# --- compare: job 2, two recipes on the same teacher boxes ------------------

# Decided with Kevin on 2026-10-14: recipe 2 changes two things at once, so a
# win says the pair helped, not which half; the teacher boxes stay here, so
# telling the halves apart is a training run, not another labelling.
RECIPES = {
    'recipe1': {'what': "today's recipe (job 1)", 'labels': 'labels', 'widths': '12,24,32'},
    'recipe2': {'what': 'about twice the weights, labels voted on by the photos within 3 s',
                'labels': 'labels-voted', 'widths': '16,32,48'},
}
SEEDS = (0, 1, 2)


def verdict(diff: dict) -> str:
    """The rule in docs/THERMAL_ML.md: only an interval that excludes 0 names a winner."""
    lo, hi = diff['f1ci95']
    if lo is None or hi is None or lo != lo or hi != hi:
        return 'not measured'
    return ('recipe 2 is better on the hand test' if lo > 0 else 'recipe 1 is better on the hand test' if hi < 0
            else 'no measurable difference on the 400 hand-labelled frames')


def stage_compare() -> None:
    w = os.path.join(ROOT, 'job2')
    d, dev, labelled_days = prepare(w, more_days=True)
    from tools.thermalml import evaluate, handtest, labels, train
    from tools.thermalml.metrics import paired_bootstrap
    compared, final = os.path.join(d['reports'], 'compare.json'), os.path.join(d['reports'], 'final.json')
    if os.path.exists(final):           # finished: say what it found, and leave the locked test alone
        print_compare(json.load(open(compared)), json.load(open(final)))
        return
    d['labels-voted'] = os.path.join(w, 'labels-voted')
    if not all(os.path.exists(os.path.join(d['labels-voted'], SENSOR, f'{day}.json')) for day in labelled_days):
        log('labels voted on by the photos within 3 s (recipe 2)')
        window = float(os.environ.get('THERMALML_VOTE_S', labels.VOTE_WINDOW_S))   # wider only in rehearsals on every n-th photo
        for line in labels.vote_build(d['labels'], d['shards'], UID, labelled_days, d['labels-voted'], window):
            log(line)
    # Days after 11 Oct that passed the camera check train both recipes; 10 Oct stays the check day.
    train_days = TRAIN_DAYS + [x for x in labelled_days if x not in OCT_DAYS]
    handtest.LEDGER = os.path.join(d['reports'], 'handtest-ledger.jsonl')
    ht = dict(mapping_path='data/ml/mapping/2ccf670bc094-sept.json', labels_root='data/ml/handlabels/v1',
              features_root=d['features'], shards_root=d['shards'])

    if os.path.exists(compared):
        report = json.load(open(compared))
    else:
        runs: dict[str, list[dict]] = {}
        for name, r in RECIPES.items():
            runs[name] = []
            for seed in SEEDS:
                out = os.path.join(w, 'models', name, f'seed{seed}')
                model_json = os.path.join(out, 'model.json')
                if not os.path.exists(model_json):
                    log(f'{name} ({r["what"]}), run {seed + 1} of {len(SEEDS)} ({dev})')
                    t0 = time.time()
                    train.main(['--labels', d[r['labels']], '--features', d['features'], '--shards', d['shards'], '--device', dev,
                                '--out', out, '--widths', r['widths'], '--seed', str(seed)]
                               + (['--epochs', '1', '--samples', '512'] if QUICK else [])
                               + [x for day in train_days for x in ('--train-day', day)] + [x for day in VAL_DAYS for x in ('--val-day', day)])
                    log(f'{name} run {seed + 1}: {(time.time() - t0) / 60:.1f} min')
                m = json.load(open(model_json))
                v = m['metrics']['validation']
                runs[name].append({'seed': seed, 'model': model_json, 'id': m['id'], 'weights': m.get('weights'),
                                   'validationF1': v['f1'], 'epoch': v['epoch'], 'epochs': m.get('epochs'), 'threshold': m['threshold']})

        # Each recipe keeps the run its own validation day prefers, as it would in production.
        pick = {name: max(rs, key=lambda x: x['validationF1'] if x['validationF1'] is not None else -1) for name, rs in runs.items()}
        report = {'recipes': {}, 'trainDays': train_days, 'valDays': VAL_DAYS, 'rule': 'docs/THERMAL_ML.md#job-2-two-recipes-compared'}
        for name, r in RECIPES.items():
            p = pick[name]
            row = {'what': r['what'], 'widths': r['widths'], 'weights': p['weights'], 'runs': runs[name], 'picked': p, 'validation': {}}
            # Scored against both label sets: each recipe is favoured by its own, so neither alone decides.
            for lab in ('labels', 'labels-voted'):
                dest = os.path.join(d['reports'], f'validation-{name}-on-{lab}.json')
                evaluate.main(['--labels', d[lab], '--model', p['model'], '--features', d['features'], '--shards', d['shards'],
                               '--replay', 'data/ml/replay', '--out', dest] + [x for day in VAL_DAYS for x in ('--day', day)])
                row['validation'][lab] = json.load(open(dest))['days']
            report['recipes'][name] = row
        frames = {}
        for name in RECIPES:
            frames[name] = []
            out = handtest.run(pick[name]['model'], f'job 2: {name}, the run its validation day picked', frames_out=frames[name], **ht)
            report['recipes'][name]['handTest'] = out['result']
        report['handTestDifference'] = paired_bootstrap(frames['recipe1'], frames['recipe2'])
        report['verdict'] = verdict(report['handTestDifference'])
        with open(compared + '.tmp', 'w') as f:
            json.dump(train.finite(report), f, indent=1, allow_nan=False)
        os.replace(compared + '.tmp', compared)
        print_compare(report)

    # The most accurate model the data allows: the winner, retrained on every labelled
    # day (10 Oct included), kept at the epoch and threshold its validation chose.
    # Without a measurable winner the smaller recipe 1 goes on: it costs the edge half as much.
    winner = 'recipe2' if (report.get('verdict') or verdict(report['handTestDifference'])).startswith('recipe 2') else 'recipe1'
    p, r = report['recipes'][winner]['picked'], RECIPES[winner]
    all_days = [x for x in labelled_days if x in TRAIN_DAYS + VAL_DAYS or x not in OCT_DAYS]
    out = os.path.join(w, 'models', 'final')
    if not os.path.exists(os.path.join(out, 'model.json')):
        log(f'final model: {winner} retrained on {", ".join(all_days)}, kept at epoch {p["epoch"]}, threshold {p["threshold"]} ({dev})')
        t0 = time.time()
        train.main(['--labels', d[r['labels']], '--features', d['features'], '--shards', d['shards'], '--device', dev, '--out', out,
                    '--widths', r['widths'], '--seed', str(p['seed']), '--keep-epoch', str(p['epoch']), '--threshold', str(p['threshold'])]
                   + (['--epochs', '1', '--samples', '512'] if QUICK else ['--epochs', str(p['epochs'] or 25)])
                   + [x for day in all_days for x in ('--train-day', day)])
        log(f'final model: {(time.time() - t0) / 60:.1f} min')
    model_json = os.path.join(out, 'model.json')
    res = handtest.run(model_json, f'job 2: final model ({winner} on every labelled day); the recipe was chosen with this test', **ht)
    fin = {'recipe': winner, 'why': report.get('verdict') or verdict(report['handTestDifference']), 'days': all_days, 'model': model_json, 'id': json.load(open(model_json))['id'],
           'keptEpoch': p['epoch'], 'threshold': p['threshold'], 'handTest': res['result'],
           'caveat': 'The hand test also chose the recipe, so this score is slightly optimistic; 10 Oct was trained on, so there is no check day left.'}
    with open(final + '.tmp', 'w') as f:
        json.dump(train.finite(fin), f, indent=1, allow_nan=False)
    os.replace(final + '.tmp', final)
    print_compare(report, fin)
    log(f'everything is in {w}: reports/compare.json, reports/final.json, models/final/model.json')


def print_compare(report: dict, fin: dict | None = None) -> None:
    fmt = lambda v: '-' if v is None or v != v else f'{v:.3f}'
    signed = lambda v: '-' if v is None or v != v else f'{v:+.3f}'
    ci = lambda c: f'[{fmt(c[0])}, {fmt(c[1])}]'
    log('== JOB 2 RESULTS: two recipes, the same teacher boxes ==')
    print(f'trained on {", ".join(report["trainDays"])}; checked on {", ".join(report["valDays"])}')
    for name, row in report['recipes'].items():
        h, hc = row['handTest']['all'], row['handTest']['ci95']
        empty = row['handTest']['byTrueCount'].get('0', {}).get('falsePerFrame')
        p = row['picked']
        print(f'{name}: {row["what"]}; {row["weights"]} weights')
        print(f'  validation F1 of its {len(row["runs"])} runs: {", ".join(fmt(x["validationF1"]) for x in row["runs"])} '
              f'-> kept run {p["seed"] + 1} (best at epoch {p.get("epoch")} of {p.get("epochs")}'
              + ('; still improving at the end: longer training may help' if p.get('epoch') and p.get('epochs') and p['epoch'] >= p['epochs'] - 2 else '')
              + ')')
        for lab, days_ in row['validation'].items():
            for day, v in days_.items():
                print(f'  {day} against {lab}: F1 {fmt(v["model"]["all"]["f1"])} {ci(v["model"]["ci95"]["f1"])}, '
                      f'count error {fmt(v["model"]["all"]["countMAE"])} (edge detector F1 {fmt(v["edge"]["all"]["f1"])})')
        print(f'  HAND TEST: F1 {fmt(h["f1"])} {ci(hc["f1"])}, precision {fmt(h["precision"])}, recall {fmt(h["recall"])}, '
              f'count error {fmt(h["countMAE"])}, false people per empty frame {fmt(empty)}')
    diff = report['handTestDifference']
    print(f'recipe 2 minus recipe 1 on the hand test: F1 {signed(diff["f1"])} {ci(diff["f1ci95"])}, '
          f'count error {signed(diff["countMAE"])} {ci(diff["countMAEci95"])} (paired, {diff["blocks"]} ten-minute blocks)')
    log(f'VERDICT: {report.get("verdict") or verdict(diff)}')
    if fin:
        h, hc = fin['handTest']['all'], fin['handTest']['ci95']
        log(f'FINAL MODEL ({fin["recipe"]} on {", ".join(fin["days"])}): HAND TEST F1 {fmt(h["f1"])} {ci(hc["f1"])}, '
            f'precision {fmt(h["precision"])}, recall {fmt(h["recall"])}, count error {fmt(h["countMAE"])}')
        print(f'  ({fin["caveat"]})')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', required=True, choices=('check', 'stage', 'label', 'train', 'all', 'fetch', 'full', 'compare'))
    ap.add_argument('--quick', action='store_true', help='rehearsal: one short training epoch')
    a = ap.parse_args()
    global STAGE, QUICK
    STAGE, QUICK = a.stage, a.quick
    t0 = time.time()
    if a.stage in ('check', 'all', 'full', 'compare'):
        stage_check()
    if a.stage == 'fetch':
        stage_fetch()
    if a.stage == 'full':
        stage_full()
    if a.stage == 'compare':
        stage_compare()
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
