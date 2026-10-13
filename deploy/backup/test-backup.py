#!/usr/bin/env python3
"""Standby state must fail closed before touching private files."""
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('standby', Path(__file__).with_name('standby.py'))
standby = importlib.util.module_from_spec(spec)
spec.loader.exec_module(standby)


def archive(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as stream:
        for name, body, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(body) if kind == tarfile.REGTYPE else 0
            if kind == tarfile.SYMTYPE:
                member.linkname = '/etc/passwd'
            stream.addfile(member, io.BytesIO(body) if member.isfile() else None)
    return result.getvalue()


class StateSafety(unittest.TestCase):
    def attempt(self, entries):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / '.env'
            path.write_bytes(b'original private environment')
            data = archive(entries)
            def transport(args, **kwargs):
                kwargs['stdout'].write(data)
            account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(standby, 'STATE_MAP', {'opt/tmedge-shared/.env': path}), \
                 patch.object(standby, 'ssh', return_value=['fake-ssh']), \
                 patch.object(standby.pwd, 'getpwnam', return_value=account), \
                 patch.object(standby.subprocess, 'run', side_effect=transport):
                with self.assertRaises(ValueError):
                    standby.sync_state()
            self.assertEqual(path.read_bytes(), b'original private environment')

    def test_traversal_is_refused_before_any_file_is_changed(self):
        self.attempt([('opt/tmedge-shared/.env', b'TM_KEY=test\n', tarfile.REGTYPE),
                      ('../../etc/passwd', b'injected', tarfile.REGTYPE)])

    def test_duplicate_environment_cannot_override_the_first_copy(self):
        self.attempt([('opt/tmedge-shared/.env', b'TM_KEY=test\n', tarfile.REGTYPE),
                      ('opt/tmedge-shared/.env', b'TM_KEY=other\n', tarfile.REGTYPE)])

    def test_symlinks_cannot_read_or_overwrite_files_outside_the_allowlist(self):
        self.attempt([('opt/tmedge-shared/.env', b'', tarfile.SYMTYPE)])

    def test_a_partial_export_does_not_replace_the_last_valid_environment(self):
        self.attempt([])

    def test_primary_configuration_cannot_enable_a_second_writer_or_publisher(self):
        result = standby.standby_environment(b'SIGNUP_OPEN=1\nWEB_PUSH_URLS=http://primary\nEMAIL_FROM=sender\nEMAIL_SES_REGION=region\nEMAIL_CONSOLE_URL=https://console\nSESSION_SECRET=test-fixture\n')
        values = dict(line.split('=', 1) for line in result.decode().splitlines())
        self.assertEqual(values['SIGNUP_OPEN'], '0')
        self.assertEqual(values['WEB_PUSH_URLS'], '')
        self.assertEqual(values['EMAIL_FROM'], '')
        self.assertEqual(values['EMAIL_CONSOLE_URL'], '')
        self.assertEqual(values['SESSION_SECRET'], 'test-fixture')


if __name__ == '__main__':
    unittest.main()
