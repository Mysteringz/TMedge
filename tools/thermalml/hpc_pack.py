"""
Uploads for running the labelling and training on iw-g2 through algo console module 02.

    python3 -m tools.thermalml.hpc_pack --out data/ml/hpc/<bundle>

Module 02 takes one zip per job: at most 95 MB, 5,000 entries and 1 GB
unpacked, and every job runs as the shared cluster account in
~/hpc-dash/jobs/<id>/code. So the work is cut into zips that each carry the
code (tools/thermalml + hpc_job.py) and one piece of data; a data job copies
its piece into ~/thermalml/stage/<bundle>/, and the main job reads from there.

    code-and-pack.zip    the training pack: every sampled October frame's
                         inputs (c0/c1/c2), the boxes the Mac already has,
                         photo brightness, and today's edge detector's points
    photos-<day>-<n>.zip RGB photos still to be read by Faster R-CNN, as tars
                         (one entry each, under the 5,000-entry limit)
    README.txt           what to upload, in which order, with which settings

Nothing here leaves the team: the zips go only to module 02.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import io
import json
import os
import subprocess
import tarfile
import zipfile

import numpy as np

from . import days
from .dataset import load as load_features
from .rgb import read_pairs_index
from .shards import read_shard, sensor_dir

UID = '2c:cf:67:0b:c0:94'
DAYS = ['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11']
TRAIN_DAYS = ['2026-10-06', '2026-10-07', '2026-10-11']
VAL_DAYS = ['2026-10-10']
EVERY = 5
PART_BYTES = 85 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def sampled_rids(rgb_root: str, day: str) -> list[str]:
    """The photos teachers.py --every 5 reads: every fifth by name."""
    return [f[:-4] for f in sorted(os.listdir(os.path.join(rgb_root, sensor_dir(UID), day))) if f.endswith('.jpg')][::EVERY]


def brightness(path: str) -> float:
    import cv2
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    return float(img.mean()) if img is not None else 0.0


def build_pack(out: str, rgb_root: str, teachers_root: str, replay_root: str, features_root: str, shards_root: str,
               mapping: str) -> dict:
    pack = os.path.join(out, 'pack')
    os.makedirs(pack, exist_ok=True)
    summary = {}
    for day in DAYS:
        days.assert_trainable([day])
        pairs = read_pairs_index(rgb_root, UID, day)
        tid_of = {p['rgb']: tid for tid, p in pairs.items()}
        shard = read_shard(shards_root, UID, day)
        index = {tid: i for i, tid in enumerate(shard.ids)}
        feats = load_features(features_root, UID, day)
        replay = json.load(open(os.path.join(replay_root, sensor_dir(UID), f'{day}.edge.json')))
        rep_index = {t: i for i, t in enumerate(replay['at'])}
        rows = [(rid, tid_of[rid]) for rid in sampled_rids(rgb_root, day) if rid in tid_of and tid_of[rid] in index]
        idx = [index[tid] for _rid, tid in rows]
        teachers = {}
        for model in ('yolo11s', 'yolo26s', 'fasterrcnn_v2'):
            path = os.path.join(teachers_root, model, sensor_dir(UID), f'{day}.json')
            if os.path.exists(path):
                boxes = json.load(open(path))['boxes']
                teachers[model] = {rid: boxes[rid] for rid, _tid in rows if rid in boxes}
        folder = os.path.join(rgb_root, sensor_dir(UID), day)
        np.savez_compressed(os.path.join(pack, f'{day}.npz'), x=feats['x'][idx], xthin=feats['xthin'][idx],
                            ready=feats['ready'][idx], at=feats['at'][idx])
        meta = {
            'day': day, 'tid': [tid for _r, tid in rows], 'rid': [rid for rid, _t in rows],
            'bright': [round(brightness(os.path.join(folder, f'{rid}.jpg')), 2) for rid, _t in rows],
            'teachers': teachers,
            'edge': [[[d[0], d[1]] for d in replay['dets'][rep_index[int(feats['at'][i])]]] if replay['ready'][rep_index[int(feats['at'][i])]] else []
                     for i in idx],
        }
        with open(os.path.join(pack, f'{day}.json'), 'w') as f:
            json.dump(meta, f, separators=(',', ':'))
        summary[day] = {'frames': len(rows), 'teachers': sorted(teachers)}
    with open(os.path.join(pack, 'mapping.json'), 'w') as f:
        json.dump(json.load(open(mapping)), f)
    commit = subprocess.run(['git', '-C', REPO, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    with open(os.path.join(pack, 'meta.json'), 'w') as f:
        json.dump({'uid': UID, 'days': DAYS, 'trainDays': TRAIN_DAYS, 'valDays': VAL_DAYS, 'every': EVERY, 'commit': commit,
                   'teacher': 'yolo11s+yolo26s+fasterrcnn_v2', 'summary': summary}, f, indent=1)
    return summary


def code_files() -> list[tuple[str, str]]:
    """(archive path, local path) for the code every zip carries."""
    files = [('hpc_job.py', os.path.join(HERE, 'hpc_job.py'))]
    for f in sorted(os.listdir(HERE)):
        if f.endswith('.py') and not f.startswith('test_') and f != 'hpc_job.py':
            files.append((f'tools/thermalml/{f}', os.path.join(HERE, f)))
    return files


def write_zip(path: str, extra: list[tuple[str, bytes | str]]) -> int:
    """A module 02 upload: code, plus `extra` as (archive path, bytes or local file path)."""
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for arc, local in code_files():
            z.write(local, arc)
        for arc, data in extra:
            if isinstance(data, bytes):
                z.writestr(arc, data)
            else:
                z.write(data, arc, compress_type=zipfile.ZIP_STORED)
    size = os.path.getsize(path)
    if size > 95 * 1024 * 1024:
        raise SystemExit(f'{path} is {size / 1e6:.0f} MB, over module 02\'s 95 MB limit')
    with zipfile.ZipFile(path) as z:
        if len(z.infolist()) > 5000:
            raise SystemExit(f'{path} has {len(z.infolist())} entries, over the 5,000 limit')
    return size


def photo_parts(rgb_root: str, day: str, rids: list[str]) -> list[bytes]:
    """Tars of a day's photos, each under PART_BYTES."""
    parts, buf, tar, used = [], None, None, 0
    folder = os.path.join(rgb_root, sensor_dir(UID), day)
    for rid in rids:
        path = os.path.join(folder, f'{rid}.jpg')
        size = os.path.getsize(path) + 1024
        if tar is None or used + size > PART_BYTES:
            if tar is not None:
                tar.close()
                parts.append(buf.getvalue())
            buf, used = io.BytesIO(), 0
            tar = tarfile.open(fileobj=buf, mode='w')
        tar.add(path, arcname=f'{sensor_dir(UID)}/{day}/{rid}.jpg')
        used += size
    if tar is not None:
        tar.close()
        parts.append(buf.getvalue())
    return parts


