/**
 * Builds real clients for the two-client acceptance suite.
 *
 * A client is the production stack with nothing stubbed between the app and the
 * wire: the real IndexedDB store from `src/storage.js` (backed by
 * fake-indexeddb), the real worker from `src/sync.js`, and a connection to the
 * reference server that only offers `rpc`. Each client owns its own IndexedDB
 * factory, so two clients are genuinely two devices; a restart reuses the same
 * factory, so durable data survives exactly as it would on a real device.
 */

import { IDBFactory } from 'fake-indexeddb';
import { createStore } from '../../src/storage.js';
import { createSync } from '../../src/sync.js';

const NAMESPACE_PREFIX = 'user:';

function idSource(prefix) {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
}

function stubLocalStorage() {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

/**
 * One device. `restart()` tears down the store and reopens it against the same
 * durable storage, which is how a killed tab or a rebooted phone behaves.
 */
export async function createClient({
  server,
  ownerId,
  label,
  idPrefix,
  clock = { value: Date.parse('2026-09-10T09:00:00.000Z') },
} = {}) {
  const indexedDB = new IDBFactory();
  const createUuid = idSource(idPrefix);
  const connection = server.connect(ownerId);
  const statuses = [];
  let store = null;
  let sync = null;
  let deviceId = null;

  async function openStore() {
    store = createStore({
      indexedDB,
      localStorage: stubLocalStorage(),
      namespace: `${NAMESPACE_PREFIX}${ownerId}`,
      BroadcastChannel: null,
      now: () => new Date(clock.value),
      createUuid,
    });
    await store.open();
    deviceId = await store.getDeviceId();
    sync = createSync({
      store,
      client: connection,
      onStatus: (status) => statuses.push(status),
      now: () => clock.value,
      random: () => 0.5,
      eventTarget: null,
      locks: null,
    });
  }

  await openStore();

  const client = {
    label,
    ownerId,
    connection,
    statuses,
    indexedDB,
    get store() { return store; },
    get sync() { return sync; },
    get deviceId() { return deviceId; },
    createId: () => createUuid(),

    /** Enqueue a command the same way `src/app.js` does, through a real local write. */
    async enqueue(mutator, buildCommand) {
      return store.mutate(mutator, {
        command: (result, draft) => {
          const built = buildCommand(result, draft);
          return built && { protocol: 1, opId: createUuid(), deviceId, ...built };
        },
      });
    },

    async flush() {
      return sync.flush();
    },

    async state() {
      return store.readState();
    },

    async outbox() {
      return store.listOutbox();
    },

    async tasks(list = 'work') {
      return (await store.readState()).tasks[list];
    },

    async cursor() {
      return (await store.readState()).legacy?.sync?.cursor ?? 0;
    },

    /**
     * Open a second namespace on the same device, which is what signing in as
     * another account does. The caller closes it.
     */
    async openNamespace(otherOwnerId) {
      const other = createStore({
        indexedDB,
        localStorage: stubLocalStorage(),
        namespace: `${NAMESPACE_PREFIX}${otherOwnerId}`,
        BroadcastChannel: null,
        now: () => new Date(clock.value),
        createUuid,
      });
      await other.open();
      return other;
    },

    /** Kill the process and come back up against the same durable data. */
    async restart() {
      sync.stop();
      store.close();
      await openStore();
      return client;
    },

    async close() {
      sync.stop();
      store.close();
    },
  };

  return client;
}

/** A task payload shaped exactly like the one `src/app.js` builds. */
export function taskCreatePayload(text, { list = 'work', priority = 'med' } = {}) {
  return {
    text,
    done: false,
    priority,
    list,
    quadrant: null,
    details: '',
    estimateMinutes: 25,
    nextAction: '',
  };
}

/** The local task record `src/app.js` writes before the command leaves the device. */
export function localTask(id, text, createdAt, { priority = 'med' } = {}) {
  return {
    id,
    text,
    done: false,
    priority,
    poms: 0,
    quadrant: null,
    details: '',
    nextAction: '',
    estimateMinutes: 25,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    revision: 0,
    fieldRevisions: {},
  };
}

/** Create a task on one client, exactly as the capture form does. */
export async function captureTask(client, text, { list = 'work', priority = 'med' } = {}) {
  const id = client.createId();
  const createdAt = new Date(Date.parse('2026-09-10T09:00:00.000Z')).toISOString();
  await client.enqueue(
    (draft) => { draft.tasks[list].push(localTask(id, text, createdAt, { priority })); },
    () => ({ kind: 'task.create', entityId: id, baseRevision: 0, payload: taskCreatePayload(text, { list, priority }) }),
  );
  return id;
}

/** Edit one field of a task, carrying the revision the device currently believes. */
export async function editTask(client, id, patch, { list = 'work' } = {}) {
  await client.enqueue(
    (draft) => {
      const task = draft.tasks[list].find((entry) => entry.id === id);
      if (!task) throw new Error(`${client.label} has no task ${id}`);
      Object.assign(task, patch);
    },
    (result, draft) => {
      const task = draft.tasks[list].find((entry) => entry.id === id);
      return { kind: 'task.update', entityId: id, baseRevision: task.revision ?? 0, payload: patch };
    },
  );
}

/** Delete a task, carrying the revision the device currently believes. */
export async function deleteTask(client, id, { list = 'work' } = {}) {
  let baseRevision = 0;
  await client.enqueue(
    (draft) => {
      const index = draft.tasks[list].findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`${client.label} has no task ${id}`);
      baseRevision = draft.tasks[list][index].revision ?? 0;
      draft.tasks[list].splice(index, 1);
    },
    () => ({ kind: 'task.delete', entityId: id, baseRevision, payload: {} }),
  );
}
