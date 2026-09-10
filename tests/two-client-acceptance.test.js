/**
 * Two-client offline and conflict acceptance suite.
 *
 * Every case runs the production stack end to end: the real IndexedDB store,
 * the real sync worker, and a reference server that models
 * `supabase/migrations/202609080001_sync_foundation.sql` and is reachable only
 * through `rpc`, the same surface `@supabase/supabase-js` exposes. Nothing
 * between the app and the wire is stubbed, so a client that cannot talk to
 * Supabase cannot pass these tests either.
 *
 * See `docs/SYNC-ACCEPTANCE.md` for how each case maps to a release criterion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceServer } from './helpers/reference-server.mjs';
import { createClient, captureTask, editTask, deleteTask } from './helpers/two-client.mjs';

const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const START = Date.parse('2026-09-10T09:00:00.000Z');

/** Two devices signed in to one account, plus a shared clock the test can advance. */
async function pair() {
  const clock = { value: START };
  const server = createReferenceServer({ now: () => clock.value });
  const one = await createClient({ server, ownerId: ACCOUNT_A, label: 'one', idPrefix: 'a1a1a1a1', clock });
  const two = await createClient({ server, ownerId: ACCOUNT_A, label: 'two', idPrefix: 'b2b2b2b2', clock });
  return {
    server,
    one,
    two,
    clock,
    advance(ms) { clock.value += ms; },
    async close() { await one.close(); await two.close(); },
  };
}

/** Flush without letting a transport failure fail the test; sync rejects when offline. */
async function flushQuietly(client) {
  try {
    return await client.flush();
  } catch {
    return client.sync.getStatus();
  }
}

async function scheduleBlock(client, taskId, startsAt, endsAt) {
  const id = client.createId();
  await client.enqueue(
    (draft) => { draft.blocks.push({ id, taskId, startAt: startsAt, endAt: endsAt, revision: 0 }); },
    () => ({
      kind: 'block.create',
      entityId: id,
      baseRevision: 0,
      payload: { taskId, startsAt, endsAt, timeZone: 'Europe/Dublin' },
    }),
  );
  return id;
}

function findTask(tasks, id) {
  return tasks.find((task) => task.id === id) || null;
}

test('a command reaches the server through the same rpc surface Supabase exposes', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  // The connection offers nothing but `rpc`, exactly like `@supabase/supabase-js`.
  assert.equal(typeof world.one.connection.applyCommand, 'undefined');
  assert.equal(typeof world.one.connection.rpc, 'function');

  const id = await captureTask(world.one, 'Walk the Kerry Way');
  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  assert.equal(world.server.calls.apply_command, 1);
  assert.deepEqual(await world.one.outbox(), []);
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 1);
  assert.equal(findTask(await world.one.tasks(), id).revision, 1);
});

test('the device is registered before its first command is sent', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  await captureTask(world.one, 'Register first');
  await world.one.flush();

  // The server rejects commands from unknown devices, so registration must precede the push.
  assert.equal(world.server.calls.register_device, 1);
  assert.equal(world.server.account(ACCOUNT_A).devices.has(world.one.deviceId), true);

  // Registration happens once per session, not once per command.
  await captureTask(world.one, 'And again');
  await world.one.flush();
  assert.equal(world.server.calls.register_device, 1);
  assert.equal(world.server.calls.apply_command, 2);
});

test('local priority names are translated to the server enum and back', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Default priority task');
  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  // The local vocabulary is low|med|high; public.task_priority is low|medium|high.
  assert.equal(world.server.readTasksAs(ACCOUNT_A)[0].priority, 'medium');
  assert.equal(findTask(await world.one.tasks(), id).priority, 'med');

  await world.two.flush();
  assert.equal(findTask(await world.two.tasks(), id).priority, 'med');
});

test('two clients on one account converge on edits made online', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Draft the launch note');
  await world.one.flush();
  await world.two.flush();
  assert.equal(findTask(await world.two.tasks(), id).text, 'Draft the launch note');

  await editTask(world.two, id, { text: 'Publish the launch note' });
  await world.two.flush();
  await world.one.flush();

  assert.equal(findTask(await world.one.tasks(), id).text, 'Publish the launch note');
  assert.equal(findTask(await world.two.tasks(), id).text, 'Publish the launch note');
  assert.equal(world.server.readTasksAs(ACCOUNT_A)[0].text, 'Publish the launch note');
});

test('offline work survives a restart and lands on reconnect', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  world.one.connection.goOffline();
  const first = await captureTask(world.one, 'Written on the train');
  const second = await captureTask(world.one, 'Also written on the train');
  const offlineStatus = await flushQuietly(world.one);

  assert.equal(offlineStatus.state, 'offline');
  assert.equal((await world.one.outbox()).length, 2);
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 0);

  await world.one.restart();
  assert.equal((await world.one.outbox()).length, 2, 'pending work must be durable across a restart');
  assert.equal((await world.one.tasks()).length, 2, 'local edits stay visible while offline');

  world.one.connection.goOnline();
  world.advance(60_000);
  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  assert.deepEqual(await world.one.outbox(), []);
  await world.two.flush();
  const seen = (await world.two.tasks()).map((task) => task.id).sort();
  assert.deepEqual(seen, [first, second].sort());
});

