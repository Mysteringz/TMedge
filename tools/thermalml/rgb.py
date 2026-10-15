"""
The rig's RGB photos, pulled out of the frames export next to their thermal frame.

RGB is only ever used to make labels: a detector looks at the photo, and what
it finds is mapped into the thermal frame it was paired with. So only photos
that `training.pairs` ties to a thermal frame are extracted, filed under the
same sensor and day as that thermal frame's shard:

    <out>/[locked/]<uid without colons>/<day>/<rgb id>.jpg
    <out>/[locked/]<uid without colons>/<day>.pairs.json   {thermal id: {rgb, skewMs, mirror}}
"""
from __future__ import annotations

import json
import os
from typing import Iterable

from . import days
from .copydump import bytea, iter_copy, unescape
from .shards import list_shards, read_shard, sensor_dir


def load_pairs(lines: Iterable[bytes]) -> dict[str, dict]:
    """rgb id -> {thermal, skewMs, mirror} from the `training.pairs` COPY block."""
    out = {}
    for r in iter_copy(lines, 'training.pairs'):
        rgb = unescape(r['rgb_id']) or ''
        out[rgb] = {'thermal': unescape(r['thermal_id']) or '', 'skewMs': int(unescape(r['skew_ms']) or 0),
                    'mirror': unescape(r['mirror']) == 't'}
    return out


def thermal_days(shards_root: str) -> dict[str, tuple[str, str]]:
    """thermal frame id -> (sensor, day) for every shard, locked ones included."""
    where = {}
    for uid, day in list_shards(shards_root, include_locked=True):
        for fid in read_shard(shards_root, uid, day).ids:
            where[fid] = (uid, day)
    return where


def day_dir(out: str, uid: str, day: str) -> str:
    base = os.path.join(out, 'locked') if days.is_locked(day) else out
    return os.path.join(base, sensor_dir(uid), day)


def extract(frames_lines: Iterable[bytes], pairs: dict[str, dict], where: dict[str, tuple[str, str]], out: str,
            only_days: set[str] | None = None) -> dict[tuple[str, str], int]:
    index: dict[tuple[str, str], dict[str, dict]] = {}
    for r in iter_copy(frames_lines, 'training.frames'):
        if r['modality'] != b'rgb':
            continue
        rid = unescape(r['id']) or ''
        p = pairs.get(rid)
        if not p or p['thermal'] not in where:
            continue
        uid, day = where[p['thermal']]
        if only_days and day not in only_days:
            continue
        jpeg = bytea(r['payload'])
        if not jpeg or jpeg[:2] != b'\xff\xd8':
            raise ValueError(f'rgb frame {rid} is not a JPEG')
        d = day_dir(out, uid, day)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{rid}.jpg'), 'wb') as f:
            f.write(jpeg)
        index.setdefault((uid, day), {})[p['thermal']] = {'rgb': rid, 'skewMs': p['skewMs'], 'mirror': p['mirror']}
    for (uid, day), entries in index.items():
        path = day_dir(out, uid, day) + '.pairs.json'
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w') as f:
            json.dump(entries, f, separators=(',', ':'))
        os.replace(tmp, path)
    return {k: len(v) for k, v in index.items()}


def read_pairs_index(out: str, uid: str, day: str) -> dict[str, dict]:
    with open(day_dir(out, uid, day) + '.pairs.json') as f:
        return json.load(f)
