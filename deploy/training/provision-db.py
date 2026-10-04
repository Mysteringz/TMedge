#!/usr/bin/env python3
"""Run on Proxmox: provision dedicated non-superuser roles and credentials."""
import json
import secrets
import subprocess
from pathlib import Path


def psql(sql, db='postgres'):
    subprocess.run(['pct', 'exec', '105', '--', 'runuser', '-u', 'postgres', '--',
                    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', db], input=sql.encode(), check=True)


if __name__ == '__main__':
    credentials = Path('/root/crowdaware-training-credentials.json')
    if credentials.exists():
        c = json.loads(credentials.read_text())
    else:
        c = {'writer': secrets.token_hex(32), 'reader': secrets.token_hex(32)}
        credentials.touch(mode=0o600)
        credentials.write_text(json.dumps(c))
    psql("CREATE ROLE crowdaware_ingest LOGIN PASSWORD '" + c['writer'] + "';\n"
         "CREATE ROLE crowdaware_reader LOGIN PASSWORD '" + c['reader'] + "';\n"
         "CREATE DATABASE crowdaware_training;\n")
    psql(Path('/root/crowdaware-schema.sql').read_text(), 'crowdaware_training')
    psql('''REVOKE ALL ON DATABASE crowdaware_training FROM PUBLIC;
      GRANT CONNECT ON DATABASE crowdaware_training TO crowdaware_ingest, crowdaware_reader;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA training TO crowdaware_ingest, crowdaware_reader;
      GRANT SELECT, INSERT ON training.frames, training.pairs TO crowdaware_ingest;
      GRANT SELECT ON training.ml_samples TO crowdaware_ingest;
      GRANT SELECT ON ALL TABLES IN SCHEMA training TO crowdaware_reader;
      ALTER DEFAULT PRIVILEGES IN SCHEMA training GRANT SELECT ON TABLES TO crowdaware_reader;
      ''', 'crowdaware_training')
    # Existing guest listens on LAN. A first-match rule limits these roles to
    # the Proxmox tunnel endpoint, without changing other database access.
    hba = '/etc/postgresql/18/main/pg_hba.conf'
    old = subprocess.check_output(['pct', 'exec', '105', '--', 'cat', hba]).decode()
    rules = ('host crowdaware_training crowdaware_ingest,crowdaware_reader 192.168.0.5/32 scram-sha-256\n'
             'host crowdaware_training all 0.0.0.0/0 reject\n'
             'host crowdaware_training all ::/0 reject\n')
    subprocess.run(['pct', 'exec', '105', '--', 'tee', hba], input=(rules + old).encode(),
                   stdout=subprocess.DEVNULL, check=True)
    psql('SELECT pg_reload_conf();')
