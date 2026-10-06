#!/usr/bin/env python3
"""Export a bounded database dataset for the existing offline trainer.

TRAINING_DATABASE_URL is a reader connection through an SSH tunnel.
Requires psycopg[binary]. Labels are device observations, not ground truth.
"""
import argparse
import base64
import json
import os
import re
from pathlib import Path
import psycopg

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--sensor', required=True)
parser.add_argument('--start', required=True, help='inclusive ISO UTC timestamp')
parser.add_argument('--end', required=True, help='exclusive ISO UTC timestamp')
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
if any(args.out.iterdir()):
    raise SystemExit('Export directory must be empty')
with psycopg.connect(os.environ['TRAINING_DATABASE_URL']) as conn:
    conn.execute('SET TRANSACTION READ ONLY')
    with conn.cursor(name='training_export') as cur:
        cur.execute('''SELECT sample_id, sensor_uid, sample_at, frame_number, skew_ms, mirror,
          thermal_u8, t_min, t_step, device_detections, rgb_jpeg
          FROM training.ml_samples WHERE sensor_uid=%s AND sample_at >= %s AND sample_at < %s
          ORDER BY sample_at, sample_id''', (args.sensor, args.start, args.end))
        count = 0
        for id_, uid, at, number, skew, mirror, levels, t_min, step, observed, jpeg in cur:
            if not isinstance(id_, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', id_):
                raise ValueError('unsafe training sample identifier')
            name = args.out / (str(int(at.timestamp()*1000)) + '-' + id_)
            meta = dict(uid=uid, at=int(at.timestamp()*1000), frame=number, skewMs=skew,
                        mirror=mirror, pixels=base64.b64encode(levels).decode(),
                        tMin=t_min, step=step, observed=observed)
            with name.with_suffix('.jpg').open('xb') as f:
                f.write(jpeg)
            with name.with_suffix('.json').open('x') as f:
                json.dump(meta, f)
            count += 1
        print(f'Exported {count} pairs')
