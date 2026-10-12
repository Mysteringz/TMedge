#!/usr/bin/env python3
"""Proxmox-only change detector. Coalesce writes into one private SchemaSpy snapshot."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
from urllib.parse import unquote, urlsplit

CATALOG = """
SELECT json_build_object(
 'trackCounts', current_setting('track_counts'),
 'tables', (SELECT json_agg(t ORDER BY t.name) FROM (
  SELECT c.relname AS name,c.relkind,c.relfilenode,obj_description(c.oid) AS comment,
   CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END AS definition
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='training' AND c.relkind IN ('r','p','v')) t),
 'columns', (SELECT json_agg(a ORDER BY a.name,a.number) FROM (
  SELECT c.relname AS name,a.attnum AS number,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
   a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value,
   col_description(c.oid,a.attnum) AS comment
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='training' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v')) a),
 'constraints', (SELECT json_agg(k ORDER BY k.name,k.constraint_name) FROM (
  SELECT c.relname AS name,k.conname AS constraint_name,pg_get_constraintdef(k.oid,true) AS definition
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='training') k),
 'indexes', (SELECT json_agg(i ORDER BY i.tablename,i.indexname) FROM (
  SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='training') i),
 'data', DATA_CHANGES
)::text;
"""
DATA = """(SELECT json_agg(s ORDER BY s.relname) FROM (
 SELECT relname,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables WHERE schemaname='training') s)"""


def fingerprint(args):
    path = Path(args.reader_url_file)
    if path.stat().st_mode & 0o077:
        raise ValueError('reader credential must be private')
    url = urlsplit(path.read_text().strip())
    if url.scheme not in ('postgres', 'postgresql') or url.username != 'crowdaware_reader' or url.path != '/crowdaware_training' or url.query or url.fragment:
        raise ValueError('requires the dedicated training reader')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PGHOST': url.hostname,
           'PGPORT': str(url.port or 5432), 'PGDATABASE': 'crowdaware_training', 'PGUSER': 'crowdaware_reader',
           'PGPASSWORD': unquote(url.password or ''), 'PGCONNECT_TIMEOUT': '5', 'PGAPPNAME': 'schemaspy-watch',
           'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=10000'}
    result = subprocess.run([args.psql, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c',
                             CATALOG.replace('DATA_CHANGES', 'NULL' if args.schema_only else DATA)],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    if len(result.stdout) > 4 * 1024 ** 2:
        raise ValueError('catalog exceeds size limit')
    value = json.loads(result.stdout)
    if not args.schema_only and value.get('trackCounts') != 'on':
        raise ValueError('row-change monitoring requires PostgreSQL track_counts')
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def generate(args):
    spec = importlib.util.spec_from_file_location('schemaspy_generator', Path(__file__).with_name('generate-schemaspy.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.generate(args)


def watch(args, inspect=fingerprint, build=generate):
    report = Path(args.output).resolve()
    parent = report.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    with (parent / '.schemaspy-watch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        version = inspect(args)
        state = parent / 'report-status.json'
        try:
            previous = json.loads(state.read_text())
        except (OSError, ValueError):
            previous = {}
        archive = parent / 'report.tar.gz'
        if previous.get('fingerprint') == version and archive.is_file() and (report / 'index.html').is_file():
            return False
        build(args)
        metadata = json.loads((report / 'generated.json').read_text())
        temporary = parent / '.report.tar.gz.tmp'
        try:
            with tarfile.open(temporary, 'w:gz') as bundle:
                for path in sorted(report.rglob('*')):
                    if path.is_symlink():
                        raise ValueError('report contains a symlink')
                    if path.is_file():
                        bundle.add(path, arcname=path.relative_to(report), recursive=False)
            temporary.chmod(0o640)
            digest = hashlib.sha256()
            with temporary.open('rb') as source:
                for block in iter(lambda: source.read(65536), b''):
                    digest.update(block)
            status = {'fingerprint': version, 'sha256': digest.hexdigest(), 'bytes': temporary.stat().st_size,
                      'generatedAt': metadata['generatedAt']}
            if status['bytes'] > 64 * 1024 ** 2:
                raise ValueError('report archive exceeds size limit')
            temporary.replace(archive)
            receipt = parent / '.report-status.tmp'
            receipt.write_text(json.dumps(status)); receipt.chmod(0o640); receipt.replace(state)
        finally:
            temporary.unlink(missing_ok=True)
        return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reader-url-file', required=True)
    parser.add_argument('--schemaspy-jar', required=True)
    parser.add_argument('--jdbc-jar', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--psql', default='/usr/bin/psql')
    parser.add_argument('--schema-only', action='store_true', help='Ignore row-write counters')
    try:
        print('SchemaSpy updated.' if watch(parser.parse_args()) else 'SchemaSpy is current.')
    except Exception:
        raise SystemExit('SchemaSpy update failed; last published snapshot retained. Check private server configuration.')
