#!/usr/bin/env python3
"""Drain the private outbox into PostgreSQL; retry without duplicating records."""
import argparse
import base64
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import time
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Jsonb


def timestamp(ms):
    return None if ms is None else datetime.fromtimestamp(ms / 1000, timezone.utc)


def jpeg_size(data):
    if data[:2] != b'\xff\xd8':
        raise ValueError('not a JPEG')
    i = 2
    while i < len(data):
        if data[i] != 255:
            raise ValueError('invalid JPEG marker')
        while i < len(data) and data[i] == 255:
            i += 1
        marker = data[i]
        i += 1
        if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
            continue
        n = int.from_bytes(data[i:i+2], 'big')
        if n < 2 or i + n > len(data):
            raise ValueError('invalid JPEG segment')
        if marker in (0xc0, 0xc1, 0xc2):
            return int.from_bytes(data[i+5:i+7], 'big'), int.from_bytes(data[i+3:i+5], 'big')
        i += n
    raise ValueError('JPEG has no supported frame header')


def frame(id_, uid, modality, payload, reference, basis, metadata,
          captured=None, received=None, number=None, t_min=None, t_step=None, observed=None):
    width, height = (32, 24) if modality == 'thermal' else jpeg_size(payload)
    if modality == 'thermal' and len(payload) != 768:
        raise ValueError('thermal frame must contain 768 bytes')
    if modality == 'thermal' and (not math.isfinite(t_min) or not math.isfinite(t_step) or t_step < 0):
        raise ValueError('invalid thermal calibration')
    return (id_, uid.lower(), modality, number, timestamp(captured), timestamp(received),
            timestamp(reference), basis, width, height,
            'thermal_u8' if modality == 'thermal' else 'jpeg', payload,
            hashlib.sha256(payload).hexdigest(), t_min, t_step,
            None if observed is None else Jsonb(observed), Jsonb(metadata))


def parse_file(path, legacy=False):
    raw = path.read_bytes()
    m = json.loads(raw)
    digest = hashlib.sha256(raw).hexdigest()
    # Payloads live in bytea once, rather than a second base64 copy in JSONB.
    meta = {'source_sha256': digest, 'source_record': {k: v for k, v in m.items() if k not in ('pixels', 'jpeg')},
            'source': 'legacy_pairs' if legacy else 'outbox_v1'}
    if legacy:
        jpg = path.with_suffix('.jpg').read_bytes()
        key = hashlib.sha256(raw + jpg).hexdigest()
        thermal = frame(key+'-t', m['uid'], 'thermal', base64.b64decode(m['pixels'], validate=True),
                        m['at'], 'legacy_pair_reference', meta, number=m['frame'],
                        t_min=m['tMin'], t_step=m['step'], observed=m.get('observed'))
        rgb = frame(key+'-r', m['uid'], 'rgb', jpg, m['at'], 'camera_post_encode', meta, captured=m['at'])
        pair = (key, thermal[0], rgb[0], m['skewMs'], m['mirror'], Jsonb(meta))
        return [thermal, rgb], pair, [path, path.with_suffix('.jpg')]
    if m.get('version') != 1:
        raise ValueError('unsupported outbox version')
    if m['kind'] == 'thermal':
        row = frame(m['id'], m['uid'], 'thermal', base64.b64decode(m['pixels'], validate=True),
                    m['receivedAt'], 'edge_receive', meta, received=m['receivedAt'],
                    number=m['frame'], t_min=m['tMin'], t_step=m['step'])
        return [row], None, [path]
    if m['kind'] != 'rgb':
        raise ValueError('unknown modality')
    row = frame(m['id'], m['uid'], 'rgb', base64.b64decode(m['jpeg'], validate=True),
                m['at'], 'camera_post_encode', meta, captured=m['at'], received=m['receivedAt'])
    pair = (m['id']+'-p', m['thermalId'], m['id'], m['skewMs'], m['mirror'], Jsonb(meta)) if m.get('thermalId') else None
    return [row], pair, [path]


INSERT_FRAME = '''INSERT INTO training.frames
 (id,sensor_uid,modality,frame_number,captured_at,received_at,reference_at,timestamp_basis,
 width,height,encoding,payload,payload_sha256,t_min,t_step,observed,metadata)
 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING'''
