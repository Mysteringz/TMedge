#!/usr/bin/env python3
"""Snapshot lifecycle and SSH/extraction claims. Never runs Java or SchemaSpy on the Mac."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


watcher, syncer, server = load('watch-schemaspy'), load('sync-schemaspy'), load('serve-schemaspy')
PNG = bytes([137,80,78,71,13,10,26,10]) + b'fixture'


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.report = self.root / 'source' / 'report'
        self.args = SimpleNamespace(output=str(self.report))
        self.version = 'a' * 64; self.builds = 0

    def tearDown(self):
        self.temporary.cleanup()

    def build(self, args):
        self.builds += 1
        self.report.mkdir(parents=True, exist_ok=True)
        (self.report / 'index.html').write_text('<html>training schema</html>')
        image = self.report / 'diagrams/summary/relationships.real.large.png'
        image.parent.mkdir(parents=True, exist_ok=True); image.write_bytes(PNG)
        (self.report / 'generated.json').write_text(json.dumps({'generatedAt': self.builds * 1000}))

    def publish(self):
        return watcher.watch(self.args, inspect=lambda _: self.version, build=self.build)

    def test_changes_publish_and_unchanged_catalog_skips_generation(self):
        self.assertTrue(self.publish()); self.assertEqual(self.builds, 1)
        self.assertFalse(self.publish()); self.assertEqual(self.builds, 1)
        self.version = 'b' * 64; self.assertTrue(self.publish()); self.assertEqual(self.builds, 2)
        status = json.loads((self.report.parent / 'report-status.json').read_text())
        archive = (self.report.parent / 'report.tar.gz').read_bytes()
        self.assertEqual(hashlib.sha256(archive).hexdigest(), status['sha256'])
        self.assertEqual(status['bytes'], len(archive)); self.assertEqual(status['generatedAt'], 2000)

    def test_failed_generation_keeps_published_bundle_and_retries_change(self):
        self.publish(); archive = (self.report.parent / 'report.tar.gz').read_bytes()
        self.version = 'b' * 64
        with self.assertRaises(RuntimeError):
            watcher.watch(self.args, inspect=lambda _: self.version, build=lambda _: (_ for _ in ()).throw(RuntimeError('failure')))
        self.assertEqual((self.report.parent / 'report.tar.gz').read_bytes(), archive)
        self.assertTrue(self.publish())

    def test_bundle_contains_only_report_files_and_forced_key_has_no_other_commands(self):
        self.publish(); (self.report.parent / 'reader.url').write_text('secret-not-a-report')
        archive = self.report.parent / 'report.tar.gz'
        with tarfile.open(archive) as bundle:
            self.assertNotIn('reader.url', bundle.getnames())
        output = io.BytesIO(); server.serve(self.report.parent, 'status', output)
        self.assertEqual(json.loads(output.getvalue())['generatedAt'], 1000)
        output = io.BytesIO(); server.serve(self.report.parent, 'report', output)
        self.assertEqual(output.getvalue(), archive.read_bytes())
        for command in ['bash', 'status; cat reader.url', 'cat /etc/shadow', '../reader.url', '']:
            with self.assertRaises(ValueError):
                server.serve(self.report.parent, command, io.BytesIO())

    def test_catalog_uses_read_only_role_and_row_counters_are_optional(self):
        credential = self.root / 'reader.url'
        credential.write_text('postgresql://crowdaware_reader:test-secret@127.0.0.1:55436/crowdaware_training'); credential.chmod(0o600)
        args = SimpleNamespace(reader_url_file=str(credential), psql='psql', schema_only=False)
        with patch.object(watcher.subprocess, 'run', return_value=SimpleNamespace(stdout=b'{"trackCounts":"on","tables":[],"data":[]}')) as command:
            fingerprint = watcher.fingerprint(args)
            self.assertEqual(len(fingerprint), 64)
            call = command.call_args
            self.assertNotIn('test-secret', ' '.join(call.args[0]))
            self.assertIn('n_tup_ins', call.args[0][-1]); self.assertIn('default_transaction_read_only=on', call.kwargs['env']['PGOPTIONS'])
            args.schema_only = True; self.assertEqual(watcher.fingerprint(args), fingerprint)
            self.assertNotIn('n_tup_ins', command.call_args.args[0][-1])
            args.schema_only = False
            command.return_value.stdout = b'{"trackCounts":"off"}'
            with self.assertRaises(ValueError):
                watcher.fingerprint(args)

    def test_extraction_rejects_links_traversal_duplicates_and_oversize(self):
        for unsafe in ['../escape', '/tmp/escape', '.credential', 'nested/.credential']:
            archive = self.root / 'unsafe.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                entry=tarfile.TarInfo(unsafe); entry.size=1; bundle.addfile(entry,io.BytesIO(b'x'))
            with self.assertRaises(ValueError):
                syncer.extract(archive,self.root/'extracted')
        for kind in ['link', 'duplicate', 'oversize']:
            archive=self.root/'unsafe.tar.gz'
            with tarfile.open(archive,'w:gz') as bundle:
                entry=tarfile.TarInfo('index.html')
                if kind=='link':
                    entry.type=tarfile.SYMTYPE;entry.linkname='/etc/passwd';bundle.addfile(entry)
                elif kind=='duplicate':
                    entry.size=1;bundle.addfile(entry,io.BytesIO(b'x'));bundle.addfile(entry,io.BytesIO(b'x'))
                else:
                    entry.size=129*1024**2
                    # An oversized header is enough: extraction refuses before reading its body.
                    bundle.fileobj.write(entry.tobuf())
            with self.assertRaises(ValueError):
                syncer.extract(archive,self.root/('extracted-'+kind))

    def test_sync_is_hash_checked_private_and_retains_last_snapshot_on_transfer_failure(self):
        self.publish()
        commands=self.root/'commands';commands.mkdir()
        ssh=commands/'ssh'
        ssh.write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
root=Path(os.environ['SCHEMA_TEST_SOURCE'])
command=sys.argv[-1]
if command=='status':sys.stdout.buffer.write((root/'report-status.json').read_bytes())
elif command=='report':sys.stdout.buffer.write(b'bad-transfer' if os.environ.get('SCHEMA_TEST_BAD') else (root/'report.tar.gz').read_bytes())
else:raise SystemExit(1)
''');ssh.chmod(0o755)
        key=self.root/'private.key';key.write_text('fixture-key');key.chmod(0o600)
        pins=self.root/'known_hosts';pins.write_text('fixture-pin')
        target=self.root/'edge'/'ml-schema'
        args=SimpleNamespace(host='report-reader@127.0.0.1',port=2222,identity_file=str(key),known_hosts=str(pins),output=str(target))
        environment={'PATH':str(commands)+os.pathsep+os.environ['PATH'],'SCHEMA_TEST_SOURCE':str(self.report.parent)}
        with patch.dict(os.environ,environment):
            self.assertTrue(syncer.sync(args));self.assertFalse(syncer.sync(args))
            self.assertEqual((target/'index.html').stat().st_mode&0o077,0)
            self.version='b'*64;self.publish()
            with patch.dict(os.environ,{'SCHEMA_TEST_BAD':'1'}),self.assertRaises(ValueError):
                syncer.sync(args)
            self.assertEqual(json.loads((target/'generated.json').read_text())['generatedAt'],1000)
            self.assertTrue(syncer.sync(args))
            self.assertEqual(json.loads((target/'generated.json').read_text())['generatedAt'],2000)


if __name__ == '__main__':
    unittest.main()
