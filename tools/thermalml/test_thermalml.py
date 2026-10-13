"""
Claims about the thermal ML data tools. The failures these guard against: a
truncated export passing for a small one, a frame landing in the wrong day,
the hand-labelled test days reaching a training set, and the background
the model trains against differing from the edge's.

python3 -m unittest discover -s tools/thermalml -t . -p 'test_*.py'
"""
from __future__ import annotations

import io
import json
import math
import os
import tempfile
import unittest

import numpy as np

from tools.thermalml import days
from tools.thermalml.copydump import DumpError, bytea, iter_copy, unescape
from tools.thermalml.shards import build_shards, list_shards, read_shard, thermal_rows_from_dump
from tools.thermalml.staticbg import Options, StaticBackground, median32

RIG = '2c:cf:67:0b:c0:94'
BENCH = '30:ed:a0:cb:f5:f8'
COLS = ('id, sensor_uid, modality, frame_number, captured_at, received_at, reference_at, timestamp_basis, '
        'width, height, encoding, payload, payload_sha256, t_min, t_step, observed, metadata, imported_at')


def frames_row(fid: str, uid: str, at: str, pixels: bytes, *, modality: str = 'thermal', frame: int | None = 1,
               observed: str | None = None, meta: dict | None = None) -> bytes:
    """One `training.frames` COPY line, escaped the way pg_dump escapes it."""
    def esc(v: str | None) -> str:
        return '\\N' if v is None else v.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n')
    if modality == 'thermal':
        enc, w, h, tmin, step = 'thermal_u8', '32', '24', '20.5', '0.02'
    else:
        enc, w, h, tmin, step = 'jpeg', '640', '480', None, None
    fields = [fid, uid, modality, None if frame is None else str(frame), None, None, at, 'edge_receive', w, h, enc,
              '\\x' + pixels.hex(), 'sha', tmin, step, observed, json.dumps(meta or {}), at]
    return ('\t'.join(esc(f) for f in fields) + '\n').encode()


def dump(*rows: bytes, terminated: bool = True) -> io.BytesIO:
    text = b'SET client_encoding = \'UTF8\';\n' + f'COPY training.frames ({COLS}) FROM stdin;\n'.encode()
    text += b''.join(rows) + (b'\\.\n\n-- PostgreSQL database dump complete\n' if terminated else b'')
    return io.BytesIO(text)


def pixels(value: int = 50, hot: tuple[int, int] | None = None) -> bytes:
    a = np.full((24, 32), value, dtype=np.uint8)
    if hot:
        a[hot] = 250
    return a.tobytes()


class CopyFormat(unittest.TestCase):
    def test_fields_are_unescaped_and_null_is_none(self) -> None:
        self.assertIsNone(unescape(b'\\N'))
        self.assertEqual(unescape(b'a\\tb\\\\c'), 'a\tb\\c')
        self.assertEqual(unescape(b'{"k": "v\\\\n"}'), '{"k": "v\\n"}')

    def test_bytea_hex_comes_back_as_the_original_bytes(self) -> None:
        self.assertEqual(bytea(b'\\\\x00ff10'), b'\x00\xff\x10')

    def test_a_dump_cut_off_mid_table_is_an_error_not_a_short_table(self) -> None:
        rows = dump(frames_row('a', RIG, '2026-10-06 06:00:00+00', pixels()), terminated=False)
        with self.assertRaises(DumpError):
            list(iter_copy(rows, 'training.frames'))


