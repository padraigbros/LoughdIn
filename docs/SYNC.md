# Lough'd In sync protocol v1

The server is defined by `supabase/migrations/202609080001_sync_foundation.sql`. It has been deployed to the configured project `kknbyhlwmuzttyxyuffe`; production authentication and multi-device certification remain separate release checks.

See [the executable acceptance checklist](SYNC-ACCEPTANCE.md) for automated commands and explicitly unrun live two-client procedures.

## Entity mapping

The original browser task fields are retained without inventing history:

| Original value | Canonical task field |
| --- | --- |
| task text | `text` (trimmed length 1–300) |
| completion checkbox | `done` boolean |
| `low`, `medium`, `high` | `priority` with the same value |
| Work / Personal list | `list`: `work` or `personal` |
| no original matrix value | `quadrant: null` (unclassified) |

New quadrant values are `do`, `schedule`, `delegate`, and `eliminate`. They mean urgent+important, important+not urgent, urgent+not important, and neither urgent nor important respectively. The UI may label them “Do first,” “Make time,” “Handle briefly,” and “Let go.” Priority remains independent: importing `high` priority does not infer a quadrant.

Canonical rows use camel-case JSON. Server columns use snake case and include `revision`, `fieldRevisions`, `createdAt`, `updatedAt`, and `deletedAt`. Client-generated entity IDs and operation IDs are random UUIDs.

## Authentication and devices

Every RPC gets the owner from `auth.uid()`. A submitted owner identifier is rejected as an unknown command key. Before syncing, call:

```text
register_device(p_device_id uuid, p_platform 'web'|'android', p_supported_protocol 1)
```

Registration is scoped to the authenticated owner. A revoked device cannot be silently re-registered. The public entity tables allow owner-scoped reads through RLS. `anon` has no RPC access, authenticated clients have no direct insert/update/delete access, and the receipt/change-log/device tables are in the unexposed `private` schema.

The `SECURITY DEFINER` functions have an empty search path and qualify objects. They are owned by a no-login role that owns only these application tables and functions. The functions still check `auth.uid()`, device ownership, and every task/block/session link explicitly.

## Commands and receipts

Call `apply_command(p_command jsonb)` with exactly these top-level keys:

```json
{
  "protocol": 1,
  "opId": "uuid",
  "deviceId": "uuid",
  "kind": "task.update",
  "entityId": "uuid",
  "baseRevision": 3,
  "payload": { "quadrant": "schedule" }
}
```

Supported kinds are `task.create`, `task.update`, `task.delete`, `block.create`, `block.update`, `block.delete`, `session.record`, `session.create`, and `session.transition`. Creates and records require revision 0. Deletes require the exact current entity revision. Update payloads are partial patches; missing fields are unchanged and unexpected fields are rejected.

The current browser creates a terminal local session only after the timer finishes. Upload that history atomically with `session.record`; do not synthesize a live create/transition pair:

```json
{
  "protocol": 1,
  "opId": "uuid",
  "deviceId": "uuid",
  "kind": "session.record",
  "entityId": "session uuid",
  "baseRevision": 0,
  "payload": {
    "taskId": "task uuid or null",
    "mode": "pomodoro",
    "startedAt": "2026-09-09T08:00:00.000Z",
    "endedAt": "2026-09-09T08:25:00.000Z",
    "focusMs": 1500000,
    "interruptions": 0,
    "outcome": "completed"
  }
}
```

`mode` is `pomodoro` or `flow`; `outcome` is `completed` or `partial`. The server validates that `endedAt` follows `startedAt` and that `focusMs` does not exceed the elapsed wall time. One command inserts the ended session, its start/end audit events, the sync change, and the immutable receipt in a single transaction.

An applied response has this shape:

```json
{
  "protocol": 1,
  "opId": "uuid",
  "outcome": "applied",
  "sequence": 14,
  "entityType": "task",
  "entityId": "uuid",
  "revision": 4,
  "change": { "id": "uuid", "text": "...", "revision": 4 }
}
```

A conflict response has `outcome: "conflict"` and `conflict: {id, reason, current, proposed}`. It is an immutable operation receipt plus a durable private conflict row. The server leaves the canonical value untouched. The client resolves it by showing both versions and submitting a new operation ID based on the current revision; changing and resending the old operation is forbidden.

The hash is calculated over PostgreSQL's canonical `jsonb` representation. Retrying the same operation ID and semantically identical JSON returns its stored response without another mutation or focus event. Reusing an operation ID with different content raises SQLSTATE `22023`. Once sent, an operation is immutable.

### Revision groups

