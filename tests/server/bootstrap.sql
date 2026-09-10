\set ON_ERROR_STOP on

-- Disposable-Postgres harness for the migrations. Run only against an empty test
-- database: psql "$TEST_DATABASE_URL" -f tests/server/sync_foundation.sql
\ir auth-shim.sql
\ir ../../supabase/migrations/202609080001_sync_foundation.sql
