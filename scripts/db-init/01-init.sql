-- Runs once on first Postgres start (docker-entrypoint-initdb.d).
-- aegis_owner owns the schema; aegis_app is the runtime role: NON-OWNER, no BYPASSRLS,
-- so Row-Level Security is genuinely enforced for the application.
CREATE ROLE aegis_app LOGIN PASSWORD 'aegis_app_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE aegis TO aegis_app;
\connect aegis
GRANT USAGE ON SCHEMA public TO aegis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aegis_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aegis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aegis_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aegis_app;
-- app.current_tenant / app.current_user are set per-transaction via SET LOCAL by @aegis/db.
