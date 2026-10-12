#!/usr/bin/env python3
"""Real streaming ZIP, disk limits, private protocol and download lease claims."""
import base64
from contextlib import redirect_stdout
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('remote-exports.py'))
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class Exports(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = self.root / 'archives'; self.store.mkdir(mode=0o700)
        self.identifier = str(uuid.uuid4())
        self.secret = self.root / 'reader.url'
        self.secret.write_text('postgresql://crowdaware_reader:fixture-secret@127.0.0.1:55436/crowdaware_training')
        self.secret.chmod(0o600)
        self.dump = self.root / 'pg_dump'
        self.dump.write_text("""#!/usr/bin/env python3
import os,sys
assert os.environ['PGUSER']=='crowdaware_reader'
assert 'default_transaction_read_only=on' in os.environ['PGOPTIONS']
assert 'fixture-secret' not in ' '.join(sys.argv)
sys.stdout.buffer.write(b'CREATE TABLE training.frames(id text);\\n')
""")
        self.dump.chmod(0o755)
        self.config = {'root': str(self.store), 'reader_url_file': str(self.secret), 'pg_dump': str(self.dump),
                       'reserve_bytes': 1, 'max_bytes': 1024 ** 2}

    def tearDown(self):
        self.temporary.cleanup()

    def generate(self, maximum=1024 ** 2):
        output = io.StringIO()
        with redirect_stdout(output):
            worker.generate(self.config, self.identifier, ['training.frames'], maximum, 1)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_real_private_zip_is_published_with_checksum_and_resumable_binary_ranges(self):
        messages = self.generate()
        complete = messages[-1]
        archive = self.store / (self.identifier + '.zip')
        payload = archive.read_bytes()
        self.assertEqual(complete['state'], 'completed')
        self.assertEqual(complete['bytes'], len(payload))
        self.assertEqual(complete['sha256'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(archive.stat().st_mode & 0o077, 0)
        self.assertNotIn(b'fixture-secret', payload)
        with zipfile.ZipFile(archive) as zipped:
            self.assertIsNone(zipped.testzip())
            self.assertEqual(set(zipped.namelist()), {'manifest.json', 'dataset.sql'})
            self.assertTrue(zipped.read('dataset.sql').startswith(b'CREATE SCHEMA IF NOT EXISTS training;\n'))
            self.assertEqual(json.loads(zipped.read('manifest.json'))['tables'], ['training.frames'])
        output = io.BytesIO()
        worker.download(self.config, self.identifier, 5, 10, output)
        self.assertEqual(output.getvalue(), payload[5:15])
        for start, length in [(-1, 10), (0, 0), (len(payload), 1)]:
            with self.assertRaises(worker.ExportError):
                worker.download(self.config, self.identifier, start, length, io.BytesIO())
        with self.assertRaises(worker.ExportError):
            self.generate()
        self.assertEqual(archive.read_bytes(), payload)

    def test_failed_dump_and_quota_never_publish_partial_downloads(self):
        for reason in ['database', 'too_large', 'disk_full']:
            self.identifier = str(uuid.uuid4())
            if reason == 'database':
                self.dump.write_text('#!/usr/bin/env python3\nimport sys\nsys.stdout.write("partial")\nsys.exit(1)\n')
            else:
                self.dump.write_text('#!/usr/bin/env python3\nprint("valid SQL")\n')
            maximum = 10 if reason == 'too_large' else 1024 ** 2
            with patch.object(worker, 'free_bytes', return_value=0 if reason == 'disk_full' else 1024 ** 3):
                with self.assertRaises(worker.ExportError) as caught:
                    self.generate(maximum)
            self.assertEqual(str(caught.exception), reason)
            self.assertFalse((self.store / (self.identifier + '.zip')).exists())
            self.assertFalse((self.store / (self.identifier + '.part')).exists())

    def test_cleanup_preserves_active_download_leases_and_expiry_blocks_new_downloads(self):
        self.generate()
        receipt = self.store / (self.identifier + '.json')
        value = json.loads(receipt.read_text())
        value['expiresAt'] = 1; receipt.write_text(json.dumps(value))
        with self.assertRaises(worker.ExportError):
            worker.download(self.config, self.identifier, 0, 1, io.BytesIO())
        with (self.store / (self.identifier + '.lock')).open('a') as lease:
            fcntl.flock(lease, fcntl.LOCK_SH)
            self.assertEqual(worker.cleanup(self.config), 0)
            self.assertTrue((self.store / (self.identifier + '.zip')).is_file())
        self.assertEqual(worker.cleanup(self.config), 1)
        self.assertFalse(receipt.exists())
        self.assertFalse((self.store / (self.identifier + '.zip')).exists())

    def test_shared_generation_lock_refuses_concurrent_exports(self):
        with (self.store / '.generate.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaises(worker.ExportError) as caught:
                self.generate()
            self.assertEqual(str(caught.exception), 'busy')

    def test_only_training_tables_and_fixed_commands_are_accepted(self):
        for command in ['bash', 'cat /etc/shadow', 'download ../reader.url 0 10', 'download ' + self.identifier + ' 0 10; cat reader.url',
                        'generate ' + self.identifier + ' bad 1 1', 'generate ' + self.identifier + ' e30= 1 1']:
            with self.assertRaises((worker.ExportError, ValueError)):
                worker.dispatch(self.config, command, io.BytesIO())
        for selection in [[], ['public.users'], ['training.frames;drop table training.frames'], ['training.frames'] * 2]:
            encoded = base64.b64encode(json.dumps(selection).encode()).decode()
            with self.assertRaises(worker.ExportError):
                worker.tables(encoded)
        self.secret.chmod(0o644)
        with self.assertRaises(worker.ExportError):
            worker.database(self.config)
        self.secret.chmod(0o600)
        self.secret.write_text('postgresql://crowdaware_ingest:secret@127.0.0.1/crowdaware_training')
        with self.assertRaises(worker.ExportError):
            worker.database(self.config)

    def test_configuration_requires_private_storage_and_rejects_unknown_or_invalid_fields(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps(self.config)); path.chmod(0o600)
        self.assertEqual(worker.load_config(path)['root'], str(self.store))
        for change in [{'max_bytes': 0}, {'reserve_bytes': True}, {'root': 'relative/path'}, {'arbitrary_option': True}]:
            path.write_text(json.dumps({**self.config, **change}))
            with self.assertRaises(worker.ExportError):
                worker.load_config(path)
        path.write_text(json.dumps(self.config)); path.chmod(0o644)
        with self.assertRaises(worker.ExportError):
            worker.load_config(path)


if __name__ == '__main__':
    unittest.main()
