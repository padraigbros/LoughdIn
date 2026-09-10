/**
 * User export and import verification for the launch safeguards.
 *
 * These cases cover the recovery path a user actually has: take a backup from
 * the account dialog, and restore it on a device that has lost its data. They
 * run against the real store, and where sync is involved, against the real sync
 * worker and the reference server.
 *
 * The documented recovery steps are in `docs/OPERATIONS.md`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceServer } from './helpers/reference-server.mjs';
import { createClient, captureTask } from './helpers/two-client.mjs';

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const START = Date.parse('2026-09-10T09:00:00.000Z');

async function soloClient() {
  const clock = { value: START };
  const server = createReferenceServer({ now: () => clock.value });
  const client = await createClient({ server, ownerId: ACCOUNT, label: 'one', idPrefix: 'a1a1a1a1', clock });
  return { server, client, clock, advance(ms) { clock.value += ms; } };
}

test('a backup captures local state and unsent work together', async (t) => {
  const world = await soloClient();
  t.after(() => world.client.close());

  world.client.connection.goOffline();
  await captureTask(world.client, 'Captured but never uploaded');
  try { await world.client.flush(); } catch { /* offline */ }

  const backup = JSON.parse(await world.client.store.exportJSON());

  assert.equal(backup.format, 'loughdin-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.namespace, `user:${ACCOUNT}`);
  assert.equal(backup.state.tasks.work.length, 1);
  assert.equal(backup.outbox.length, 1, 'unsent commands travel with the backup');
  assert.equal(backup.outbox[0].kind, 'task.create');
});

test('a backup restores onto a device that lost its data', async (t) => {
  const world = await soloClient();
  t.after(() => world.client.close());

  await captureTask(world.client, 'Worth keeping');
  await captureTask(world.client, 'Also worth keeping');
  const backup = await world.client.store.exportJSON();

  // A second device with nothing on it, standing in for a wiped browser.
  const clock = { value: START };
  const replacement = await createClient({
    server: world.server, ownerId: ACCOUNT, label: 'replacement', idPrefix: 'd4d4d4d4', clock,
  });
  t.after(() => replacement.close());

  assert.deepEqual(await replacement.tasks(), []);
  await replacement.store.importJSON(backup);

  const restored = (await replacement.tasks()).map((task) => task.text).sort();
  assert.deepEqual(restored, ['Also worth keeping', 'Worth keeping']);
});

test('importing merges and never silently deletes local work', async (t) => {
  const world = await soloClient();
  t.after(() => world.client.close());

  await captureTask(world.client, 'The work already on this device');
  const before = (await world.client.tasks()).map((task) => task.text);

  const empty = JSON.parse(await world.client.store.exportJSON());
  empty.state.tasks.work = [];
  empty.state.tasks.personal = [];
  await world.client.store.importJSON(empty);

  const after = (await world.client.tasks()).map((task) => task.text);
  assert.deepEqual(after, before, 'an import merges and never silently deletes local work');
});

test('a restored backup does not park a signed-in account in a sync error', async (t) => {
  const world = await soloClient();
  t.after(() => world.client.close());

  await captureTask(world.client, 'Before the restore');
  await world.client.flush();

  const backup = JSON.parse(await world.client.store.exportJSON());
  backup.state.tasks.work.push({
    id: 'e5e5e5e5-0000-4000-8000-000000000099',
    text: 'From the backup file',
    done: false,
    priority: 'med',
    poms: 0,
    quadrant: null,
    details: '',
    nextAction: '',
    estimateMinutes: 25,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    deletedAt: null,
    revision: 0,
    fieldRevisions: {},
  });
  await world.client.store.importJSON(backup);

  // importJSON records a local-only `backup.import` command. The server has no
  // such kind, so sending it would park the outbox in a permanent error.
  const outbox = await world.client.outbox();
  assert.ok(outbox.some((command) => command.type === 'backup.import'));

  world.advance(60_000);
  const status = await world.client.flush();

  assert.equal(status.state, 'synced', 'the local-only record must not break sync');
  assert.equal(status.pending, 0);
  const stillLocal = await world.client.outbox();
  assert.ok(stillLocal.some((command) => command.type === 'backup.import'), 'and it stays on the device');
});

test('an unreadable backup is refused rather than applied in part', async (t) => {
  const world = await soloClient();
  t.after(() => world.client.close());

  await captureTask(world.client, 'Untouched by a bad import');

  await assert.rejects(world.client.store.importJSON('not json at all'), /not valid JSON/);
  await assert.rejects(world.client.store.importJSON('{"format":"something-else","version":1}'), /Unsupported/);

  const damaged = JSON.parse(await world.client.store.exportJSON());
  damaged.state.tasks.work = [{ id: 'not-a-uuid', text: 'Broken' }];
  await assert.rejects(world.client.store.importJSON(damaged));

  assert.deepEqual((await world.client.tasks()).map((task) => task.text), ['Untouched by a bad import']);
});
