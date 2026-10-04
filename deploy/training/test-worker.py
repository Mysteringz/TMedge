#!/usr/bin/env python3
"""Exercise the real database using existing samples and rolled-back writes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import psycopg

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
source = next(Path('/var/lib/tmedge/algo/pairs').glob('*/*.json'))
with psycopg.connect(os.environ['TRAINING_DATABASE_URL'], autocommit=True) as conn:
    before = conn.execute('SELECT count(*) FROM training.frames').fetchone()[0]
    with tempfile.TemporaryDirectory(prefix='training-check-') as temp:
        copy = Path(temp) / source.name
        copy.write_bytes(source.read_bytes())
        copy.with_suffix('.jpg').write_bytes(source.with_suffix('.jpg').read_bytes())
        worker.drain(conn, [copy], legacy=True)
        worker.drain(conn, [copy], legacy=True)
        assert copy.exists()
        worker.drain(conn, [copy], legacy=True, delete=True)
        assert not copy.exists() and not copy.with_suffix('.jpg').exists()
        rows, _, _ = worker.parse_file(source, legacy=True)
        m = json.loads(source.read_text())
        poisoned = Path(temp) / 'poison.json'
        poisoned.write_text(json.dumps(dict(version=1, kind='thermal', id=rows[0][0], uid=m['uid'],
            frame=m['frame'], receivedAt=m['at'], pixels=m['pixels'], tMin=m['tMin'], step=m['step'])))
        try:
            worker.drain(conn, [poisoned], delete=True)
            raise AssertionError('conflicting record should fail verification')
        except ValueError:
            assert poisoned.exists()
        invalid = list(rows[0])
        invalid[0] = 'rollback-only-test'
        invalid[12] = '0' * 64
        try:
            with conn.transaction():
                conn.execute(worker.INSERT_FRAME, invalid)
            raise AssertionError('incorrect payload hash was accepted')
        except psycopg.errors.CheckViolation:
            pass
    assert conn.execute('SELECT count(*) FROM training.frames').fetchone()[0] == before
    n = conn.execute('SELECT cardinality(temperatures_c) FROM training.ml_samples LIMIT 1').fetchone()[0]
    assert n == 768
print('PASS: retry deduplication, committed-source cleanup, conflict retention, hash constraint, ML array')
