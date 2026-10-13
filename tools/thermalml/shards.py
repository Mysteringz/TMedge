"""
One file per sensor per day: every thermal frame, small enough to load whole.

The frames table is mostly JPEG; its thermal part is ~170 MB for everything
recorded so far. A shard keeps that part in a form both Python (training) and
Node (replaying the edge's own detector) read with their standard libraries:

    <root>/<uid without colons>/<day>.thermal.gz   N x 768 bytes, row-major 24x32
    <root>/<uid without colons>/<day>.json         the index: times, scaling, ids

Temperature in C is tMin + byte * step, exactly as on the wire. Days in
days.LOCKED_DAYS are written under <root>/locked/ instead, so listing the
training shards cannot pick them up by mistake.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Iterator

import numpy as np

from . import days
from .copydump import bytea, iter_copy, unescape

SHARD_VERSION = 1
W, H = 32, 24
FRAME_BYTES = W * H


@dataclass
class ThermalRow:
    id: str
    sensor: str
    frame: int | None
    at: int                      # reference_at, ms since epoch
    basis: str
    pixels: bytes                # 768
    t_min: float
    step: float
    observed: list | None        # the node's own detections, legacy pairs only
    metadata: dict


@dataclass
class DayShard:
    sensor: str
    day: str
    at: np.ndarray               # int64 ms, ascending
    frame: list[int | None]
    t_min: np.ndarray            # float64
    step: np.ndarray             # float64
    ids: list[str]
    pixels: np.ndarray           # uint8 (N, 24, 32)
    observed: list[list | None]
    poses: list[dict] = field(default_factory=list)
    basis: dict[str, int] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)

    @property
    def locked(self) -> bool:
        return days.is_locked(self.day)

    def __len__(self) -> int:
        return int(self.at.size)

    def temps(self) -> np.ndarray:
        """All frames in C, float32 (N, 24, 32), computed the way the edge's rawTemps does."""
        t = self.t_min[:, None, None] + self.pixels.astype(np.float64) * self.step[:, None, None]
        return t.astype(np.float32)


def sensor_dir(uid: str) -> str:
    return uid.replace(':', '')


def shard_paths(root: str, uid: str, day: str) -> tuple[str, str]:
    base = os.path.join(root, 'locked') if days.is_locked(day) else root
    d = os.path.join(base, sensor_dir(uid))
    return os.path.join(d, f'{day}.thermal.gz'), os.path.join(d, f'{day}.json')


def _atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def write_shard(root: str, s: DayShard) -> tuple[str, str]:
    n = len(s)
    if s.pixels.shape != (n, H, W) or s.pixels.dtype != np.uint8:
        raise ValueError('pixels must be uint8 (N, 24, 32)')
    raw = np.ascontiguousarray(s.pixels).tobytes()
    gz_path, idx_path = shard_paths(root, s.sensor, s.day)
    index = {
        'version': SHARD_VERSION,
        'sensor': s.sensor,
        'day': s.day,
        'locked': s.locked,
        'dayStartMs': days.day_start_ms(s.day),
        'count': n,
        'payloadSha256': hashlib.sha256(raw).hexdigest(),
        'at': [int(v) for v in s.at],
        'frame': s.frame,
        'tMin': [float(v) for v in s.t_min],
        'step': [float(v) for v in s.step],
        'id': s.ids,
        'observed': s.observed,
        'poses': s.poses,
        'basis': s.basis,
        'source': s.source,
    }
    # mtime=0 so the same frames always give the same bytes.
    _atomic_write(gz_path, gzip.compress(raw, compresslevel=6, mtime=0))
    _atomic_write(idx_path, json.dumps(index, separators=(',', ':')).encode())
    return gz_path, idx_path


def read_shard(root: str, uid: str, day: str) -> DayShard:
    gz_path, idx_path = shard_paths(root, uid, day)
    with open(idx_path, 'rb') as f:
        index = json.load(f)
    if index.get('version') != SHARD_VERSION:
        raise ValueError(f'{idx_path}: unsupported shard version {index.get("version")}')
    with open(gz_path, 'rb') as f:
        raw = gzip.decompress(f.read())
    n = index['count']
    if len(raw) != n * FRAME_BYTES or hashlib.sha256(raw).hexdigest() != index['payloadSha256']:
        raise ValueError(f'{gz_path}: pixels do not match the index')
    for key in ('at', 'frame', 'tMin', 'step', 'id', 'observed'):
        if len(index[key]) != n:
            raise ValueError(f'{idx_path}: {key} has {len(index[key])} entries, expected {n}')
    return DayShard(
        sensor=index['sensor'], day=index['day'],
        at=np.asarray(index['at'], dtype=np.int64),
        frame=index['frame'],
        t_min=np.asarray(index['tMin'], dtype=np.float64),
        step=np.asarray(index['step'], dtype=np.float64),
        ids=index['id'],
        pixels=np.frombuffer(raw, dtype=np.uint8).reshape(n, H, W),
        observed=index['observed'], poses=index['poses'], basis=index['basis'], source=index['source'],
    )


def list_shards(root: str, include_locked: bool = False) -> list[tuple[str, str]]:
    """(uid, day) for every shard under root, oldest first. Locked days only when asked."""
    found: list[tuple[str, str]] = []
    bases = [root] + ([os.path.join(root, 'locked')] if include_locked else [])
    for base in bases:
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            d = os.path.join(base, name)
            if name == 'locked' or not os.path.isdir(d):
                continue
            for f in sorted(os.listdir(d)):
                if not f.endswith('.json'):
                    continue
                with open(os.path.join(d, f), 'rb') as fh:
                    idx = json.load(fh)
                found.append((idx['sensor'], idx['day']))
    found.sort(key=lambda p: (p[1], p[0]))
    if not include_locked:
        days.assert_trainable({d for _, d in found})
    return found


