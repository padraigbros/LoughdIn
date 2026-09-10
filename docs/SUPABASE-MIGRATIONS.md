# Supabase migration reconciliation

The canonical local migration is `supabase/migrations/202609080001_sync_foundation.sql`.
This file records the safe procedure for reconciling its history with project
`kknbyhlwmuzttyxyuffe`; it does not assert that the remote project is currently
in sync.

## Inspect first

From `app/`, authenticate and link the CLI, then compare local and remote
history:

```sh
npx --no-install supabase login
npx --no-install supabase link --project-ref kknbyhlwmuzttyxyuffe
npx --no-install supabase migration list --linked
```

`migration list` compares local migration filenames with
`supabase_migrations.schema_migrations` by timestamp. Save the output for the
change record. Do not run `db push` until the discrepancy and deployed schema
have been identified.

## Repair only a history row

If inspection proves that the SQL was already applied successfully but the
remote history row is missing, mark only that known version as applied:

```sh
npx --no-install supabase migration repair 202609080001 --status applied --linked
npx --no-install supabase migration list --linked
```

If a remote row represents a migration that was never applied (or its SQL was
rolled back), stop and investigate; marking it `reverted` deletes history and
can cause a later push to execute SQL unexpectedly. Never use `repair` to hide
a schema mismatch.

## Push and verify

After history and schema have been independently confirmed:

```sh
npx --no-install supabase db push --linked --dry-run
npx --no-install supabase db push --linked
npx --no-install supabase migration list --linked
```

Capture the final status and a schema/RLS verification from the Supabase
dashboard or a privileged database connection. `db push` and `migration repair`
require project access; no credential, token, service-role key, or database
password belongs in this repository or CI logs.

## Local checks

The disposable SQL contract fixture can be run against a local PostgreSQL
instance using `tests/server/bootstrap.sql`. It validates the migration's
contract, but cannot prove the state of the hosted project.

The CLI is an exact development dependency. Keep `package.json` and
`package-lock.json` together, and use `npx --no-install` so migration commands
cannot silently download a different CLI release.