class Days(unittest.TestCase):
    def test_a_day_runs_from_four_in_the_morning_hong_kong_time(self) -> None:
        # 2026-09-26 03:59 HKT is still the 25th; 04:00 is the 26th.
        self.assertEqual(days.day_of(days.day_start_ms('2026-09-26') - 60_000), '2026-09-25')
        self.assertEqual(days.day_of(days.day_start_ms('2026-09-26')), '2026-09-26')

    def test_the_hand_labelled_days_can_never_be_trained_on(self) -> None:
        with self.assertRaises(days.LockedDayError):
            days.assert_trainable({'2026-10-06', '2026-09-29'})
        days.assert_trainable({'2026-10-06', '2026-10-07'})

    def test_frames_near_a_day_boundary_are_marked(self) -> None:
        start = days.day_start_ms('2026-10-06')
        self.assertTrue(days.near_boundary(start + 10 * 60_000))
        self.assertTrue(days.near_boundary(start + days.DAY_MS - 10 * 60_000))
        self.assertFalse(days.near_boundary(start + 12 * 3600_000))


class Shards(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp()

    def build(self, *rows: bytes) -> list[dict]:
        return build_shards(thermal_rows_from_dump(dump(*rows)), self.root, {'kind': 'test'})

    def test_thermal_frames_are_grouped_by_sensor_and_day_and_rgb_is_left_out(self) -> None:
        written = self.build(
            frames_row('t2', RIG, '2026-10-06 08:00:01+00', pixels(60), frame=2),
            frames_row('t1', RIG, '2026-10-06 08:00:00+00', pixels(50, hot=(10, 20)), frame=1),
            frames_row('r1', RIG, '2026-10-06 08:00:00+00', b'\xff\xd8jpeg', modality='rgb', frame=None),
            frames_row('b1', BENCH, '2026-10-06 08:00:00+00', pixels(70)),
        )
        self.assertEqual(sorted((w['sensor'], w['frames']) for w in written), [(RIG, 2), (BENCH, 1)])
        s = read_shard(self.root, RIG, '2026-10-06')
        self.assertEqual(s.ids, ['t1', 't2'])                  # time order, not file order
        self.assertEqual(int(s.pixels[0, 10, 20]), 250)        # row-major 24x32, as on the wire
        self.assertAlmostEqual(float(s.temps()[0, 10, 20]), 20.5 + 250 * 0.02, places=4)

    def test_the_same_frame_twice_is_kept_once(self) -> None:
        row = frames_row('t1', RIG, '2026-10-06 08:00:00+00', pixels())
        self.build(row, row)
        self.assertEqual(len(read_shard(self.root, RIG, '2026-10-06')), 1)

    def test_locked_days_are_written_apart_and_left_out_of_the_training_list(self) -> None:
        self.build(
            frames_row('t1', RIG, '2026-09-26 10:00:00+00', pixels(), observed='[{"x": 3, "y": 4}]'),
            frames_row('t2', RIG, '2026-10-06 10:00:00+00', pixels()),
        )
        self.assertTrue(os.path.exists(os.path.join(self.root, 'locked', '2ccf670bc094', '2026-09-26.json')))
        self.assertEqual(list_shards(self.root), [(RIG, '2026-10-06')])
        self.assertEqual(list_shards(self.root, include_locked=True), [(RIG, '2026-09-26'), (RIG, '2026-10-06')])
        # The node's own detections on the legacy days are kept: they are a baseline.
        self.assertEqual(read_shard(self.root, RIG, '2026-09-26').observed, [[{'x': 3, 'y': 4}]])

    def test_a_shard_whose_pixels_do_not_match_its_index_is_refused(self) -> None:
        self.build(frames_row('t1', RIG, '2026-10-06 08:00:00+00', pixels()))
        idx = os.path.join(self.root, '2ccf670bc094', '2026-10-06.json')
        with open(idx) as f:
            doc = json.load(f)
        doc['payloadSha256'] = '0' * 64
        with open(idx, 'w') as f:
            json.dump(doc, f)
        with self.assertRaises(ValueError):
            read_shard(self.root, RIG, '2026-10-06')

    def test_the_sensor_pose_is_kept_as_spans_not_per_frame(self) -> None:
        pose = {'source_record': {'metadata': {'pose': {'heightCm': 280, 'mirror': True}, 'floorId': 'f', 'detector': 'edge'}}}
        self.build(*[frames_row(f't{i}', RIG, f'2026-10-06 08:00:0{i}+00', pixels(), frame=i, meta=pose) for i in range(3)])
        poses = read_shard(self.root, RIG, '2026-10-06').poses
        self.assertEqual(len(poses), 1)
        self.assertEqual(poses[0]['pose'], {'heightCm': 280, 'mirror': True})


class Background(unittest.TestCase):
    """The port's behaviour; test/thermalml.test.ts checks its numbers against staticbg.ts."""

    FAST = Options(bucket_ms=60_000, window_ms=20 * 60_000, sample_ms=1_000, quantile=0.2, min_buckets=4,
                   min_samples_per_bucket=10)

    def room(self, person: bool, rng: np.random.Generator) -> np.ndarray:
        t = 22 + rng.normal(0, 0.05, (24, 32)).astype(np.float32)
        t[2:4, 25:28] += 6            # a heater, on all the time
        if person:
            t[15:17, 7:9] += 4
        return t.astype(np.float32)

    def test_not_ready_until_enough_buckets_then_ready(self) -> None:
        bg, rng = StaticBackground(self.FAST), np.random.default_rng(1)
        at = 0
        while at < 3 * 60_000:
            bg.add(self.room(False, rng), at)
            at += 1_000
        self.assertFalse(bg.ready)
        while at < 6 * 60_000:
            bg.add(self.room(False, rng), at)
            at += 1_000
        self.assertTrue(bg.ready)

    def test_a_person_sitting_for_a_quarter_of_the_window_stays_foreground_and_a_heater_does_not(self) -> None:
        bg, rng = StaticBackground(self.FAST), np.random.default_rng(2)
        for s in range(20 * 60):
            bg.add(self.room(15 * 60 <= s, rng), s * 1_000)
        frame = self.room(True, rng)
        b = bg.background_for(median32(frame))
        assert b is not None
        diff = frame.ravel() - b
        self.assertGreater(float(diff.reshape(24, 32)[15:17, 7:9].mean()), 3)
        self.assertLess(abs(float(diff.reshape(24, 32)[2:4, 25:28].mean())), 0.5)

    def test_median_matches_the_typescript_definition(self) -> None:
        self.assertEqual(median32(np.array([3, 1, 2, 4], dtype=np.float32)), 2.5)
        self.assertEqual(median32(np.array([], dtype=np.float32)), 0.0)
        self.assertTrue(math.isclose(median32(np.array([0.1, 0.2, 0.3], dtype=np.float32)), float(np.float32(0.2))))


class Features(unittest.TestCase):
    """What the detector sees; heatfeatures.ts is checked against these numbers in test/thermalml.test.ts."""

    def frames(self, warm: callable, seconds: int, every_ms: int) -> tuple[list[np.ndarray], list[int]]:
        rng = np.random.default_rng(5)
        out, ats = [], []
        for at in range(0, seconds * 1000, every_ms):
            t = (22 + rng.normal(0, 0.05, (24, 32))).astype(np.float32)
            t[10:12, 10:12] += warm(at)
            out.append(t.ravel())
            ats.append(at)
        return out, ats

    def last_features(self, warm: callable, every_ms: int = 1000):
        from tools.thermalml.features import RecentMedian, features
        frames, ats = self.frames(warm, 8 * 60, every_ms)
        rm = RecentMedian()
        for t, at in zip(frames, ats):
            rm.add(t, at)
        t = frames[-1]
        return features(t, np.full(768, median32(t), dtype=np.float32), rm.recent()).reshape(3, 24, 32)

    def test_someone_who_just_sat_down_is_positive_in_the_recent_channel(self) -> None:
        f = self.last_features(lambda at: 4.0 if at > 7 * 60_000 else 0.0)
        self.assertGreater(float(f[2, 10:12, 10:12].mean()), 0.5)

    def test_a_chair_cooling_after_someone_left_is_negative_in_the_recent_channel_but_still_warm(self) -> None:
        f = self.last_features(lambda at: 4.0 if at < 6 * 60_000 else 1.0)
        self.assertLess(float(f[2, 10:12, 10:12].mean()), -0.3)
        self.assertGreater(float(f[1, 10:12, 10:12].mean()), 0.1)

    def test_the_recent_channel_means_the_same_at_one_frame_every_eight_seconds(self) -> None:
        fast = self.last_features(lambda at: 4.0 if at > 7 * 60_000 else 0.0, every_ms=1000)
        slow = self.last_features(lambda at: 4.0 if at > 7 * 60_000 else 0.0, every_ms=8000)
        self.assertLess(abs(float(fast[2, 10:12, 10:12].mean()) - float(slow[2, 10:12, 10:12].mean())), 0.1)

    def test_without_a_background_there_is_nothing_to_detect_from(self) -> None:
        from tools.thermalml.features import features
        self.assertIsNone(features(np.full(768, 22, dtype=np.float32), None, None))


class Network(unittest.TestCase):
    """The exported file computes what the trained network computes (needs PyTorch; CI checks the edge against golden files)."""

    def test_the_exported_json_computes_what_pytorch_computes(self) -> None:
        try:
            import torch
        except ImportError:
            self.skipTest('PyTorch is not installed here')
        from tools.thermalml.heatnet import export, forward_np, torch_model
        torch.manual_seed(0)
        net = torch_model()
        # Give batch norm non-trivial statistics so folding it is actually tested.
        net.train()
        with torch.no_grad():
            for _ in range(5):
                net(torch.randn(8, 3, 24, 32) * 0.7 + 0.2)
        net.eval()
        doc = export(net, {'threshold': 0.5})
        x = (torch.randn(1, 3, 24, 32) * 0.6).float()
        with torch.no_grad():
            hm, off = net(x)
        np_hm, np_off = forward_np(doc, x[0].numpy())
        self.assertLess(float(np.abs(np_hm - hm[0].double().numpy()).max()), 1e-4)
        self.assertLess(float(np.abs(np_off - off[0].double().numpy()).max()), 1e-4)


class TrainingTargets(unittest.TestCase):
    """Where the model is told a person is. A target off by a cell trains a model off by two pixels."""

    def test_a_person_becomes_one_peak_cell_with_the_exact_remainder_as_offset(self) -> None:
        from tools.thermalml.train import targets
        hm, w, off, pos = targets([[10.3, 7.9, 0.9]], [], np.ones((24, 32), dtype=np.float32))
        self.assertEqual(np.argwhere(pos == 1).tolist(), [[3, 5]])          # y 7.9 -> row 3, x 10.3 -> column 5
        self.assertEqual(float(hm[3, 5]), 1.0)
        self.assertAlmostEqual(float(off[0, 3, 5]), 10.3 / 2 - 5.5, places=5)
        self.assertAlmostEqual(float(off[1, 3, 5]), 7.9 / 2 - 3.5, places=5)

    def test_what_the_photo_cannot_see_and_unsure_people_carry_no_weight(self) -> None:
        from tools.thermalml.train import targets
        known = np.ones((24, 32), dtype=np.float32)
        known[:, :16] = 0                                                  # left half unseen by the camera
        _hm, w, _off, _pos = targets([], [[25.0, 12.0]], known)
        self.assertEqual(float(w[:, :8].sum()), 0.0)                       # unknown is never "nobody"
        self.assertEqual(float(w[6, 12]), 0.0)                             # around the unsure person
        self.assertEqual(float(w[2, 14]), 1.0)

    def test_a_flip_moves_the_person_and_their_heat_together(self) -> None:
        from tools.thermalml.train import augment
        x = np.zeros((3, 24, 32), dtype=np.float32)
        x[1, 10, 4] = 2.0
        rng = np.random.default_rng(0)
        for _ in range(20):
            xa, pts, _ign, _known = augment(x, x[2], [[4.5, 10.5, 1.0]], [], np.ones((24, 32), np.float32), rng, [])
            px, py = pts[0][0], pts[0][1]
            hot = np.unravel_index(int(np.argmax(xa[1])), (24, 32))
            self.assertLess(math.hypot(hot[1] + 0.5 - px, hot[0] + 0.5 - py), 1.5)

    def test_zoom_keeps_its_centre_still_and_shrinks_distances(self) -> None:
        from tools.thermalml.train import _affine
        x = np.zeros((1, 24, 32), dtype=np.float32)
        x[0, 12, 16] = 1.0
        y = _affine(x, 0.5, 16.5, 12.5, 0)
        self.assertEqual(float(y[0, 12, 16]), 1.0)
        x2 = np.zeros((1, 24, 32), dtype=np.float32)
        x2[0, 12, 24] = 1.0                                                # 8 px right of the centre
        y2 = _affine(x2, 0.5, 16.5, 12.5, 0)
        self.assertEqual(np.argwhere(y2[0] == 1.0).tolist(), [[12, 20]])  # now 4 px right


class Scoring(unittest.TestCase):
    """The scores everything else is judged by."""

    def test_the_assignment_is_optimal_not_greedy(self) -> None:
        # Greedy would pair row 0 with column 0 (cost 1) and leave row 1 with 10.
        from tools.thermalml.metrics import assign
        self.assertEqual(sorted(assign(np.array([[1.0, 2.0], [2.0, 10.0]]))), [(0, 1), (1, 0)])
        self.assertEqual(len(assign(np.zeros((2, 5)))), 2)
        self.assertEqual(len(assign(np.zeros((5, 2)))), 2)

    def test_a_person_counts_as_found_only_within_the_radius_and_only_once(self) -> None:
        from tools.thermalml.metrics import match
        tp, fp, fn, d = match([(10, 10), (20, 10)], [(10.5, 10), (10.2, 10.1), (25, 10)], radius=2.0)
        self.assertEqual((tp, fp, fn), (1, 2, 1))           # two guesses on one person count once
        self.assertLess(d[0], 0.3)

    def test_matching_prefers_more_pairs_over_shorter_ones(self) -> None:
        # The closest pair (0 to B, 0.1 px) would block the only pairing of 1;
        # two matches within the radius beat one very good one.
        from tools.thermalml.metrics import match
        tp, _fp, _fn, _d = match([(0, 0), (1.9, 0)], [(0.1, 0), (3.5, 0)], radius=2.0)
        self.assertEqual(tp, 2)

    def test_f1_is_summed_over_frames_and_empty_frames_still_count_false_people(self) -> None:
        from tools.thermalml.metrics import Frame, score_frames
        s = score_frames([Frame(0, 3, 3, 3, 0, 0), Frame(1, 0, 1, 0, 1, 0)])
        self.assertAlmostEqual(s['f1'], 6 / 7)
        self.assertEqual(s['countMAE'], 0.5)
        self.assertEqual(s['exactCount'], 0.5)

    def test_intervals_resample_blocks_of_time_not_frames(self) -> None:
        from tools.thermalml.metrics import Frame, bootstrap
        # Two ten-minute blocks: one perfect, one all wrong. Frame-level
        # resampling of 200 frames would give a tight interval; two blocks cannot.
        frames = [Frame(i * 1000, 1, 1, 1, 0, 0) for i in range(100)] + \
                 [Frame(600_000 + i * 1000, 1, 1, 0, 1, 1) for i in range(100)]
        lo, hi = bootstrap(frames, n=400)['f1']
        self.assertLessEqual(lo, 0.01)
        self.assertGreaterEqual(hi, 0.99)


if __name__ == '__main__':
    unittest.main()
