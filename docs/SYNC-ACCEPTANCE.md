# Sync acceptance checklist

Run the automated checks from the repository root:

```sh
npm test
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/server/sync_foundation.sql
```

`npm test` includes `tests/two-client-acceptance.test.js`, which drives two
independent devices through the production stack: the real IndexedDB store from
`src/storage.js`, the real worker from `src/sync.js`, and a reference server that
models `supabase/migrations/202609080001_sync_foundation.sql`. The reference
server is reachable only through `rpc`, the surface `@supabase/supabase-js`
offers, so a client that could not talk to Supabase cannot pass the suite. Its
scenarios are described in `tests/helpers/reference-server.mjs`.

The SQL test still requires a disposable or approved database and remains the
authority on the server contract. No live browser, live Supabase project, or
production-auth run is claimed by either file.

## Automated coverage

| Acceptance criterion | Automated evidence | Expected result |
| --- | --- | --- |
| Two clients converge online | `two clients on one account converge on edits made online` | Each device sees the other's edit after a pull, and the canonical row matches. |
| Command reaches the server | `a command reaches the server through the same rpc surface Supabase exposes` | The push travels through `rpc('apply_command')`; the connection exposes no other method. |
| Device registration | `the device is registered before its first command is sent` | `register_device` runs once per session before the first push; the server accepts the device. |
| Priority vocabulary | `local priority names are translated to the server enum and back` | Local `med` is sent as `medium` and read back as `med`. |
| Offline create, restart, reconnect | `offline work survives a restart and lands on reconnect` | Pending commands are durable across a restart and apply once connectivity returns. |
| Lost acknowledgement and replay | `a lost acknowledgement replays without creating a duplicate` | The same `opId` returns the original receipt; one row and one change-log entry. |
| Duplicate `opId` misuse | `replaying an opId with different content is refused` | The command is rejected and the canonical row is unchanged. |
| Same-field conflict | `a same-field conflict is surfaced and never overwrites the local edit` | The outbox entry becomes `conflict` with reason `stale_text`; the local edit survives. |
| Independent field convergence | `edits to different field groups both apply without conflicting` | Both edits apply despite a stale entity revision. |
| Delete versus edit | `a delete and edit race resolves as a conflict, not a resurrection` | The edit conflicts with reason `entity_deleted` and the delete stands. |
| Stale cursor and bootstrap | `a stale cursor forces a bootstrap and the client still converges` | The client bootstraps, converges, and ends at the snapshot cursor. |
| Epoch rotation | `a rotated epoch forces a bootstrap rather than a silent divergence` | A changed epoch triggers a bootstrap instead of an incremental pull. |
| Calendar overlap | `overlapping time blocks are rejected as a scheduling conflict` | The overlap is a recoverable conflict with reason `schedule_overlap`. |
| Cascading delete | `deleting a task cancels its future blocks in one transaction group` | Future blocks are cancelled in the same group and disappear on the other device. |
| Token expiry | `an expired token parks work as recoverable rather than failed` and `a token that expires mid-flush keeps the command for retry` | Status becomes `auth`, the command is retried rather than parked as an error, and it applies after refresh. |
| Logout and account switch | `signing out leaves pending work in its own account namespace` | Unsent work survives sign-out and is invisible to the other account namespace. |
| Account isolation | `one account cannot read or write another account data` | A pull returns nothing; naming another account's entity fails because ownership comes from the connection. |

## Still requires a live run

The suite proves the client protocol against a faithful model of the SQL. It
does not prove the deployed project behaves the same way. Before public beta,
run these against the real project with test accounts and no service-role
credentials in the browser:

- Two real browsers on one account, including a genuine network drop.
- Row level security from the browser: direct `INSERT`, `UPDATE` and `DELETE`
  against `public.tasks` as an authenticated user must be denied.
- An anonymous client calling each RPC must be denied.
- Real Supabase token expiry and refresh during a queued upload.
- Android deep-link callbacks, covered separately in
  `docs/ANDROID-RELEASE-AND-SMOKE-TEST.md`.

For live procedures, capture client status, RPC response bodies, the final
`pull_changes` cursor, and row counts.
