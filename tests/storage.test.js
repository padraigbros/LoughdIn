import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, StorageRecoveryError } from '../src/storage.js';

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000008',
];

function harness({ legacy = null, namespace = 'guest' } = {}) {
  let id = 0;
  const localStorage = {
    value: legacy,
    getItem(key) { return key === 'loughdin-v2' ? this.value : null; },
  };
  return {
    options: {
      indexedDB: new IDBFactory(),
      localStorage,
      namespace,
      BroadcastChannel: null,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
      createUuid: () => ids[id++],
    },
    localStorage,
  };
}

function task(id, text) {
  return {
    id,
    text,
    done: false,
    priority: 'med',
    poms: 0,
    quadrant: null,
    details: '',
    estimateMinutes: 25,
    createdAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T12:00:00.000Z',
    deletedAt: null,
  };
}

test('initializes the complete versioned state', async () => {
  const { options } = harness();
  const store = createStore(options);
  assert.deepEqual(await store.open(), { status: 'ready', migrated: false });
  assert.deepEqual(await store.readState(), {
    schemaVersion: 1,
    tasks: { work: [], personal: [] },
    settings: { durations: { work: 1200, short: 300, long: 900 }, goal: 6, autoCycle: false },
    timer: null,
    sessions: [],
    blocks: [],
    daily: {},
    legacy: {},
    activeTask: null,
  });
  store.close();
});

test('serializes cross-instance read-modify-write mutations and stores commands atomically', async () => {
  const { options } = harness();
  const first = createStore(options);
  const second = createStore(options);
  await Promise.all([first.open(), second.open()]);

  await Promise.all([
    first.mutate((state) => state.tasks.work.push(task(ids[4], 'First tab')), {
      command: { opId: ids[0], type: 'task.create', payload: { id: ids[4] } },
    }),
    second.mutate((state) => state.tasks.work.push(task(ids[5], 'Second tab')), {
      command: { opId: ids[1], type: 'task.create', payload: { id: ids[5] } },
    }),
  ]);

  const state = await first.readState();
  assert.deepEqual(state.tasks.work.map(({ text }) => text), ['First tab', 'Second tab']);
  assert.equal((await first.readOutbox()).length, 2);
  first.close();
  second.close();
});

test('aborts both state and outbox when a mutation is invalid', async () => {
  const { options } = harness();
  const store = createStore(options);
  await store.open();
  await assert.rejects(
    store.mutate((state) => state.tasks.work.push({ text: 'invalid' }), {
      command: { opId: ids[0], type: 'task.create' },
    }),
    /Task id must be a UUID/,
  );
  assert.equal((await store.readState()).tasks.work.length, 0);
  assert.equal((await store.readOutbox()).length, 0);
  store.close();
});

test('surfaces an outbox write failure and rolls back the projected state', async () => {
  const { options } = harness();
  const store = createStore(options);
  await store.open();
  await store.mutate((state) => { state.settings.goal = 7; }, {
    command: { opId: ids[0], type: 'settings.update' },
  });
  await assert.rejects(
    store.mutate((state) => { state.settings.goal = 8; }, {
      command: { opId: ids[0], type: 'settings.update' },
    }),
    (error) => error.code === 'WRITE_FAILED',
  );
  assert.equal((await store.readState()).settings.goal, 7);
  assert.equal((await store.readOutbox()).length, 1);
  store.close();
});

test('builds an optional command synchronously from the mutation result and latest draft', async () => {
  const { options } = harness();
  const store = createStore(options);
  await store.open();
  const committed = await store.mutate((state) => {
    state.settings.goal = 9;
    return 'changed';
  }, {
    command: (result, draft) => ({
      opId: ids[0],
      kind: 'settings.update',
      payload: { result, goal: draft.settings.goal },
    }),
  });
  assert.equal(committed.command.payload.result, 'changed');
  assert.equal(committed.command.payload.goal, 9);
  await store.mutate(() => null, { command: () => null });
  assert.equal((await store.listOutbox()).length, 1);
  store.close();
});