test('a lost acknowledgement replays without creating a duplicate', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Sent but never confirmed');
  world.one.connection.dropAcknowledgements(1);
  await flushQuietly(world.one);

  // The server committed the write; the client never heard about it.
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 1);
  const pending = await world.one.outbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'retry');

  world.advance(60_000);
  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  assert.deepEqual(await world.one.outbox(), []);
  assert.equal(world.server.calls.apply_command, 2, 'the same opId is sent twice');
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 1, 'but only one row exists');
  const log = world.server.account(ACCOUNT_A).changeLog.filter((entry) => entry.entityId === id);
  assert.equal(log.length, 1, 'and the change log gained no duplicate entry');
  assert.equal((await world.one.tasks()).length, 1);
});

test('replaying an opId with different content is refused', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Original wording');
  await world.one.flush();
  const [reused] = world.server.account(ACCOUNT_A).receipts.keys();

  await world.one.enqueue(
    (draft) => { findTask(draft.tasks.work, id).text = 'Rewritten wording'; },
    () => ({ opId: reused, kind: 'task.update', entityId: id, baseRevision: 1, payload: { text: 'Rewritten wording' } }),
  );
  await flushQuietly(world.one);

  const [command] = await world.one.outbox();
  assert.equal(command.status, 'error');
  assert.match(command.lastError, /already used with a different command/);
  assert.equal(world.server.readTasksAs(ACCOUNT_A)[0].text, 'Original wording');
});

test('a same-field conflict is surfaced and never overwrites the local edit', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Shared title');
  await world.one.flush();
  await world.two.flush();

  await editTask(world.one, id, { text: 'Title from device one' });
  await world.one.flush();

  // Device two still believes revision 1 and edits the same field group.
  await editTask(world.two, id, { text: 'Title from device two' });
  const status = await flushQuietly(world.two);

  assert.equal(status.state, 'conflict');
  const [command] = await world.two.outbox();
  assert.equal(command.status, 'conflict');
  assert.equal(command.serverReceipt.conflict.reason, 'stale_text');
  assert.equal(findTask(await world.two.tasks(), id).text, 'Title from device two', 'the local edit is preserved');
  assert.equal(world.server.readTasksAs(ACCOUNT_A)[0].text, 'Title from device one');
});

test('edits to different field groups both apply without conflicting', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Two fields, one task');
  await world.one.flush();
  await world.two.flush();

  await editTask(world.one, id, { text: 'Renamed by one' });
  await world.one.flush();
  await editTask(world.two, id, { done: true });
  const status = await world.two.flush();

  assert.equal(status.state, 'synced');
  const row = world.server.readTasksAs(ACCOUNT_A)[0];
  assert.equal(row.text, 'Renamed by one');
  assert.equal(row.done, true);
  await world.one.flush();
  assert.equal(findTask(await world.one.tasks(), id).done, true);
});

test('a delete and edit race resolves as a conflict, not a resurrection', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const id = await captureTask(world.one, 'Doomed task');
  await world.one.flush();
  await world.two.flush();

  await deleteTask(world.one, id);
  await world.one.flush();

  await editTask(world.two, id, { text: 'Still editing' });
  const status = await flushQuietly(world.two);

  assert.equal(status.state, 'conflict');
  const [command] = await world.two.outbox();
  assert.equal(command.serverReceipt.conflict.reason, 'entity_deleted');
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 0, 'the delete stands');
  assert.equal(findTask(await world.one.tasks(), id), null);
});

test('a stale cursor forces a bootstrap and the client still converges', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const first = await captureTask(world.one, 'Before retention trimmed');
  await world.one.flush();
  await world.two.flush();

  const second = await captureTask(world.two, 'After retention trimmed');
  await world.two.flush();

  // Retention discards everything device one still needs to page through.
  const head = world.server.account(ACCOUNT_A).currentSequence;
  world.server.trimRetention(ACCOUNT_A, head);
  assert.ok(await world.one.cursor() < head);

  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  assert.equal(world.server.calls.bootstrap_snapshot, 1);
  const ids = (await world.one.tasks()).map((task) => task.id).sort();
  assert.deepEqual(ids, [first, second].sort());
  assert.equal(await world.one.cursor(), head);
});

test('a rotated epoch forces a bootstrap rather than a silent divergence', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  await captureTask(world.one, 'Before the epoch rotated');
  await world.one.flush();
  await world.two.flush();

  world.server.rotateEpoch(ACCOUNT_A);
  const kept = await captureTask(world.two, 'After the epoch rotated');
  await world.two.flush();

  const status = await world.one.flush();

  assert.equal(status.state, 'synced');
  assert.ok(world.server.calls.bootstrap_snapshot >= 1);
  assert.ok(findTask(await world.one.tasks(), kept));
});

