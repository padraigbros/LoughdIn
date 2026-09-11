/**
 * Importing guest data into a signed-in account.
 *
 * The sign-in dialog promises guest tasks stay until you choose to import them,
 * so this is the one route from trying the app to keeping what you made. The
 * planning cases are pure; the rest run the production stack, so what lands in
 * the account and what goes on the wire are both real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { planGuestImport, importCount, importSummary, createSync } from '../src/sync.js';
import { createStore } from '../src/storage.js';

const TASK = '11111111-0000-4000-8000-000000000001';
const OTHER_TASK = '11111111-0000-4000-8000-000000000002';
const BLOCK = '22222222-0000-4000-8000-000000000001';
const SESSION = '33333333-0000-4000-8000-000000000001';

function task(id, overrides = {}) {
  return {
    id,
    text: 'Write the thing',
    done: false,
    priority: 'med',
    poms: 0,
    quadrant: null,
    details: '',
    nextAction: '',
    estimateMinutes: 25,
    createdAt: '2026-09-10T09:00:00.000Z',
    updatedAt: '2026-09-10T09:00:00.000Z',
    deletedAt: null,
    revision: 0,
    ...overrides,
  };
}

function guestState({ work = [], personal = [], blocks = [], sessions = [] } = {}) {
  return { tasks: { work, personal }, blocks, sessions };
}

function block(id, taskId, overrides = {}) {
  return {
    id,
    taskId,
    startAt: '2026-09-11T09:00:00.000Z',
    endAt: '2026-09-11T09:25:00.000Z',
    deletedAt: null,
    revision: 0,
    ...overrides,
  };
}

function session(id, taskId) {
  return {
    id,
    taskId,
    mode: 'pomodoro',
    startedAt: '2026-09-10T09:00:00.000Z',
    endedAt: '2026-09-10T09:25:00.000Z',
    focusMs: 1_500_000,
    interruptions: 0,
    outcome: 'completed',
  };
}

test('a guest namespace is planned as tasks, blocks and sessions', () => {
  const plan = planGuestImport(
    guestState({
      work: [task(TASK)],
      personal: [task(OTHER_TASK, { text: 'Ring the dentist' })],
      blocks: [block(BLOCK, TASK)],
      sessions: [session(SESSION, TASK)],
    }),
    guestState(),
  );
  assert.deepEqual(plan.counts, { tasks: 2, blocks: 1, sessions: 1 });
  assert.deepEqual(plan.tasks.map((entry) => entry.list), ['work', 'personal']);
  assert.equal(plan.tasks[0].task.id, TASK, 'ids come across unchanged so a repeat import lands on the same rows');
});

test('deleted guest records are not resurrected by the import', () => {
  const plan = planGuestImport(
    guestState({
      work: [task(TASK, { deletedAt: '2026-09-10T10:00:00.000Z' })],
      blocks: [block(BLOCK, TASK, { deletedAt: '2026-09-10T10:00:00.000Z' })],
    }),
    guestState(),
  );
  assert.equal(importCount(plan.counts), 0);
});

test('a block whose task is neither imported nor held is left behind', () => {
  const plan = planGuestImport(
    guestState({ blocks: [block(BLOCK, OTHER_TASK)], sessions: [session(SESSION, OTHER_TASK)] }),
    guestState(),
  );
  assert.deepEqual(plan.counts, { tasks: 0, blocks: 0, sessions: 0 });
});

test('a block keeps its place when the account already holds its task', () => {
  const plan = planGuestImport(
    guestState({ blocks: [block(BLOCK, TASK)] }),
    guestState({ work: [task(TASK)] }),
  );
  assert.deepEqual(plan.counts, { tasks: 0, blocks: 1, sessions: 0 });
});

test('a session with no task is open focus and still comes across', () => {
  const plan = planGuestImport(guestState({ sessions: [session(SESSION, null)] }), guestState());
  assert.deepEqual(plan.counts, { tasks: 0, blocks: 0, sessions: 1 });
});

test('records the account already holds are left out of a second import', () => {
  const guest = guestState({ work: [task(TASK)], blocks: [block(BLOCK, TASK)], sessions: [session(SESSION, TASK)] });
  const plan = planGuestImport(guest, guest);
  assert.equal(importCount(plan.counts), 0, 'importing twice reports nothing to do rather than duplicating');
});

test('summary names only what there is, and counts one of a thing singly', () => {
  assert.equal(importSummary({ tasks: 3, blocks: 0, sessions: 2 }), '3 tasks and 2 sessions');
  assert.equal(importSummary({ tasks: 1, blocks: 1, sessions: 1 }), '1 task, 1 time block and 1 session');
  assert.equal(importSummary({ tasks: 0, blocks: 0, sessions: 0 }), '');
});

/** One device, one account store, and the guest store beside it. */
async function device() {
  const indexedDB = new IDBFactory();
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const open = (namespace) => createStore({ indexedDB, localStorage, namespace, BroadcastChannel: null });
  const store = open('user:account');
  await store.open();
  const applied = [];
  const client = {
    rpc: async (name, args) => {
      if (name === 'register_device') return { data: { ok: true }, error: null };
      if (name === 'pull_changes') return { data: { changes: [], cursor: 0, epoch: 1 }, error: null };
      const wire = args.p_command || args.command || args;
      applied.push(wire);
      return { data: { outcome: 'applied' }, error: null };
    },
  };
  const sync = createSync({ store, client, eventTarget: null, locks: null });
  return { store, sync, applied, open, close: () => { sync.stop(); store.close(); } };
}