test('imports legacy tasks once, maps ids to UUIDs, and preserves raw aggregates without sessions', async () => {
  const raw = JSON.stringify({
    tasks: {
      work: [{ id: 1, text: 'Legacy work', done: false, priority: 'high', poms: 2 }],
      personal: [{ id: 1, text: 'Legacy home', done: true, priority: 'low', poms: 1 }],
    },
    DUR: { work: 1500, short: 300, long: 900 },
    GOAL: 4,
    ACYC: true,
    pom: 3,
    fSec: 2700,
    wk: [0, 1, 0, 2, 0, 0, 3],
    nId: 2,
  });
  const { options, localStorage } = harness({ legacy: raw });
  const store = createStore(options);
  assert.deepEqual(await store.open(), { status: 'ready', migrated: true });
  const state = await store.readState();
  assert.match(state.tasks.work[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(state.tasks.work[0].id, state.tasks.personal[0].id);
  assert.equal(state.tasks.work[0].quadrant, null);
  assert.equal(state.settings.durations.work, 1500);
  assert.equal(state.legacy.rawJSON, raw);
  assert.deepEqual(state.legacy.aggregates.week, [0, 1, 0, 2, 0, 0, 3]);
  assert.deepEqual(state.sessions, []);
  assert.equal(localStorage.value, raw);

  store.close();
  localStorage.value = JSON.stringify({ tasks: { work: [{ id: 9, text: 'Must not reimport' }] } });
  const reopened = createStore(options);
  assert.deepEqual(await reopened.open(), { status: 'ready', migrated: false });
  assert.equal((await reopened.readState()).tasks.work.length, 1);
  reopened.close();
});

test('malformed legacy data opens in read-only recovery without overwriting the raw value', async () => {
  const { options, localStorage } = harness({ legacy: '{broken json' });
  const store = createStore(options);
  const opened = await store.open();
  assert.equal(opened.status, 'recovery');
  assert.equal(opened.recovery.raw, '{broken json');
  await assert.rejects(store.readState(), StorageRecoveryError);
  await assert.rejects(store.mutate(() => {}), StorageRecoveryError);
  assert.equal(localStorage.value, '{broken json');
  assert.match(await store.exportJSON(), /loughdin-recovery/);
  store.close();
});

test('validated import merges records, preserves conflicting records under new ids, and creates an outbox command', async () => {
  const { options } = harness();
  const store = createStore(options);
  await store.open();
  await store.mutate((state) => state.tasks.work.push(task(ids[4], 'Current')));

  const exported = JSON.parse(await store.exportJSON());
  exported.state.tasks.work = [task(ids[4], 'Imported conflict'), task(ids[5], 'Imported new')];
  await store.importJSON(exported);

  const state = await store.readState();
  assert.deepEqual(state.tasks.work.map(({ text }) => text), ['Current', 'Imported conflict', 'Imported new']);
  assert.equal(new Set(state.tasks.work.map(({ id }) => id)).size, 3);
  assert.equal((await store.readOutbox())[0].type, 'backup.import');
  await assert.rejects(store.importJSON('{"format":"unknown"}'), /Unsupported/);
  store.close();
});

test('keeps sync metadata scoped and command payload immutable after transmission', async () => {
  const { options } = harness();
  const store = createStore(options);
  await store.open();
  assert.equal(await store.getDeviceId(), ids[0]);
  assert.equal(await store.getDeviceId(), ids[0]);
  await store.setMetadata('cursor', '42');
  assert.equal(await store.getMetadata('cursor'), '42');

  await store.mutate(() => {}, {
    command: { opId: ids[1], kind: 'task.update', entityId: ids[4], baseRevision: 0, payload: { text: 'x' } },
  });
  assert.equal((await store.listOutbox())[0].protocol, 1);
  await store.updateOutbox(ids[1], { status: 'sending', attempts: 1 });
  await assert.rejects(store.updateOutbox(ids[1], { payload: { text: 'changed' } }), /immutable/);
  await assert.rejects(store.updateOutbox(ids[1], { baseRevision: 1 }), /cannot be rebased/);
  await store.ackOutbox(ids[1]);
  assert.deepEqual(await store.listOutbox(), []);
  store.close();
});