def full_zip(out: str) -> str:
    """The one upload the every-photo run needs: code, mappings, the edge baseline, the hand labels' text."""
    extra: list[tuple[str, bytes | str]] = [('BUNDLE', b'full')]
    assets = ['rigs/intern-demo/empty_bg_rel.npy', 'data/ml/mapping/2ccf670bc094-oct.json', 'data/ml/mapping/2ccf670bc094-sept.json']
    for day in ['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11']:
        assets.append(f'data/ml/replay/{sensor_dir(UID)}/{day}.edge.json')
    for rel in assets:
        extra.append((rel, os.path.join(REPO, rel)))
    for lab in sorted(glob.glob(os.path.join(REPO, 'data/ml/handlabels/v1/*/labels/*.txt'))):
        extra.append((os.path.relpath(lab, REPO), lab))
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'thermalml-full.zip')
    size = write_zip(path, extra)
    readme = ['Every-photo run on iw-g2 (module 02). One upload, one job.', '',
              'Before: on the ML Data page, prepare an export with training.frames AND training.pairs ticked,',
              'and create a download key (Download keys for training jobs); save it on iw-g2 with the command shown.', '',
              f'Upload thermalml-full.zip ({size / 1e6:.1f} MB) as a new draft and set:',
              '  entrypoint  hpc_job.py', '  args        --stage full', '  partition   debug',
              '  CPUs 56 (the debug partition allows 60)  memory 32 GB  GPUs 0  time 1-00:00:00   (GPUs 1 and time 08:00:00 once iw-g2 has been restarted)', '',
              'Run it. It resumes where it stopped if run again. Paste the end of its log back to Claude.', '',
              'On a plain Linux machine with a GPU (no SLURM; AMD/ROCm or NVIDIA), e.g. a team member\'s PC:',
              '  mkdir -p ~/thermalml/job && cd ~/thermalml/job && unzip -o /path/to/thermalml-full.zip',
              "  read -rs -p 'Download key: ' K && (umask 077; printf %s \"$K\" > ~/thermalml/download.key) && unset K && echo && echo saved",
              '  tmux new -s thermalml          # so closing the terminal does not stop it (Ctrl-b d to leave it running)',
              '  python3 -u hpc_job.py --stage full 2>&1 | tee -a ~/thermalml/full.log',
              'It installs the ROCm build of PyTorch by itself on an AMD machine. Check progress any time with:',
              '  tail -n 20 ~/thermalml/full.log', '',
              'Job 2 (two recipes compared on the same teacher boxes; docs/THERMAL_ML.md) on such a PC, in the background:',
              '  cd ~/thermalml/job && setsid nohup python3 -u hpc_job.py --stage compare >> ~/thermalml/job2.log 2>&1 < /dev/null &',
              'It waits for a download already running, and uses the downloaded export once the edge no longer lists it.',
              '  tail -n 40 ~/thermalml/job2.log     # progress; the comparison is printed at the end']
    with open(os.path.join(out, 'README.txt'), 'w') as f:
        f.write('\n'.join(readme) + '\n')
    print('\n'.join(readme))
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml.hpc_pack')
    p.add_argument('--out', required=True)
    p.add_argument('--rgb', default='data/ml/rgb')
    p.add_argument('--teachers', default='data/ml/teachers-coco-sample5')
    p.add_argument('--replay', default='data/ml/replay')
    p.add_argument('--features', default='data/ml/features')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--mapping', default='data/ml/mapping/2ccf670bc094-oct.json')
    p.add_argument('--limit', type=int, help='rehearsal bundle: at most this many photos per day to label')
    p.add_argument('--full', action='store_true', help='the every-photo upload (data fetched with a download key)')
    a = p.parse_args(argv)
    if a.full:
        full_zip(a.out)
        return 0
    bundle = os.path.basename(os.path.normpath(a.out))
    os.makedirs(a.out, exist_ok=True)
    summary = build_pack(a.out, a.rgb, a.teachers, a.replay, a.features, a.shards, a.mapping)

    uploads = []
    # The pack is split by day so no upload passes 85 MB; staging merges the pieces.
    pdir = os.path.join(a.out, 'pack')
    groups: list[list[str]] = [['mapping.json', 'meta.json']]
    used = [sum(os.path.getsize(os.path.join(pdir, f)) for f in groups[0])]
    for day in DAYS:
        files = [f'{day}.npz', f'{day}.json']
        size = sum(os.path.getsize(os.path.join(pdir, f)) for f in files)
        k = next((i for i, u in enumerate(used) if u + size <= PART_BYTES), None)
        if k is None:
            groups.append([])
            used.append(0)
            k = len(groups) - 1
        groups[k] += files
        used[k] += size
    for n, files in enumerate(groups, 1):
        name = f'code-and-pack-{n}.zip'
        size = write_zip(os.path.join(a.out, name), [('BUNDLE', bundle.encode())] + [(f'pack/{f}', os.path.join(pdir, f)) for f in files])
        days_in = sorted({f.split('.')[0] for f in files if f.startswith('2026')})
        uploads.append((name, size, 'stage', 'training pack: ' + (', '.join(days_in) or 'mapping') + (' + mapping' if n == 1 else '')))

    missing = [d for d in DAYS if 'fasterrcnn_v2' not in summary[d]['teachers']]
    for day in missing:
        for n, tar in enumerate(photo_parts(a.rgb, day, sampled_rids(a.rgb, day)[:a.limit]), 1):
            name = f'photos-{day}-{n}.zip'
            manifest = json.dumps({'file': f'data/photos-{day}-{n}.tar', 'sha256': hashlib.sha256(tar).hexdigest()}).encode()
            size = write_zip(os.path.join(a.out, name), [('BUNDLE', bundle.encode()), (f'data/photos-{day}-{n}.tar', tar),
                                                         ('data/manifest.json', manifest)])
            uploads.append((name, size, 'stage', f'copies {day} photos (part {n}) into ~/thermalml/stage/{bundle}'))

    readme = [f'Bundle {bundle}: run the thermal people-detector labelling and training on iw-g2 (module 02).', '',
              'Every zip below is one module 02 job. In 02 ML Training: New draft -> upload the zip -> set:',
              '  entrypoint  hpc_job.py', '  partition   debug', '',
              '1. Environment check first (any zip; a minute, CPU only):',
              '     args: --stage check      CPUs 2  memory 4 GB  GPUs 0  time 00:10:00',
              '   Paste the job log back to Claude: it says whether PyTorch/CUDA exist and whether the nodes reach the internet.', '',
              '2. Stage every zip (each a short CPU job):', '     args: --stage stage      CPUs 1  memory 2 GB  GPUs 0  time 00:15:00']
    for name, size, _stage, what in uploads:
        readme.append(f'     {name:28} {size / 1e6:5.1f} MB  {what}')
    readme += ['', '3. The work (upload code-and-pack-2.zip again as a new job, or reuse that job as a template):',
               '     args: --stage all        CPUs 48  memory 32 GB  GPUs 0  time 08:00:00',
               '   (GPUs 0 while iw-g2 needs its restart -- nvidia-smi fails there; after the restart use GPUs 1, time 03:00:00)',
               '   It sets up PyTorch if needed, reads the photos with Faster R-CNN, builds the labels, trains the',
               '   thermal model (train ' + ', '.join(TRAIN_DAYS) + '; validate ' + ', '.join(VAL_DAYS) + '), scores it against',
               '   today\'s edge detector, and prints the results. Everything it writes is under ~/thermalml/out/' + bundle + '.', '']
    with open(os.path.join(a.out, 'README.txt'), 'w') as f:
        f.write('\n'.join(readme))
    print('\n'.join(readme))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
