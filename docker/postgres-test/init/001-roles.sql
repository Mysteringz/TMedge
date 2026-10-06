\getenv migration_password PG_MIGRATION_PASSWORD
\getenv runtime_password PG_RUNTIME_PASSWORD

SELECT format('CREATE ROLE tmedge_migrator LOGIN PASSWORD %L', :'migration_password') \gexec
SELECT format('CREATE ROLE tmedge_runtime LOGIN PASSWORD %L', :'runtime_password') \gexec

REVOKE ALL ON DATABASE tmedge_test FROM PUBLIC;
GRANT CONNECT ON DATABASE tmedge_test TO tmedge_migrator, tmedge_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO tmedge_migrator;
GRANT USAGE ON SCHEMA public TO tmedge_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE tmedge_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tmedge_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE tmedge_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tmedge_runtime;
