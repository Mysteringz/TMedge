#!/usr/bin/env python3
"""Training fault regressions without a network/database or existing samples."""
import base64
from contextlib import contextmanager, nullcontext
import copy
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import types
import unittest

# The fake connection exercises real worker transactions/verification. Keep
# dependencies optional here so CI can run it before installing psycopg.
class IntegrityError(Exception):
    pass


class DataError(Exception):
    pass


class Jsonb:
    def __init__(self, obj):
        self.obj = obj


psycopg = types.ModuleType('psycopg')
psycopg.IntegrityError, psycopg.DataError = IntegrityError, DataError
json_types = types.ModuleType('psycopg.types.json')
json_types.Jsonb = Jsonb
sys.modules.setdefault('psycopg', psycopg)
sys.modules.setdefault('psycopg.types', types.ModuleType('psycopg.types'))
sys.modules.setdefault('psycopg.types.json', json_types)
spec = importlib.util.spec_from_file_location('training_worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Result:
    def __init__(self, rows=()):
        self.rows = rows

    def fetchall(self):
        return self.rows


class Database:
    def __init__(self):
        self.frames, self.pairs = {}, {}
        self.invalid_ids = set()
        self.fail_commit = False

    @contextmanager
    def transaction(self):
        before = copy.deepcopy((self.frames, self.pairs))
        try:
            yield
            if self.fail_commit:
                raise ConnectionError('commit acknowledgement lost')
        except Exception:
            self.frames, self.pairs = before
            raise

    def pipeline(self):
        return nullcontext()

    def execute(self, sql, params):
        if sql == worker.INSERT_FRAME:
            if params[0] in self.invalid_ids:
                raise IntegrityError('invalid frame')
            self.frames.setdefault(params[0], params)
        elif sql == worker.INSERT_PAIR:
            if params[0] not in self.pairs and any(p[1:3] == params[1:3] for p in self.pairs.values()):
                raise IntegrityError('duplicate frame pair')
            self.pairs.setdefault(params[0], params)
        elif sql.startswith('SELECT id,payload_sha256'):
            return Result([(r[0], r[12], r[16].obj['source_sha256'], r[1], r[2])
                           for r in self.frames.values() if r[0] in params[0]])
        elif sql.startswith('SELECT id,sensor_uid'):
            return Result([(r[0], r[1]) for r in self.frames.values() if r[0] in params[0] and r[2] == 'thermal'])
        elif sql.startswith('SELECT id,thermal_id'):
            return Result([(p[0], p[1], p[2], p[3], p[4], p[5].obj['source_sha256'])
                           for p in self.pairs.values() if p[0] in params[0]])
        else:
            raise AssertionError('unexpected query: ' + sql)
        return Result()


UID = '01:02:03:04:05:06'
JPEG = bytes.fromhex('ffd8ffc00008080001000100')


def source(root, id_, kind='thermal', thermal_id=None, uid=UID):
    path = root / (id_ + '.json')
    record = dict(version=1, id=id_, kind=kind, uid=uid, frame=1, receivedAt=100000,
                  pixels=base64.b64encode(bytes(768)).decode(), tMin=20, step=.01)
    if kind == 'rgb':
        record.update(jpeg=base64.b64encode(JPEG).decode(), at=100001,
                      thermalId=thermal_id, skewMs=1 if thermal_id else None, mirror=False)
    path.write_text(json.dumps(record))
    return path


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = Database()

    def tearDown(self):
        self.temp.cleanup()

    def test_missing_pair_does_not_block_unrelated_records_and_retries(self):
        good = source(self.root, 'good')
        pending = source(self.root, 'camera', 'rgb', 'late')
        self.assertEqual(worker.drain(self.db, [good, pending], delete=True), 1)
        self.assertFalse(good.exists())
        self.assertTrue(pending.exists())
        late = source(self.root, 'late')
        self.assertEqual(worker.drain(self.db, [late, pending], delete=True), 2)
        self.assertFalse(pending.exists())
        self.assertEqual(self.db.pairs['camera-p'][1:3], ('late', 'camera'))

    def test_pair_conflict_cannot_delete_its_source(self):
        thermal = source(self.root, 'thermal')
        rgb = source(self.root, 'camera', 'rgb', 'thermal')
        worker.drain(self.db, [thermal])
        _, pair, _ = worker.parse_file(rgb)
        self.db.pairs[pair[0]] = (pair[0], pair[1], pair[2], 99, True, pair[5])
        good = source(self.root, 'unrelated')
        self.assertEqual(worker.drain(self.db, [rgb, good], delete=True), 1)
        self.assertTrue(rgb.exists())
        self.assertFalse(good.exists())

    def test_constraint_failure_isolated_and_commit_failure_retains_every_source(self):
        bad, good = source(self.root, 'bad'), source(self.root, 'good')
        self.db.invalid_ids.add('bad')
        self.assertEqual(worker.drain(self.db, [bad, good], delete=True), 1)
        self.assertTrue(bad.exists())
        self.assertFalse(good.exists())
        self.assertNotIn('bad', self.db.frames)
        source_again = source(self.root, 'again')
        self.db.fail_commit = True
        with self.assertRaises(ConnectionError):
            worker.drain(self.db, [source_again], delete=True)
        self.assertTrue(source_again.exists())

    def test_cross_sensor_pair_retained(self):
        thermal = source(self.root, 'thermal')
        rgb = source(self.root, 'camera', 'rgb', 'thermal', '11:12:13:14:15:16')
        self.assertEqual(worker.drain(self.db, [thermal, rgb], delete=True), 1)
        self.assertTrue(rgb.exists())
        self.assertFalse(self.db.pairs)

    def test_frame_conflict_and_malformed_observations_retained(self):
        original = source(self.root, 'thermal')
        worker.drain(self.db, [original])
        record = json.loads(original.read_text())
        record['frame'] = 2
        original.write_text(json.dumps(record))
        self.assertEqual(worker.drain(self.db, [original], delete=True), 0)
        self.assertTrue(original.exists())
        record['observed'] = {'invalid': True}
        original.write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            worker.parse_file(original)


class TrainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np
        import cv2
        cls.np, cls.cv2 = np, cv2
        path = Path(__file__).resolve().parents[2] / 'tools/train_human_location.py'
        spec = importlib.util.spec_from_file_location('thermal_trainer', path)
        cls.trainer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.trainer
        spec.loader.exec_module(cls.trainer)

    def sample(self, uid=UID, jpeg='unused'):
        return self.trainer.Sample(1, uid, self.np.zeros((24, 32)), jpeg, [], False)

    def test_mixed_sensors_require_selection(self):
        samples = [self.sample(), self.sample('11:12:13:14:15:16')]
        with self.assertRaisesRegex(SystemExit, 'multiple sensors'):
            self.trainer.select_samples(samples)
        self.assertEqual(self.trainer.select_samples(samples, UID), samples[:1])

    def test_metrics_describe_selected_threshold(self):
        probabilities = self.np.array([.8, .7])
        labels = self.np.array([1, 0])
        self.assertEqual(self.trainer.score_threshold(probabilities, labels, .5), (2 / 3, .5, 1))
        self.assertEqual(self.trainer.score_threshold(probabilities, labels, .9), (0, 0, 0))
        result = subprocess.run([sys.executable, self.trainer.__file__, 'unused', '--threshold', '.0001'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('remain positive when rounded', result.stderr)

    def test_dimension_change_is_descriptive_and_unsafe_uid_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            samples = []
            for i in range(6):
                path = root / f'{i}.jpg'
                self.cv2.imwrite(str(path), self.np.zeros((24 if i < 5 else 25, 32), self.np.uint8))
                samples.append(self.sample(jpeg=str(path)))
            with self.assertRaisesRegex(SystemExit, 'dimensions changed'):
                self.trainer.rgb_people(samples)
            path = source(root, 'unsafe', uid='../../outside')
            path.with_suffix('.jpg').write_bytes(JPEG)
            self.assertEqual(self.trainer.load_pairs(str(root)), [])


if __name__ == '__main__':
    unittest.main()
