"""
python3 -m tools.thermalml shards --dump data/ml/ml-data-….zip --out data/ml/shards
python3 -m tools.thermalml shards --db --since 2026-10-12 --until 2026-10-13 --out data/ml/shards
python3 -m tools.thermalml summary --root data/ml/shards
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import days
from .copydump import manifest, open_dump
from .shards import build_shards, list_shards, read_shard, thermal_rows_from_db, thermal_rows_from_dump


def cmd_shards(a: argparse.Namespace) -> int:
    sensors = set(a.sensor) if a.sensor else None
    t0 = time.time()
    if a.dump:
        source = {'kind': 'dump', 'file': os.path.basename(a.dump), 'manifest': manifest(a.dump)}
        with open_dump(a.dump) as stream:
            written = build_shards(thermal_rows_from_dump(stream), a.out, source, sensors)
    else:
        url = os.environ.get('TRAINING_DATABASE_URL')
        if not url:
            print('TRAINING_DATABASE_URL is not set (reader role, see docs/TRAINING_POSTGRES.md)', file=sys.stderr)
            return 2
        if not (a.since and a.until):
            print('--db needs --since and --until (days, YYYY-MM-DD; until is exclusive)', file=sys.stderr)
            return 2
        start, end = days.day_start_ms(a.since), days.day_start_ms(a.until)
        source = {'kind': 'db', 'since': a.since, 'until': a.until}
        written = []
        for uid in (sorted(sensors) if sensors else [None]):
            written += build_shards(thermal_rows_from_db(url, start, end, uid), a.out, source, sensors)
    for w in written:
        print(json.dumps(w))
    print(f'{len(written)} shards, {sum(w["frames"] for w in written)} frames, {time.time() - t0:.0f} s', file=sys.stderr)
    return 0


def cmd_rgb(a: argparse.Namespace) -> int:
    from .rgb import extract, load_pairs, thermal_days
    t0 = time.time()
    with open_dump(a.pairs) as stream:
        pairs = load_pairs(stream)
    where = thermal_days(a.shards)
    with open_dump(a.dump) as stream:
        counts = extract(stream, pairs, where, a.out, set(a.day) if a.day else None)
    for (uid, day), n in sorted(counts.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        print(f'{uid} {day}{" LOCKED" if days.is_locked(day) else ""}: {n} photos')
    print(f'{sum(counts.values())} photos from {len(pairs)} pairs, {time.time() - t0:.0f} s', file=sys.stderr)
    return 0


def cmd_summary(a: argparse.Namespace) -> int:
    for uid, day in list_shards(a.root, include_locked=True):
        s = read_shard(a.root, uid, day)
        gaps = s.at[1:] - s.at[:-1] if len(s) > 1 else s.at[:0]
        median_gap = float(sorted(gaps)[len(gaps) // 2]) / 1000 if len(gaps) else float('nan')
        print(f'{uid} {day}{" LOCKED" if s.locked else ""}: {len(s)} frames, '
              f'median gap {median_gap:.2f} s, observed on {sum(o is not None for o in s.observed)}')
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('shards', help='write one thermal shard per sensor per day')
    src = s.add_mutually_exclusive_group(required=True)
    src.add_argument('--dump', help='export ZIP (or dataset.sql) containing training.frames')
    src.add_argument('--db', action='store_true', help='read through TRAINING_DATABASE_URL instead')
    s.add_argument('--since', help='first day (YYYY-MM-DD, days start 04:00 HKT), --db only')
    s.add_argument('--until', help='day after the last one, --db only')
    s.add_argument('--sensor', action='append', help='only this sensor uid (repeatable)')
    s.add_argument('--out', required=True)
    s.set_defaults(fn=cmd_shards)
    r = sub.add_parser('rgb', help='extract the RGB photos paired with shard frames (for labelling only)')
    r.add_argument('--dump', required=True, help='export ZIP (or dataset.sql) containing training.frames')
    r.add_argument('--pairs', required=True, help='export ZIP (or dataset.sql) containing training.pairs')
    r.add_argument('--shards', required=True)
    r.add_argument('--day', action='append', help='only this day (repeatable)')
    r.add_argument('--out', required=True)
    r.set_defaults(fn=cmd_rgb)
    m = sub.add_parser('summary', help='list shards')
    m.add_argument('--root', required=True)
    m.set_defaults(fn=cmd_summary)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == '__main__':
    raise SystemExit(main())
