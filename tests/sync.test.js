import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createSync} from '../src/sync.js';
import {createStore} from '../src/storage.js';

const ID = '10000000-0000-4000-8000-000000000001';
function harness(commands, applyCommand) {
  const state = {tasks: {work: [], personal: []}, blocks: [], sessions: [], legacy: {}};
  const listeners = new Set();
  return {
    namespace: 'guest',
    async readState() { return structuredClone(state); },
    async listOutbox() { return structuredClone(commands); },
    async updateOutbox(opId, patch) { Object.assign(commands.find(c => c.opId === opId), patch); listeners.forEach(fn => fn()); },
    async ackOutbox(opId) { commands.splice(commands.findIndex(c => c.opId === opId), 1); listeners.forEach(fn => fn()); },
    async mutate(fn) { fn(state); listeners.forEach(fn => fn()); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    applyCommand,
  };
}
function command(opId = ID, payload = {text: 'Draft'}) {
  return {opId, deviceId: ID, entityId: ID, kind: 'task.create', baseRevision: 0, payload,
    status: 'pending', attempts: 0, createdAt: '2026-09-10T00:00:00.000Z'};
}

test('duplicate receipt is idempotently acknowledged', async () => {
  const commands = [command()]; let calls = 0;
  const store = harness(commands, async wire => { calls++; assert.equal(wire.opId, ID); return {outcome: 'duplicate'}; });
  const sync = createSync({store, client: store, now: () => 0});
  await sync.flush();
  assert.equal(calls, 1); assert.deepEqual(commands, []); assert.equal(sync.getStatus().state, 'synced');
});

test('same-field conflict remains visible and does not overwrite local state', async () => {
  const commands = [command(ID, {text: 'Mine'})];
  const store = harness(commands, async () => ({outcome: 'conflict', reason: 'stale title'}));
  const sync = createSync({store, client: store, now: () => 0});
  await sync.flush();
  assert.equal(commands[0].status, 'conflict');
  assert.equal((await store.readState()).tasks.work.length, 0);
  assert.equal(sync.getStatus().state, 'conflict');
});

test('retryable transport failure preserves pending work with retry metadata', async () => {
  const commands = [command()]; const error = new TypeError('offline');
  const store = harness(commands, async () => { throw error; });
  const sync = createSync({store, client: store, now: () => 1000, random: () => 0.5});
  await sync.flush();
  assert.equal(commands[0].status, 'retry');
  assert.equal(commands[0].attempts, 1);
  assert.ok(commands[0].nextAttemptAt);
  assert.ok(['offline', 'pending'].includes(sync.getStatus().state));
  sync.stop();
});

// Conflict resolution runs against the real store, not the fake above. The
// fake accepts any patch, while the real outbox refuses to rebase a command the
// server has already ruled on, which is the whole constraint being worked
// around here. The receipt is the one private.save_conflict actually builds.
const ID2 = '10000000-0000-4000-8000-000000000002';
const ID3 = '10000000-0000-4000-8000-000000000003';
const TASK = '10000000-0000-4000-8000-000000000009';

function serverConflict(opId, {reason = 'stale_text', revision = 9} = {}) {
  return {
    protocol: 1, opId, outcome: 'conflict', sequence: 5,
    entityType: 'task', entityId: TASK, revision,
    conflict: {id: ID3, reason, current: {text: 'Theirs'}, proposed: {text: 'Mine'}},
  };
}

// A head command that conflicts, and a later edit to the same task queued
// behind it, which is how storage links commands sharing an entity.
async function conflicted(applyCommand) {
  let next = 100;
  const store = createStore({
    indexedDB: new IDBFactory(), localStorage: {getItem: () => null},
    namespace: 'guest', BroadcastChannel: null,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    createUuid: () => `10000000-0000-4000-8000-000000000${next++}`,
  });
  await store.open();
  await store.mutate(() => {}, {
    command: {opId: ID, kind: 'task.update', entityId: TASK, baseRevision: 0, payload: {text: 'Mine'}},
  });
  await store.mutate(() => {}, {
    command: {opId: ID2, kind: 'task.update', entityId: TASK, baseRevision: 0, payload: {estimateMinutes: 50}},
  });
  const sync = createSync({store, client: {applyCommand}, now: () => 0});
  await sync.flush();
  return {store, sync};
}

test('listConflicts reports the server account of a refused command', async () => {
  const {sync} = await conflicted(async wire => serverConflict(wire.opId, {revision: 7}));
  const conflicts = await sync.listConflicts();
  const head = conflicts.find(c => c.opId === ID);
  assert.equal(head.reason, 'stale_text');
  assert.equal(head.entityType, 'task');
  assert.equal(head.currentRevision, 7);
  assert.deepEqual(head.current, {text: 'Theirs'});
  assert.deepEqual(head.proposed, {text: 'Mine'});
  assert.equal(conflicts.find(c => c.opId === ID2).blockedBy, ID);
});

test('resolving to the server version drops the command and rebases what was behind it', async () => {
  const {store, sync} = await conflicted(async wire => serverConflict(wire.opId));
  await sync.resolveConflict(ID, {strategy: 'server'});
  const outbox = await store.listOutbox();
  assert.deepEqual(outbox.map(c => c.opId), [ID2], 'the refused command goes, the later edit stays');
  assert.equal(outbox[0].status, 'pending');
  assert.equal(outbox[0].baseRevision, 9, 'the survivor is rebased onto what the server holds');
  assert.equal(outbox[0].predecessorOpId, null);
  assert.equal(sync.getStatus().conflicts, 0);
  store.close();
});

test('keeping the local change resends it as a new command based on the current revision', async () => {
  const {store, sync} = await conflicted(async wire => serverConflict(wire.opId));
  await sync.resolveConflict(ID, {strategy: 'local'});
  const outbox = await store.listOutbox();
  const replacement = outbox.find(c => c.opId !== ID2);
  assert.ok(replacement, 'the local edit is requeued');
  assert.notEqual(replacement.opId, ID, 'the protocol forbids resending a ruled-on operation');
  assert.equal(replacement.status, 'pending');
  assert.equal(replacement.baseRevision, 9);
  assert.deepEqual(replacement.payload, {text: 'Mine'});
  assert.equal(replacement.serverReceipt, undefined);
  const dependent = outbox.find(c => c.opId === ID2);
  assert.equal(dependent.status, 'pending', 'the edit behind it is freed');
  assert.equal(dependent.predecessorOpId, replacement.opId, 'and stays behind the replacement');
  store.close();
});

test('resolveConflict refuses an unknown strategy, a missing command and a healthy one', async () => {
  const {store, sync} = await conflicted(async wire =>
    wire.opId === ID ? serverConflict(wire.opId) : {outcome: 'applied'});
  await assert.rejects(() => sync.resolveConflict(ID, {strategy: 'guess'}), TypeError);
  await assert.rejects(() => sync.resolveConflict(ID3), /No queued command/);
  await sync.resolveConflict(ID, {strategy: 'server'});
  await assert.rejects(() => sync.resolveConflict(ID2), /not in conflict/);
  store.close();
});

test('an empty outbox is never reported as pending, however it was asked for', async () => {
  // withLock asks for 'pending' when another tab holds the lock. With nothing
  // queued that put an amber dot and "0 changes pending" on a healthy account.
  const store = harness([], async () => ({outcome: 'applied'}));
  const statuses = [];
  const sync = createSync({store, client: store, now: () => 0, onStatus: s => statuses.push(s),
    locks: {request: async () => null}, eventTarget: null});
  await sync.flush();
  assert.equal(sync.getStatus().pending, 0);
  assert.equal(sync.getStatus().state, 'synced', 'nothing queued is nothing to be pending on');
  assert.ok(!statuses.some(s => s.state === 'pending' && s.pending === 0), 'and it never said so on the way');
});

test('work that is genuinely queued still reports as pending', async () => {
  const store = harness([command()], async () => ({outcome: 'applied'}));
  const sync = createSync({store, client: store, now: () => 0,
    locks: {request: async () => null}, eventTarget: null});
  await sync.flush();
  assert.equal(sync.getStatus().state, 'pending', 'a busy lock elsewhere does not make the work vanish');
  assert.equal(sync.getStatus().pending, 1);
});
