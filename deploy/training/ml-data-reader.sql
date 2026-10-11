-- pg_dump must preserve identity sequence positions as well as table rows.
-- SELECT grants no nextval/setval authority (those need USAGE/UPDATE).
BEGIN;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA training TO crowdaware_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA training GRANT SELECT ON SEQUENCES TO crowdaware_reader;
COMMIT;