test('an import writes the records and their commands in one transaction', async () => {
  const one = await device();
  try {
    const counts = await one.sync.importGuest(guestState({
      work: [task(TASK)],
      blocks: [block(BLOCK, TASK)],
      sessions: [session(SESSION, TASK)],
    }));
    assert.deepEqual(counts, { tasks: 1, blocks: 1, sessions: 1 });

    const state = await one.store.readState();
    assert.equal(state.tasks.work.length, 1);
    assert.equal(state.blocks.length, 1);
    assert.equal(state.sessions.length, 1);

    // The outbox comes back in key order, not insertion order, and commands
    // minted together share a createdAt, so the ordering push() honours has to
    // be written down rather than assumed.
    const outbox = await one.store.listOutbox();
    const byKind = new Map(outbox.map((entry) => [entry.kind, entry]));
    assert.deepEqual([...byKind.keys()].sort(), ['block.create', 'session.record', 'task.create']);
    assert.equal(byKind.get('task.create').entityId, TASK);
    const taskOpId = byKind.get('task.create').opId;
    assert.equal(byKind.get('block.create').afterOpId, taskOpId, 'a block must not reach the server before its task');
    assert.equal(byKind.get('session.record').afterOpId, taskOpId);
  } finally {
    one.close();
  }
});

test('an import that would break local state leaves the account untouched', async () => {
  const one = await device();
  try {
    await assert.rejects(one.sync.importGuest(guestState({ work: [task(TASK, { text: '   ' })] })));
    const state = await one.store.readState();
    assert.equal(state.tasks.work.length, 0);
    assert.deepEqual(await one.store.listOutbox(), [], 'no command survives a refused import');
  } finally {
    one.close();
  }
});

test('importing guest data twice does not send the same work again', async () => {
  const one = await device();
  try {
    const guest = guestState({ work: [task(TASK)], blocks: [block(BLOCK, TASK)] });
    await one.sync.importGuest(guest);
    const after = await one.sync.importGuest(guest);
    assert.deepEqual(after, { tasks: 0, blocks: 0, sessions: 0 });
    assert.equal((await one.store.readState()).tasks.work.length, 1);
    assert.equal((await one.store.listOutbox()).length, 2);
  } finally {
    one.close();
  }
});

test('a preview reports the same counts without writing anything', async () => {
  const one = await device();
  try {
    const guest = guestState({ work: [task(TASK)] });
    assert.deepEqual(await one.sync.previewGuestImport(guest), { tasks: 1, blocks: 0, sessions: 0 });
    assert.equal((await one.store.readState()).tasks.work.length, 0);
    assert.deepEqual(await one.store.listOutbox(), []);
  } finally {
    one.close();
  }
});

test('the guest namespace still holds its tasks after an import', async () => {
  const one = await device();
  const guest = one.open('guest');
  try {
    await guest.open();
    await guest.mutate((draft) => { draft.tasks.work.push(task(TASK)); });
    await one.sync.importGuest(await guest.readState());
    assert.equal((await guest.readState()).tasks.work.length, 1, 'signing out must still find the guest data');
  } finally {
    guest.close();
    one.close();
  }
});

test('an imported block reaches the server only after the task it names', async () => {
  const one = await device();
  try {
    await one.sync.importGuest(guestState({
      work: [task(TASK)],
      blocks: [block(BLOCK, TASK)],
      sessions: [session(SESSION, TASK)],
    }));
    // push() holds a command back while its dependency is still queued, so the
    // outbox drains over successive flushes rather than in one.
    for (let attempt = 0; attempt < 4 && (await one.store.listOutbox()).length; attempt += 1) {
      await one.sync.flush();
    }
    assert.deepEqual(await one.store.listOutbox(), [], 'the whole import drains');
    assert.equal(one.applied[0].kind, 'task.create', 'the task goes first');
    assert.deepEqual(one.applied.slice(1).map((wire) => wire.kind).sort(), ['block.create', 'session.record']);
    assert.equal(one.sync.getStatus().state, 'synced');
  } finally {
    one.close();
  }
});
