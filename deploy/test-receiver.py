#!/usr/bin/env python3
"""Exercise the forced-command transport with a local temporary release store."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('ci-receiver.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class Transport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / 'releases'
        self.remote = self.root / 'remote.sh'
        self.remote.write_text('set -eu\ntest "$TM_LOCK_HELD" = 1\ntest "$1" = activate\n')
        self.id = '20260925T000000Z-012345678901'
        self.archive = self.make_archive()
        self.digest = hashlib.sha256(self.archive).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def make_archive(self):
        files = {name: b'{}' for name in ('package.json', 'package-lock.json',
                 'dist/src/web/main.js', 'dist/src/edge/main.js',
                 'public-web/index.html', 'public-algo/index.html')}
        files['RELEASE.json'] = json.dumps({'id': self.id, 'commit': '0' * 40}).encode()
        files['MANIFEST.json'] = json.dumps({k: hashlib.sha256(v).hexdigest() for k, v in files.items()}).encode()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return stream.getvalue()

    def run_command(self, command):
        with patch.object(receiver, 'BASE', self.base), patch.object(receiver, 'REMOTE', self.remote), \
             patch.object(sys, 'argv', ['receiver', command]), \
             patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(self.archive))):
            receiver.main()

    def test_arbitrary_shell_is_rejected(self):
        for cmd in ('uname -a', 'deploy abc; id', 'rollback ../etc', ''):
            with self.subTest(cmd=cmd), self.assertRaises(ValueError):
                self.run_command(cmd)
        self.assertFalse(self.base.exists())

    def test_bad_checksum_cannot_create_a_release(self):
        with self.assertRaises(ValueError):
            self.run_command('deploy ' + '0' * 64)
        self.assertFalse((self.base / self.id).exists())

    def test_valid_archive_activates_but_cannot_overwrite(self):
        self.run_command('deploy ' + self.digest)
        self.assertTrue((self.base / self.id / 'MANIFEST.json').is_file())
        with self.assertRaises(ValueError):
            self.run_command('deploy ' + self.digest)

    def test_failed_install_is_not_a_rollback_candidate(self):
        self.remote.write_text('exit 1\n')
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_command('deploy ' + self.digest)
        self.assertFalse((self.base / self.id).exists())

    def test_concurrent_receive_is_refused(self):
        self.base.mkdir()
        with (self.base / '.lock').open('w') as lock:
            receiver.fcntl.flock(lock, receiver.fcntl.LOCK_EX | receiver.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.run_command('deploy ' + self.digest)


if __name__ == '__main__':
    unittest.main()
