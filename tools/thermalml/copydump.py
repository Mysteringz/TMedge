"""
Rows of a plain-SQL pg_dump, read as a stream.

The console's ML-data export is `dataset.sql` from pg_dump inside a ZIP, and
the frames table alone is ~16 GB of it. It is read row by row straight out of
the archive: unpacking it first would need that much free disk again, and
restoring it would need a PostgreSQL server nobody runs on the Mac.
"""
from __future__ import annotations

import io
import zipfile
from contextlib import contextmanager
from typing import BinaryIO, Iterable, Iterator

_SIMPLE = {'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\'}
_OCTAL = '01234567'
_HEX = '0123456789abcdefABCDEF'


class DumpError(ValueError):
    pass


def unescape(field: bytes) -> str | None:
    """One COPY text-format field: `\\N` is NULL and backslash escapes are undone."""
    if field == b'\\N':
        return None
    if b'\\' not in field:
        return field.decode('utf-8')
    s = field.decode('utf-8')
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c != '\\' or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        d = s[i + 1]
        if d in _SIMPLE:
            out.append(_SIMPLE[d])
            i += 2
        elif d in _OCTAL:
            j = i + 1
            while j < n and j < i + 4 and s[j] in _OCTAL:
                j += 1
            out.append(chr(int(s[i + 1:j], 8)))
            i = j
        elif d == 'x' and i + 2 < n and s[i + 2] in _HEX:
            j = i + 2
            while j < n and j < i + 4 and s[j] in _HEX:
                j += 1
            out.append(chr(int(s[i + 2:j], 16)))
            i = j
        else:
            out.append(d)
            i += 2
    return ''.join(out)


def bytea(field: bytes) -> bytes | None:
    """A bytea field. pg_dump writes it as hex, `\\x...`, with the backslash itself escaped."""
    if field == b'\\N':
        return None
    if not field.startswith(b'\\\\x'):
        raise DumpError('bytea field is not in hex format')
    return bytes.fromhex(field[3:].decode('ascii'))


def iter_copy(lines: Iterable[bytes], table: str) -> Iterator[dict[str, bytes]]:
    """
    The rows of `COPY <table> (...) FROM stdin;` as {column: raw field}.

    Fields stay raw bytes so a caller decodes only the columns it needs: a
    frames row carries an 80 kB JPEG it may not want. A block that never
    reaches its `\\.` terminator raises, because a truncated export must not
    pass for a small one.
    """
    header = f'COPY {table} ('.encode()
    cols: list[str] | None = None
    for line in lines:
        if cols is None:
            if line.startswith(header):
                inside = line[len(header):line.index(b')')]
                cols = [c.strip().decode() for c in inside.split(b',')]
            continue
        if line.startswith(b'\\.'):
            return
        fields = line.rstrip(b'\n').split(b'\t')
        if len(fields) != len(cols):
            raise DumpError(f'{table}: row has {len(fields)} fields, expected {len(cols)}')
        yield dict(zip(cols, fields))
    if cols is None:
        raise DumpError(f'no COPY block for {table}')
    raise DumpError(f'COPY block for {table} ended without its terminator: truncated dump?')


@contextmanager
def open_dump(path: str) -> Iterator[BinaryIO]:
    """`dataset.sql` from an export ZIP, or a bare .sql file, as a buffered binary stream."""
    if path.endswith('.zip'):
        with zipfile.ZipFile(path) as zf:
            with zf.open('dataset.sql') as member:
                # ZipExtFile.readline is Python-level; a C BufferedReader on top
                # reads it in megabyte chunks instead.
                yield io.BufferedReader(member, buffer_size=1 << 20)  # type: ignore[arg-type]
    else:
        with open(path, 'rb', buffering=1 << 20) as f:
            yield f


def manifest(path: str) -> dict:
    """The export's manifest.json (which tables, when), or {} for a bare .sql."""
    import json
    if not path.endswith('.zip'):
        return {}
    with zipfile.ZipFile(path) as zf:
        if 'manifest.json' not in zf.namelist():
            return {}
        return json.loads(zf.read('manifest.json'))
