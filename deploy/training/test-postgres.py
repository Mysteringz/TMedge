#!/usr/bin/env python3
"""Real schema/worker regressions. Requires an EMPTY disposable PostgreSQL DB."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import psycopg
from psycopg import sql as pgsql

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('worker', ROOT / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
UID = '01:02:03:04:05:06'
JPEG = bytes.fromhex('ffd8ffc00008080001000100')
checks = 0

def check(condition, what):
    global checks
    assert condition, what
    checks += 1
    print('ok', what)

def source(root, id_, kind='thermal', thermal_id=None, uid=UID):
    path = root / (id_ + '.json')
    record = dict(version=1, id=id_, kind=kind, uid=uid, frame=1, receivedAt=100000,
                  pixels=base64.b64encode(bytes(768)).decode(), tMin=20, step=.01)
    if kind == 'rgb':
        record.update(jpeg=base64.b64encode(JPEG).decode(), at=100001,
                      thermalId=thermal_id, skewMs=1 if thermal_id else None, mirror=False)
    path.write_text(json.dumps(record))
    return path

url = os.environ['TEST_DATABASE_URL']
with psycopg.connect(url, autocommit=True) as conn:
    if conn.execute("SELECT to_regnamespace('training')").fetchone()[0] is not None:
        raise SystemExit('Refusing a database with an existing training schema; use an empty disposable DB.')
    schema = (ROOT / 'schema.sql').read_text()
    conn.execute(schema)
    check(conn.execute("SELECT to_regclass('training.ml_samples')").fetchone()[0] is not None, 'fresh schema applies')
    conn.execute(schema)
    check(True, 'schema reapplies without duplicate constraints')
    # Simulate the pre-audit schema while preserving valid existing records.
    conn.execute('ALTER TABLE training.pairs DROP CONSTRAINT pairs_thermal_modality_fk, DROP CONSTRAINT pairs_rgb_modality_fk, DROP CONSTRAINT pairs_fixed_modalities')
    conn.execute('ALTER TABLE training.pairs DROP COLUMN thermal_modality, DROP COLUMN rgb_modality')
    conn.execute('ALTER TABLE training.frames DROP CONSTRAINT frames_finite_thermal_calibration')
    with tempfile.TemporaryDirectory(prefix='training-postgres-') as temp:
        root = Path(temp)
        thermal = source(root, 'thermal')
        rgb = source(root, 'camera', 'rgb', 'thermal')
        check(worker.drain(conn, [thermal, rgb]) == 2, 'real pipeline imports matching frames and pair')
        conn.execute(schema)
        check(conn.execute('SELECT count(*) FROM training.pairs').fetchone()[0] == 1, 'upgrade preserves existing valid pair')
        check(worker.drain(conn, [thermal, rgb]) == 2, 'retry deduplicates verified rows')
        check(conn.execute('SELECT count(*) FROM training.frames').fetchone()[0] == 2, 'retry does not duplicate frames')
        check(conn.execute('SELECT cardinality(temperatures_c) FROM training.ml_samples').fetchone()[0] == 768, 'ML view emits all thermal pixels')
        poison = json.loads(thermal.read_text()); poison['frame'] = 2; thermal.write_text(json.dumps(poison))
        check(worker.drain(conn, [thermal], delete=True) == 0 and thermal.exists(), 'conflicting frame retains its source')
        pending = source(root, 'pending-camera', 'rgb', 'late')
        unrelated = source(root, 'unrelated')
        check(worker.drain(conn, [pending, unrelated], delete=True) == 1 and pending.exists() and not unrelated.exists(), 'missing pair does not poison unrelated records')
        late = source(root, 'late')
        check(worker.drain(conn, [late, pending], delete=True) == 2 and not pending.exists(), 'missing pair is imported on later retry')
        cross = source(root, 'cross-camera', 'rgb', 'thermal', '11:12:13:14:15:16')
        check(worker.drain(conn, [cross], delete=True) == 0 and cross.exists(), 'cross-sensor pair retains its source')
        for label, sql in [
            ('wrong thermal modality', "UPDATE training.pairs SET thermal_id=rgb_id WHERE id='camera-p'"),
            ('wrong RGB modality', "UPDATE training.pairs SET rgb_id=thermal_id WHERE id='camera-p'"),
            ('NaN calibration', "UPDATE training.frames SET t_min='NaN'::float8 WHERE id='thermal'"),
            ('infinite calibration', "UPDATE training.frames SET t_step='Infinity'::float8 WHERE id='thermal'"),
            ('incorrect payload hash', "UPDATE training.frames SET payload_sha256=repeat('0',64) WHERE id='thermal'"),
        ]:
            try:
                with conn.transaction(): conn.execute(sql)
            except psycopg.IntegrityError:
                check(True, 'schema rejects ' + label)
            else:
                raise AssertionError('schema accepted ' + label)
        check(worker.drain(conn, [rgb], delete=True) == 1 and not rgb.exists(), 'source deletion follows verified commit')
        # Invalid pre-upgrade data must block migration without silently removing
        # rows. Simulate the old permissive calibration check, then repair it.
        calibration_checks = conn.execute("SELECT conname FROM pg_constraint WHERE conrelid='training.frames'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%t_min%'").fetchall()
        for (name,) in calibration_checks:
            conn.execute(pgsql.SQL('ALTER TABLE training.frames DROP CONSTRAINT {}').format(pgsql.Identifier(name)))
        conn.execute("UPDATE training.frames SET t_min='NaN'::float8 WHERE id='thermal'")
        before = conn.execute('SELECT count(*) FROM training.frames').fetchone()[0]
        try:
            conn.execute(schema)
        except psycopg.IntegrityError:
            conn.execute('ROLLBACK')
        else:
            raise AssertionError('migration accepted invalid legacy calibration')
        check(conn.execute('SELECT count(*) FROM training.frames').fetchone()[0] == before,
              'invalid legacy migration rolls back without deleting records')
        check(str(conn.execute("SELECT t_min FROM training.frames WHERE id='thermal'").fetchone()[0]) == 'nan',
              'invalid legacy row remains available for reviewed repair')
        conn.execute("UPDATE training.frames SET t_min=20 WHERE id='thermal'")
        conn.execute(schema)
        check(conn.execute("SELECT count(*) FROM pg_constraint WHERE conname='frames_finite_thermal_calibration'").fetchone()[0] == 1,
              'migration succeeds after explicit legacy repair')
print(f'postgres_test: {checks} checks passed')