INSERT_PAIR = '''INSERT INTO training.pairs (id,thermal_id,rgb_id,skew_ms,mirror,metadata)
 VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING'''


def drain(conn, paths, legacy=False, delete=False):
    parsed = []
    for path in paths:
        try:
            parsed.append(parse_file(path, legacy))
        except Exception:
            logging.error('unreadable training record retained: %s', path.name)
    rows = [r for frames, _, _ in parsed for r in frames]
    if not rows:
        return 0
    # Pipeline batches avoid a Singapore/Hong Kong round trip for each insert.
    with conn.transaction():
        with conn.pipeline():
            for row in rows:
                conn.execute(INSERT_FRAME, row)
        pairs = [pair for _, pair, _ in parsed if pair]
        if pairs:
            required = {pair[1] for pair in pairs}
            present = {r[0] for r in conn.execute('SELECT id FROM training.frames WHERE id=ANY(%s) AND modality=\'thermal\'',
                                                 (list(required),)).fetchall()}
            if required != present:
                raise ValueError('paired thermal record has not arrived yet')
            with conn.pipeline():
                for pair in pairs:
                    conn.execute(INSERT_PAIR, pair)
        stored = conn.execute('SELECT id,payload_sha256,metadata->>\'source_sha256\' FROM training.frames WHERE id=ANY(%s)',
                              ([r[0] for r in rows],)).fetchall()
        checks = {r[0]: (r[1], r[2]) for r in stored}
        for row in rows:
            if checks.get(row[0]) != (row[12], row[16].obj['source_sha256']):
                raise ValueError('database verification mismatch; source retained')
    # This runs only AFTER commit; a disconnect before acknowledgement leaves
    # the source in place and ON CONFLICT makes the retry safe.
    if delete:
        for _, _, files in parsed:
            for path in files:
                path.unlink(missing_ok=True)
    return len(parsed)


def status(conn, spool):
    row = conn.execute('''SELECT count(*), count(*) FILTER (WHERE jsonb_array_length(coalesce(nullif(t.observed,'null'::jsonb),nullif(p.metadata->'source_record'->'observed','null'::jsonb),'[]'))>0),
      coalesce(sum(octet_length(t.payload)+octet_length(r.payload)),0),
      extract(epoch FROM min(r.reference_at))*1000, extract(epoch FROM max(r.reference_at))*1000
      FROM training.pairs p JOIN training.frames t ON t.id=p.thermal_id JOIN training.frames r ON r.id=p.rgb_id''').fetchone()
    result = dict(zip(('samples','withPeople','bytes','oldest','newest'),
                      (int(x) if x is not None else None for x in row)))
    result['updatedAt'] = int(time.time()*1000)
    result['pending'] = sum(1 for p in spool.glob('*.json') if p.name != 'status.json')
    tmp = spool / 'status.json.tmp'
    tmp.write_text(json.dumps(result))
    tmp.replace(spool / 'status.json')
    conn.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--spool', type=Path, required=True)
    parser.add_argument('--legacy', type=Path)
    parser.add_argument('--delete-legacy', action='store_true')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    args.spool.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    while True:
        try:
            with psycopg.connect(os.environ['TRAINING_DATABASE_URL'], connect_timeout=15) as conn:
                imported = 0
                if args.legacy:
                    paths = sorted(args.legacy.glob('*/*.json'))
                    for i in range(0, len(paths), 128):
                        imported += drain(conn, paths[i:i+128], legacy=True, delete=args.delete_legacy)
                        logging.info('legacy verified: %d/%d', imported, len(paths))
                paths = sorted(p for p in args.spool.glob('*.json') if p.name != 'status.json')
                # RAW records must reach the DB before RGB pairs referencing them.
                paths.sort(key=lambda p: (json.loads(p.read_text()).get('kind') != 'thermal', p.name))
                for i in range(0, len(paths), 128):
                    imported += drain(conn, paths[i:i+128], delete=True)
                status(conn, args.spool)
                if imported:
                    logging.info('committed and verified %d records; queue drained', imported)
            if args.once:
                return
        except Exception as exc:
            # Exceptions can contain a connection string or sample pixels.
            logging.error('training transfer failed (%s); uncommitted files retained', type(exc).__name__)
            if args.once:
                raise SystemExit(1)
        time.sleep(10)


if __name__ == '__main__':
    main()
