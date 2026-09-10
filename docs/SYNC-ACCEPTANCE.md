# Sync acceptance checklist

Run automated checks from `app/`:

```sh
node --test tests/storage.test.js tests/sync.test.js
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/server/sync_foundation.sql
```

The local client tests use a deterministic fake transport; the SQL test requires a disposable/approved database. No live browser or production-auth test is claimed here.

| Acceptance criterion | Evidence / procedure | Expected result |
| --- | --- | --- |
| Lost acknowledgement and replay | SQL test: “exact retry returns original receipt”; client test: duplicate receipt | Same `opId` returns the original receipt; one canonical row and no duplicate outbox effect. |
| Same-field conflict | `tests/sync.test.js`; SQL stale title edit | Outbox becomes `conflict`; canonical value is not overwritten and status is surfaced. |
| Independent field convergence | SQL classification/title edits | Both changes apply despite stale entity revision; subsequent pull yields both fields. |
| Delete vs edit | Live two-client procedure: A deletes task offline; B edits it offline; reconnect A then B | Server returns a conflict/tombstone outcome; no deleted task is silently recreated. Record receipts and final pull. |
| Stale cursor/bootstrap | SQL snapshot/pull cursor assertions; live: force an expired cursor then reconnect | Client requests bootstrap, preserves pending local commands, and ends at snapshot cursor. |
| Calendar overlap | SQL overlap and adjacent-block assertions; `tests/planner.test.js` locally | Overlap is recoverable conflict; half-open adjacent blocks apply. |
| Offline retry | `tests/sync.test.js` retryable transport test | Command remains durable with retry status, incremented attempts, and `nextAttemptAt`. |
| Logout/account switch | Live: sign in A, create task, sign out, sign in B; inspect each account | A’s task is absent from B; guest/account namespaces remain isolated; pending A work is not uploaded as B. |
| Token expiry | Live: expire/revoke session during a queued upload, reconnect | Upload pauses with reauthentication/error status; outbox remains intact for retry after sign-in. |
| RLS and direct writes | SQL test owner isolation; live/API: anon and authenticated direct table INSERT/UPDATE/DELETE | Cross-owner reads/references fail; direct writes are denied; only RPC commands mutate canonical data. |

For live procedures, capture client status, RPC response bodies, final `pull_changes` cursor, and row counts. Run against test accounts and never use service-role credentials in the browser.