test('overlapping time blocks are rejected as a scheduling conflict', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const taskId = await captureTask(world.one, 'Deep work');
  await world.one.flush();
  await world.two.flush();

  await scheduleBlock(world.one, taskId, '2026-09-11T09:00:00.000Z', '2026-09-11T10:00:00.000Z');
  const first = await world.one.flush();
  assert.equal(first.state, 'synced');

  await scheduleBlock(world.two, taskId, '2026-09-11T09:30:00.000Z', '2026-09-11T10:30:00.000Z');
  const status = await flushQuietly(world.two);

  assert.equal(status.state, 'conflict');
  const [command] = await world.two.outbox();
  assert.equal(command.serverReceipt.conflict.reason, 'schedule_overlap');
  assert.equal(world.server.account(ACCOUNT_A).blocks.size, 1);
});

test('deleting a task cancels its future blocks in one transaction group', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  const taskId = await captureTask(world.one, 'Task with a block');
  await world.one.flush();
  const blockId = await scheduleBlock(world.one, taskId, '2026-09-11T09:00:00.000Z', '2026-09-11T10:00:00.000Z');
  await world.one.flush();
  await world.two.flush();
  assert.equal((await world.two.state()).blocks.length, 1);

  await deleteTask(world.one, taskId);
  await world.one.flush();
  await world.two.flush();

  assert.equal((await world.two.state()).blocks.length, 0, 'the cancelled block is removed on the other device');
  const group = world.server.account(ACCOUNT_A).changeLog.filter((entry) => entry.entityId === blockId && entry.operation === 'delete');
  assert.equal(group.length, 1);
});

test('an expired token parks work as recoverable rather than failed', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  await captureTask(world.one, 'Written just before the token expired');
  world.one.connection.expireToken();
  const status = await flushQuietly(world.one);

  assert.equal(status.state, 'auth', 'the UI can prompt for sign-in instead of showing a hard error');
  const [command] = await world.one.outbox();
  assert.equal(command.status, 'pending', 'the command is neither sent nor discarded');
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 0);

  world.one.connection.refreshToken();
  world.advance(60_000);
  const recovered = await world.one.flush();

  assert.equal(recovered.state, 'synced');
  assert.equal(world.server.readTasksAs(ACCOUNT_A).length, 1);
});

test('a token that expires mid-flush keeps the command for retry', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  await captureTask(world.one, 'Caught by an expiry race');
  // Let the pull and the device registration through, then expire before the push.
  world.one.connection.expireAfter(2);
  await flushQuietly(world.one);

  const [command] = await world.one.outbox();
  assert.equal(command.status, 'retry', 'an expired token is retried, not parked as an error');
  assert.ok(command.nextAttemptAt);
  assert.equal(world.one.sync.getStatus().state, 'auth');

  world.one.connection.refreshToken();
  world.advance(60_000);
  assert.equal((await world.one.flush()).state, 'synced');
});

test('signing out leaves pending work in its own account namespace', async (t) => {
  const world = await pair();
  t.after(() => world.close());

  world.one.connection.goOffline();
  await captureTask(world.one, 'Unsent when the user signed out');
  await flushQuietly(world.one);
  assert.equal((await world.one.outbox()).length, 1);

  world.one.connection.signOut();
  const status = await flushQuietly(world.one);
  assert.equal(status.state, 'offline');
  assert.equal((await world.one.outbox()).length, 1, 'signing out must not discard unsent work');

  // Signing in as another account on the same device opens a separate namespace.
  const other = await world.one.openNamespace(ACCOUNT_B);
  try {
    assert.deepEqual(await other.listOutbox(), [], 'the other account sees no pending work');
    assert.deepEqual((await other.readState()).tasks.work, [], 'and none of the first account data');
  } finally {
    other.close();
  }

  await world.one.restart();
  assert.equal((await world.one.outbox()).length, 1, 'the original account still holds its work');
});

test('one account cannot read or write another account data', async (t) => {
  const clock = { value: START };
  const server = createReferenceServer({ now: () => clock.value });
  const owner = await createClient({ server, ownerId: ACCOUNT_A, label: 'owner', idPrefix: 'a1a1a1a1', clock });
  const stranger = await createClient({ server, ownerId: ACCOUNT_B, label: 'stranger', idPrefix: 'c3c3c3c3', clock });
  t.after(async () => { await owner.close(); await stranger.close(); });

  const id = await captureTask(owner, 'Private to account A');
  await owner.flush();

  const status = await stranger.flush();
  assert.equal(status.state, 'synced');
  assert.deepEqual(await stranger.tasks(), [], 'a pull on another account returns nothing');
  assert.deepEqual(server.readTasksAs(ACCOUNT_B), []);

  // Ownership comes from the connection, so naming another account entity does not reach it.
  await stranger.enqueue(
    (draft) => { draft.legacy.probe = true; },
    () => ({ kind: 'task.update', entityId: id, baseRevision: 1, payload: { text: 'Written by a stranger' } }),
  );
  await flushQuietly(stranger);

  const [command] = await stranger.outbox();
  assert.equal(command.status, 'error');
  assert.match(command.lastError, /task not found/);
  assert.equal(server.readTasksAs(ACCOUNT_A)[0].text, 'Private to account A');
});
