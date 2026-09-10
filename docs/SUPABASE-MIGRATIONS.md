# Supabase migration reconciliation

Project `kknbyhlwmuzttyxyuffe` was first deployed by pasting
`supabase/migrations/202609080001_sync_foundation.sql` into the hosted SQL
Editor. That created every object but left `supabase_migrations.schema_migrations`
empty, so the CLI believed no migration had ever been applied and a `db push`
would have tried to run the whole file again.

That is now reconciled. This file records what was compared, what was changed,
and how to keep the two in step.

## Status

| | |
| --- | --- |
| Reconciled | 10 September 2026 |
| Ledger contains | `202609080001` `sync_foundation`, `202609100001` `sync_retention` |
| Remote schema | Verified identical to the checked-in migration |
| Applied but unrecorded | None |
| Recorded but unapplied | None |

`202609100001_sync_retention.sql` was applied later the same day with
`supabase db push --linked`, so its ledger row carries recorded statements while
the repaired foundation row carries none. That difference is expected and is how
you can tell a repair from a push.

Each of its three function bodies on the server is byte-identical to the file,
and both pruning functions are `security definer` with `postgres` as the only
privilege holder. Nothing was granted to `anon` or `authenticated`.

## What was compared before touching history

Repair is only safe once the deployed schema has been proved to match the file.
Every one of these was checked against the remote catalog, and all matched:

- **Function bodies.** `md5(pg_proc.prosrc)` for all eleven functions equals the
  md5 of the corresponding `$fn$ ... $fn$` body in the migration file. Postgres
  stores the body verbatim, so this is a byte-for-byte comparison, not a
  similarity check.
- **Security attributes.** The four public RPCs are `security definer`; the
  seven `private` helpers are not. All eleven pin `search_path = ''`.
- **Columns.** All nine tables match on name, ordinal position, type,
  nullability and default.
- **Indexes and constraints.** 24 indexes and 66 constraints, which is exactly
  the count the file produces: 11 named indexes, 1 partial unique index, 9
  primary keys, 2 unique constraints and the `time_blocks` exclusion index.
- **Enums.** All nine types, with labels in the declared order.
- **Row level security.** Four select-only policies for `authenticated` on
  `owner_id = (select auth.uid())`, and nothing else.
- **Triggers.** Both immutability triggers on `private.operation_receipts` and
  `private.change_log`.
- **Grants.** The four `private` tables carry no ACL at all. The four public
  tables grant only `select`, only to `authenticated`. The four RPCs grant
  `execute` only to `authenticated`. Neither `anon` nor `public` holds anything.
- **Extensions.** `pgcrypto` in `extensions`, `btree_gist` in `public`, matching
  the file.

## What was changed

One row, and nothing else:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('202609080001', 'sync_foundation');
```

`statements` is left null, which is what the CLI itself writes for a repaired
row. This is the same effect as:

```sh
npx --no-install supabase migration repair 202609080001 --status applied --linked
```

The CLI form is preferred when a CLI session is available. The direct insert was
used because the reconciliation ran through the Supabase management connection
rather than a linked CLI. No schema object was created, altered or dropped.

## Forward workflow

```sh
npx --no-install supabase login
npx --no-install supabase link --project-ref kknbyhlwmuzttyxyuffe
npx --no-install supabase migration list --linked
npx --no-install supabase db push --linked --dry-run
npx --no-install supabase db push --linked
```

`migration list` should show every local file present remotely and nothing
remote that is missing locally. A dry run that plans zero statements is the
no-op result to expect when the two are already in step.

The CLI is an exact development dependency. Keep `package.json` and
`package-lock.json` together and use `npx --no-install` so a migration command
cannot silently pull a different CLI release.

## Rules

Never edit or delete a migration that has been applied. Write a forward
migration that undoes the change and leave the original in history.

Never use `repair` to hide a schema mismatch. Marking a row `reverted` deletes
history and can make a later push execute SQL you did not expect. If inspection
shows the remote schema differs from the file, stop and reconcile the schema
first.

No credential, access token, service-role key or database password belongs in
this repository or in CI logs.

## Local checks

`tests/server/sync_foundation.sql` and `tests/server/retention.sql` run the
contract against a disposable PostgreSQL in CI, and a third CI step applies
every file in `supabase/migrations/` to an empty database in filename order.
Those prove the migrations are correct and ordered. They cannot prove the state
of the hosted project, which is what the comparison above is for.
