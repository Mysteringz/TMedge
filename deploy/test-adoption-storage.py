#!/usr/bin/env python3
"""Claims about the production registry preparation, using private fixtures."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('adoption_storage', pathlib.Path(__file__).with_name('prepare-adoption-storage.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdoptionStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tm-adoption-storage-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.release = self.root / 'release'
        (self.release / 'config').mkdir(parents=True)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.registry = {'nodes': [{'uid': '01:02:03:04:05:06', 'label': 'Existing', 'floor': 'preserve-me'}]}
        (self.release / 'config/nodes.json').write_text(json.dumps(self.registry))
        self.env = self.root / '.env'
        self.original = f'DATA_DIR={self.data}\nPRIVATE_FIXTURE=never-print-this\n'
        self.env.write_text(self.original)

    def prepare(self, apply=False):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            module.prepare(self.env, self.release, apply)
        self.assertNotIn('never-print-this', output.getvalue())

    def test_dry_run_does_not_change_any_live_configuration(self):
        self.prepare()
        self.assertEqual(self.env.read_text(), self.original)
        self.assertFalse((self.data / 'adoption').exists())

    def test_apply_preserves_registry_and_secrets_with_private_backup(self):
        self.prepare(True)
        target = self.data / 'adoption/nodes.json'
        self.assertEqual(json.loads(target.read_text()), self.registry)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertIn(f'NODES_CONFIG={target}', self.env.read_text())
        backup = next(self.root.glob('.env.before-adoption-*'))
        self.assertEqual(backup.read_text(), self.original)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            self.prepare(True)
        self.assertEqual(json.loads(target.read_text()), self.registry)

    def test_existing_storage_or_config_cannot_be_replaced(self):
        (self.data / 'adoption').mkdir()
        with self.assertRaises(ValueError):
            self.prepare(True)
        self.assertEqual(self.env.read_text(), self.original)
        (self.data / 'adoption').rmdir()
        self.env.write_text(self.original + 'NODES_CONFIG=/existing/registry.json\n')
        with self.assertRaises(ValueError):
            self.prepare(True)
        self.assertFalse((self.data / 'adoption').exists())

    def test_release_local_data_postgres_and_invalid_identities_fail_before_writes(self):
        for content in ['DATA_DIR=' + str(self.release) + '\n', self.original + 'PERSISTENCE_MODE=postgres\n']:
            self.env.write_text(content)
            with self.assertRaises(ValueError):
                self.prepare(True)
            self.assertFalse((self.data / 'adoption').exists())
        self.env.write_text(self.original)
        self.registry['nodes'].append(dict(self.registry['nodes'][0]))
        (self.release / 'config/nodes.json').write_text(json.dumps(self.registry))
        with self.assertRaises(ValueError):
            self.prepare(True)
        self.assertEqual(self.env.read_text(), self.original)
        self.assertFalse((self.data / 'adoption').exists())


if __name__ == '__main__':
    unittest.main()
