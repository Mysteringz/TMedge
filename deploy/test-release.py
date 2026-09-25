#!/usr/bin/env python3
"""Security regressions for the privileged archive receiver."""
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from release import extract, safe_name


class ArchiveBoundary(unittest.TestCase):
    def test_disallowed_paths(self):
        for name in ('../x', '/etc/passwd', 'dist/../../x', '.env', 'node_modules/x', 'config/.env', 'deploy/run.sh'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_name(name)

    def test_links_devices_and_duplicates_rejected_before_extraction(self):
        for kind in ('symlink', 'hardlink', 'device', 'duplicate'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / 'bad.tgz'
                destination = Path(tmp) / 'output'
                with tarfile.open(archive, 'w:gz') as tar:
                    item = tarfile.TarInfo('config/site.json')
                    if kind == 'symlink':
                        item.type = tarfile.SYMTYPE
                        item.linkname = '/etc/passwd'
                    elif kind == 'hardlink':
                        item.type = tarfile.LNKTYPE
                        item.linkname = '/etc/passwd'
                    elif kind == 'device':
                        item.type = tarfile.CHRTYPE
                    tar.addfile(item, io.BytesIO())
                    if kind == 'duplicate':
                        tar.addfile(item, io.BytesIO())
                with self.assertRaises(ValueError):
                    extract(archive, destination)
                self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