def _ms(ts: str) -> int:
    # pg_dump writes '2026-09-26 03:55:53.459+00'.
    s = ts.replace(' ', 'T')
    if s[-3] in '+-':
        s += ':00'
    return int(round(datetime.fromisoformat(s).timestamp() * 1000))


def thermal_rows_from_dump(lines: Iterable[bytes]) -> Iterator[ThermalRow]:
    """Thermal rows of `training.frames`; RGB rows are skipped without decoding their JPEG."""
    for r in iter_copy(lines, 'training.frames'):
        if r['modality'] != b'thermal':
            continue
        if r['encoding'] != b'thermal_u8' or r['width'] != b'32' or r['height'] != b'24':
            raise ValueError(f'unexpected thermal frame shape in row {unescape(r["id"])}')
        pixels = bytea(r['payload'])
        if pixels is None or len(pixels) != FRAME_BYTES:
            raise ValueError(f'thermal payload is not 768 bytes in row {unescape(r["id"])}')
        frame = unescape(r['frame_number'])
        observed = unescape(r['observed'])
        yield ThermalRow(
            id=unescape(r['id']) or '',
            sensor=unescape(r['sensor_uid']) or '',
            frame=int(frame) if frame is not None else None,
            at=_ms(unescape(r['reference_at']) or ''),
            basis=unescape(r['timestamp_basis']) or '',
            pixels=pixels,
            t_min=float(unescape(r['t_min']) or 'nan'),
            step=float(unescape(r['t_step']) or 'nan'),
            observed=json.loads(observed) if observed is not None else None,
            metadata=json.loads(unescape(r['metadata']) or '{}'),
        )


def thermal_rows_from_db(url: str, start_ms: int, end_ms: int, sensor: str | None = None) -> Iterator[ThermalRow]:
    """The same rows read live through the reader role (TRAINING_DATABASE_URL)."""
    import psycopg  # only needed for this path

    sql = ('SELECT id, sensor_uid, frame_number, reference_at, timestamp_basis, payload, t_min, t_step, '
           'observed, metadata FROM training.frames WHERE modality = %s AND reference_at >= to_timestamp(%s) '
           'AND reference_at < to_timestamp(%s)' + (' AND sensor_uid = %s' if sensor else '') +
           ' ORDER BY sensor_uid, reference_at')
    params: list[Any] = ['thermal', start_ms / 1000, end_ms / 1000] + ([sensor] if sensor else [])
    with psycopg.connect(url) as conn:
        conn.read_only = True
        with conn.cursor(name='thermalml_frames') as cur:
            cur.itersize = 5000
            cur.execute(sql, params)
            for (fid, uid, frame, ref, basis, payload, t_min, step, observed, metadata) in cur:
                yield ThermalRow(id=fid, sensor=uid, frame=frame, at=int(round(ref.timestamp() * 1000)), basis=basis,
                                 pixels=bytes(payload), t_min=float(t_min), step=float(step),
                                 observed=observed, metadata=metadata or {})


def _pose_of(meta: dict) -> dict:
    """Where the sensor hung when the frame was taken, as the edge recorded it."""
    rec = meta.get('source_record') or {}
    inner = rec.get('metadata') or {}
    if inner:
        return {'pose': inner.get('pose'), 'floorId': inner.get('floorId'), 'detector': inner.get('detector')}
    if 'mirror' in rec:
        return {'pose': {'mirror': rec['mirror']}, 'floorId': None, 'detector': None}
    return {'pose': None, 'floorId': None, 'detector': None}


def build_shards(rows: Iterable[ThermalRow], root: str, source: dict[str, Any] | None = None,
                 sensors: set[str] | None = None) -> list[dict[str, Any]]:
    """Group rows by sensor and day, sort, drop repeated ids, and write one shard each."""
    groups: dict[tuple[str, str], dict[str, ThermalRow]] = {}
    for row in rows:
        if sensors and row.sensor not in sensors:
            continue
        groups.setdefault((row.sensor, days.day_of(row.at)), {})[row.id] = row
    written = []
    for (uid, day), by_id in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        ordered = sorted(by_id.values(), key=lambda r: (r.at, r.frame if r.frame is not None else -1, r.id))
        poses: list[dict] = []
        basis: dict[str, int] = {}
        for r in ordered:
            p = _pose_of(r.metadata)
            if poses and poses[-1]['pose'] == p['pose'] and poses[-1]['floorId'] == p['floorId'] \
                    and poses[-1]['detector'] == p['detector']:
                poses[-1]['toMs'] = r.at
            else:
                poses.append({'fromMs': r.at, 'toMs': r.at, **p})
            basis[r.basis] = basis.get(r.basis, 0) + 1
        shard = DayShard(
            sensor=uid, day=day,
            at=np.asarray([r.at for r in ordered], dtype=np.int64),
            frame=[r.frame for r in ordered],
            t_min=np.asarray([r.t_min for r in ordered], dtype=np.float64),
            step=np.asarray([r.step for r in ordered], dtype=np.float64),
            ids=[r.id for r in ordered],
            pixels=np.frombuffer(b''.join(r.pixels for r in ordered), dtype=np.uint8).reshape(len(ordered), H, W),
            observed=[r.observed for r in ordered],
            poses=poses, basis=basis, source=source or {},
        )
        write_shard(root, shard)
        written.append({'sensor': uid, 'day': day, 'frames': len(shard), 'locked': shard.locked,
                        'firstMs': int(shard.at[0]), 'lastMs': int(shard.at[-1])})
    return written