`baseRevision` is the highest server entity revision the client had seen when it made the edit. Each task also tracks revisions for `text`, `done`, `classification` (`priority`, `list`, `quadrant`), `details`, `estimate`, and `nextAction`. A group conflicts only when its revision is newer than `baseRevision`. Thus a title edit based on revision 1 can merge after an unrelated classification edit produced revision 2. Two title edits from revision 1 cannot silently overwrite one another.

Blocks use `placement` (`taskId`, `startsAt`, `endsAt`, `timeZone`), `appearance` (`colorKey`), and `status` groups. Keeping all placement values in one group prevents a merge from pairing one device's start with another device's end. Sessions require an exact revision because their state transitions are ordered.

Confirmed blocks reserve `[startsAt, endsAt)`. Adjacent blocks are valid. The owner lock serializes checks, and a Postgres exclusion constraint remains the final invariant. An overlap returns a conflict receipt containing the proposal; it never moves another block. A task deletion atomically tombstones at most 100 future linked blocks and detaches the one possible active session while retaining historical session links. Larger fan-out is rejected for an explicit server-side maintenance path.

## Pulling changes

Call `pull_changes(p_cursor bigint, p_limit integer)`; limit defaults to 100 and is capped at 500. The result is:

```json
{
  "protocol": 1,
  "epoch": "uuid",
  "cursor": 18,
  "highWatermark": 25,
  "hasMore": true,
  "changes": [
    {
      "sequence": 18,
      "groupId": "command-op-uuid",
      "entityType": "block",
      "entityId": "uuid",
      "revision": 2,
      "operation": "upsert",
      "row": {},
      "committedAt": "timestamp"
    }
  ]
}
```

The per-owner head row is locked by every command, so committed cursor numbers do not have transaction gaps. A pull captures a high watermark while holding a shared owner lock and returns only changes at or below it. Apply every contiguous `groupId` in one local transaction and advance the durable cursor in that same transaction. `p_limit` is a target record count: the first atomic group is returned whole even if it is larger, so a client always makes progress. The task-delete fan-out bound caps this overflow.

If the cursor is below `minimum_retained_sequence`, the RPC raises `stale_cursor`. Preserve the local outbox, obtain a fresh snapshot into new base tables, replay pending commands, and atomically swap the base. Realtime, if configured later, is only a hint to pull; this migration deliberately adds none of the personal tables to a publication.

## Bootstrap and retention limits

`bootstrap_snapshot(p_limit integer)` takes a shared lock on the owner's sync head, then returns the owner's current tasks, blocks, sessions, and events plus the matching cursor and epoch. It defaults to 2,000 total rows and caps the caller's bound at 5,000.

This v1 endpoint is deliberately all-or-nothing. If the account exceeds the bound it returns `outcome: "too_large"`, `requiredCount`, and no partial rows. Independent pages made under separate database snapshots would not form a consistent bootstrap. A production service must add an expiring owner-scoped materialized snapshot or an export/bootstrap worker before accounts can exceed this bound; clients must not page current tables independently and call that consistent.

The schema records `minimum_retained_sequence` but does not ship an automatic deletion job. The proposed operational window is 90 days only after monitoring proves it safe. Any cleanup must lock the same owner head, update the minimum cursor, retain tombstones long enough for supported clients, and keep operation receipts at least as long as commands may be replayed. Until that job exists, the change log and receipts grow without automatic retention. This is a known launch-operation requirement, not a hidden guarantee.

## Local sync order

The durable client flow is:

1. In one local transaction, apply the optimistic projection and append the exact wire command to the outbox.
2. On reconnect, pull and rebase first.
3. Send ready commands in causal order. Store each receipt and rebuild the optimistic projection in one local transaction.
4. Quarantine a conflicting command and its dependent chain; continue unrelated commands.
5. Pull once more. A socket connection alone never means “Up to date.”

The server does not make a browser or Android write durable before it reaches the server. That guarantee comes from the IndexedDB/SQLite transaction containing both the local projection and outbox entry.

## Server test

`tests/server/sync_foundation.sql` is a destructive-fixture script for a fresh disposable PostgreSQL database with `pgcrypto` and `btree_gist`. It creates minimal `auth`, `anon`, and `authenticated` fixtures, applies the migration, and rolls the data checks back. It covers exact retries, immutable operation IDs, grouped merge/conflict behavior, overlap/adjacency, terminal session recording, pull/snapshot cursors, two-owner RLS, forged ownership, cross-owner links, revoked direct writes, private log access, anonymous RPC denial, and the absence of realtime publication.

```powershell
psql "$env:TEST_DATABASE_URL" -f tests/server/sync_foundation.sql
```

The fixture mimics `auth.uid()` only to execute database contract tests. It is not a custom JWT implementation and is not evidence that Supabase Auth, PostgREST, or production token handling has been certified. Run additional integration tests with two identities created by Supabase Auth before deployment.
