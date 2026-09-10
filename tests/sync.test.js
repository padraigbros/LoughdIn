import test from 'node:test';
import assert from 'node:assert/strict';
import {createSync} from '../src/sync.js';

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
