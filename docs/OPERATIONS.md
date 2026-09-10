# Operations runbook

Launch safeguards for the web beta: what is automated, what a person has to do
in the Supabase dashboard, and how to get back to a known-good state.

Automated checks live in `.github/workflows/ci.yml`. Everything under
"Requires dashboard access" is deliberately not automated, because it needs
credentials that must never enter this repository.

## Continuous integration

`ci.yml` runs on every pull request and on every push to `master`:

| Step | What it protects |
| --- | --- |
| `npm run check` | Every file in `src/` parses. |
| `npm run build` | The publishable tree still builds. |
| `npm test` | Client, PWA, planner, sync, two-client acceptance, and backup recovery suites. |
| `tests/server/sync_foundation.sql` | The command, conflict, cursor and row level security contract. |
| `tests/server/retention.sql` | Pruning bounds history without letting a client silently miss changes. |
| Migrations apply in order | Every file in `supabase/migrations/` applies to an empty database in filename order. |

The last step catches a migration that only works because of state left behind
by an earlier manual run. Adding a migration file is enough for it to be
covered; nothing needs to be registered.

## Retention

`private.prune_all_sync_history(p_keep_days, p_keep_minimum)` bounds
`private.change_log`, `private.operation_receipts` and resolved
`private.conflicts`. It advances
`private.sync_heads.minimum_retained_sequence`, so a client that has fallen
behind the window is told to bootstrap through the existing `stale_cursor` path
rather than quietly missing changes.

Defaults keep 30 days and never prune inside the newest 500 entries for an
account. Pruning receipts means a device replaying a command older than the
window will not be recognised as a duplicate; that device is already past the
cursor floor and will bootstrap instead, which is why the two windows must stay
the same length.

Schedule it as the service role, daily, off-peak:

```sql
select private.prune_all_sync_history(30, 500);
```

The function is not granted to `anon` or `authenticated` and must never be.

## Verifying the offline launch

`tests/pwa.test.js` proves the service worker precaches the whole shell and that
the build emits only publishable files. It cannot prove the deployed site boots
without a network. Run this against the live site after a deploy that touches
`sw.js`, `index.html`, or anything in `src/`, `styles/` or `vendor/`.

Load `https://padraigbros.github.io/LoughdIn/`, wait for the worker to activate,
then in the console:

```js
const reg = await navigator.serviceWorker.ready;
const cache = await caches.open((await caches.keys()).find(n => n.startsWith('loughdin-shell:')));
console.log((await cache.keys()).length, 'assets cached at', reg.scope);
```

Reload, then check what actually came over the network:

```js
const nav = performance.getEntriesByType('navigation')[0];
const rows = performance.getEntriesByType('resource');
console.log({
  navigationFromWorker: nav.workerStart > 0 && nav.transferSize === 0,
  networkBytes: rows.filter(r => r.transferSize > 0).map(r => r.name),
  deliveryTypes: [...new Set(rows.map(r => r.deliveryType))],
});
```

A passing run shows the navigation served by the worker with zero transfer,
`networkBytes` empty, and every resource delivered as `cache-storage`. Zero
network bytes is the assertion that matters: nothing was requested over the
network, so the absence of one cannot change the result.

Note the navigation fallback returns the cached `index.html` for **any** path
inside the scope. At a deeper path the document renders but its relative script
and style URLs resolve against that deeper path and are not in the cache, so the
app does not start. This only matters if something ever links below
`/LoughdIn/`. The app has no client-side routing and auth callbacks return to
the scope root, so nothing does today.

## Requires dashboard access

### Monitoring and alerts

In the Supabase dashboard, under Logs and Reports, add alerts for:

- **Auth failures.** A sustained rise in failed sign-ins or confirmations
  usually means the SMTP or redirect configuration in
  `docs/AUTH-SMTP-RUNBOOK.md` has drifted.
- **RPC errors by SQLSTATE.** The schema raises deliberate codes, and each one
  means something different:

| Code | Meaning | Normal? |
| --- | --- | --- |
| `28000` | No authenticated user | Only at token expiry |
| `42501` | Unregistered or revoked device | Should be near zero after sign-in |
| `P0001` | `stale_cursor`, client must bootstrap | Expected, but a spike means retention is too aggressive |
| `22023` | Malformed command or reused `opId` | Should be zero; indicates a client bug |
| `22P02` | Invalid enum value | Should be zero; indicates a client vocabulary mismatch |
| `23503` | Block references a missing task | Should be rare |
| `54000` | Too many future blocks for one delete | Rare, but a real user can hit it |
| `55000` | Attempt to rewrite immutable history | Should be zero outside the retention job |

- **Database load and connections**, so a runaway client is visible before it
  exhausts the pool.
- **Plan quota**, on storage, egress and monthly active users.

### Backup and restore

Confirm in the dashboard which backup tier the project is on, and record the
retention period and the recovery point objective in this file once known.

Verify a restore before beta, never after an incident:

1. Create a separate Supabase project for the drill. Never restore over
   production.
2. Restore the most recent backup into it.
3. Apply the migrations in `supabase/migrations/` in filename order and confirm
   the CLI reports no pending migration.
4. Point a local build at the drill project by editing `src/config.js`, sign in
   as a test account, and confirm tasks, blocks and sessions are present and
   that a new command applies.
5. Record the date, the backup timestamp, and how long the restore took.
6. Delete the drill project.

Repeat the drill after any schema change that rewrites data.

### Rollback

**Frontend.** Pages deploys from `master` through `deploy.yml`. To roll back,
revert the offending commit on `master` and let the workflow redeploy. Do not
delete the Pages deployment; a revert leaves a trail and a forward path. Users
already holding the old service worker will pick up the reverted build on their
next load, because `sw.js` is versioned by cache name.

**Database.** Never delete or edit an applied migration. Write a forward
migration that undoes the change, and keep the original in history so the
migration ledger stays consistent with the remote. See
`docs/SUPABASE-MIGRATIONS.md` for the reconciliation procedure.

A destructive change needs a written back-out plan before it is applied,
including which rows it touches and how they would be reconstructed. If it
cannot be reconstructed from a backup within the retention window, it is not
ready to apply.

## User recovery

Every account can export its own data from the account dialog, with no server
involvement. `tests/backup-recovery.test.js` covers the behaviour this relies
on.

**To take a backup.** Account and sync, then Export backup. The file contains
local state and any unsent commands.

**To restore onto a device that lost its data.** Sign out first: import is
disabled while signed in, because a merge would replay against canonical data
the device has not seen. Import the file, confirm the tasks are present, then
sign back in and let sync reconcile.

**What import does.** It merges rather than replaces, so nothing already on the
device is deleted. A record whose id collides with an existing, different record
is kept under a new id rather than overwritten. A pre-import copy of local state
is written to the `backups` object store before anything changes.

**If the local database is corrupt.** The store opens in recovery mode, refuses
writes, and `exportJSON` returns the raw unparsed data under the
`loughdin-recovery` format. Keep that file: it is the only copy of whatever
could not be parsed. Signing in on a fresh browser profile and pulling from the
server is the fastest route back to a working device.
