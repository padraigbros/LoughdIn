const DATABASE_VERSION = 2;
const STATE_SCHEMA_VERSION = 1;
const LEGACY_KEY = 'loughdin-v2';

const DEFAULT_STATE = Object.freeze({
  schemaVersion: STATE_SCHEMA_VERSION,
  tasks: { work: [], personal: [] },
  settings: {
    durations: { work: 1200, short: 300, long: 900 },
    goal: 6,
    autoCycle: false,
  },
  timer: null,
  sessions: [],
  blocks: [],
  daily: {},
  legacy: {},
  activeTask: null,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set(['low', 'med', 'high']);
const QUADRANTS = new Set(['do', 'schedule', 'delegate', 'eliminate']);

export class StorageError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'StorageError';
    this.code = options.code || 'STORAGE_ERROR';
    this.cause = options.cause;
  }
}

export class StorageRecoveryError extends StorageError {
  constructor(message, recovery, cause) {
    super(message, { code: 'RECOVERY_REQUIRED', cause });
    this.name = 'StorageRecoveryError';
    this.recovery = recovery;
  }
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function assertTask(task, list) {
  if (!plainObject(task)) throw new TypeError(`${list} contains an invalid task`);
  if (!UUID_PATTERN.test(task.id)) throw new TypeError(`Task id must be a UUID: ${String(task.id)}`);
  if (typeof task.text !== 'string' || !task.text.trim()) throw new TypeError('Task text cannot be empty');
  if (typeof task.done !== 'boolean') throw new TypeError('Task done must be a boolean');
  if (!PRIORITIES.has(task.priority)) throw new TypeError(`Invalid task priority: ${String(task.priority)}`);
  if (!Number.isInteger(task.poms) || task.poms < 0) throw new TypeError('Task poms must be a non-negative integer');
  if (task.quadrant !== null && !QUADRANTS.has(task.quadrant)) throw new TypeError('Invalid task quadrant');
  if (typeof task.details !== 'string') throw new TypeError('Task details must be a string');
  if (!Number.isInteger(task.estimateMinutes) || task.estimateMinutes <= 0) {
    throw new TypeError('Task estimateMinutes must be a positive integer');
  }
  if (typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string') {
    throw new TypeError('Task timestamps must be strings');
  }
  if (task.deletedAt !== null && typeof task.deletedAt !== 'string') {
    throw new TypeError('Task deletedAt must be null or a string');
  }
}

export function validateState(state) {
  if (!plainObject(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported local state schema: ${String(state?.schemaVersion)}`);
  }
  if (!plainObject(state.tasks) || !Array.isArray(state.tasks.work) || !Array.isArray(state.tasks.personal)) {
    throw new TypeError('State tasks must contain work and personal lists');
  }
  state.tasks.work.forEach((task) => assertTask(task, 'work'));
  state.tasks.personal.forEach((task) => assertTask(task, 'personal'));
  const durations = state.settings?.durations;
  if (!plainObject(state.settings) || !plainObject(durations)) throw new TypeError('Invalid settings');
  for (const mode of ['work', 'short', 'long']) {
    if (!isFinitePositive(durations[mode])) throw new TypeError(`Invalid ${mode} duration`);
  }
  if (!Number.isInteger(state.settings.goal) || state.settings.goal <= 0) throw new TypeError('Invalid daily goal');
  if (typeof state.settings.autoCycle !== 'boolean') throw new TypeError('Invalid autoCycle setting');
  if (!Array.isArray(state.sessions) || !Array.isArray(state.blocks)) throw new TypeError('Invalid records');
  if (!plainObject(state.daily) || !plainObject(state.legacy)) throw new TypeError('Invalid aggregate data');
  return state;
}

function makeDefaultState() {
  return clone(DEFAULT_STATE);
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('The storage clock returned an invalid date');
  return date.toISOString();
}

function fallbackUuid() {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeLegacyTask(task, list, createUuid, importedAt, idMap, usedIds) {
  if (!plainObject(task) || typeof task.text !== 'string' || !task.text.trim()) return null;
  const legacyId = task.id ?? `index-${Object.keys(idMap).length}`;
  const mapKey = `${list}:${String(legacyId)}`;
  let id = createUuid();
  while (!UUID_PATTERN.test(id) || usedIds.has(id)) id = createUuid();
  usedIds.add(id);
  idMap[mapKey] = id;
  return {
    id,
    text: task.text.trim(),
    done: Boolean(task.done),
    priority: PRIORITIES.has(task.priority) ? task.priority : 'med',
    poms: Number.isInteger(task.poms) && task.poms >= 0 ? task.poms : 0,
    quadrant: null,
    details: '',
    estimateMinutes: 25,
    createdAt: importedAt,
    updatedAt: importedAt,
    deletedAt: null,
  };
}

function migrateLegacy(raw, createUuid, now) {
  let source;
  try {
    source = JSON.parse(raw);
  } catch (cause) {
    throw new StorageRecoveryError('The legacy Lough’d In data is not valid JSON.', {
      source: LEGACY_KEY,
      raw,
      readOnly: true,
    }, cause);
  }
  if (!plainObject(source)) {
    throw new StorageRecoveryError('The legacy Lough’d In data has an unsupported shape.', {
      source: LEGACY_KEY,
      raw,
      readOnly: true,
    });
  }

  const importedAt = timestamp(now);
  const idMap = {};
  const usedIds = new Set();
  const state = makeDefaultState();
  for (const list of ['work', 'personal']) {
    const tasks = Array.isArray(source.tasks?.[list]) ? source.tasks[list] : [];
    state.tasks[list] = tasks
      .map((task) => normalizeLegacyTask(task, list, createUuid, importedAt, idMap, usedIds))
      .filter(Boolean);
  }

  if (plainObject(source.DUR)) {
    for (const mode of ['work', 'short', 'long']) {
      if (isFinitePositive(source.DUR[mode])) state.settings.durations[mode] = source.DUR[mode];
    }
  }
  if (Number.isInteger(source.GOAL) && source.GOAL > 0) state.settings.goal = source.GOAL;
  state.settings.autoCycle = Boolean(source.ACYC);
  state.legacy = {
    source: LEGACY_KEY,
    importedAt,
    rawJSON: raw,
    taskIdMap: idMap,
    aggregates: {
      pom: source.pom ?? null,
      focusSeconds: source.fSec ?? null,
      streak: source.streak ?? null,
      lastDay: source.lastDay ?? null,
      week: Array.isArray(source.wk) ? clone(source.wk) : null,
      recordedDay: source.td ?? null,
      nextLegacyId: source.nId ?? null,
    },
    note: 'Legacy aggregates are retained for reference; no focus sessions were inferred from them.',
  };
  validateState(state);
  return state;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => {};
  });
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
      if (!database.objectStoreNames.contains('outbox')) {
        const outbox = database.createObjectStore('outbox', { keyPath: 'key' });
        outbox.createIndex('namespace', 'namespace', { unique: false });
      }
      if (!database.objectStoreNames.contains('backups')) {
        const backups = database.createObjectStore('backups', { keyPath: 'key' });
        backups.createIndex('namespace', 'namespace', { unique: false });
      }
      if (!database.objectStoreNames.contains('metadata')) database.createObjectStore('metadata');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked by another tab'));
  });
}

function normalizeCommand(command, namespace, createUuid, now) {
  if (!plainObject(command)) throw new TypeError('command must be an object');
  const opId = command.opId || createUuid();
  if (!UUID_PATTERN.test(opId)) throw new TypeError('Command opId must be a UUID');
  const createdAt = command.createdAt || timestamp(now);
  const type = command.type || command.kind || 'state.mutate';
  if (typeof type !== 'string' || !type) throw new TypeError('Command type cannot be empty');
  const stored = {
    ...clone(command),
    key: `${namespace}\u0000${opId}`,
    namespace,
    opId,
    type,
    kind: command.kind || type,
    protocol: command.protocol ?? 1,
    createdAt,
    status: 'pending',
    attempts: Number.isInteger(command.attempts) && command.attempts >= 0 ? command.attempts : 0,
    lastError: command.lastError ?? null,
  };
  return stored;
}

function recordId(record) {
  return plainObject(record) && typeof record.id === 'string' ? record.id : null;
}

function mergeRecords(current, incoming, createUuid, idRemap) {
  const merged = clone(current);
  const byId = new Map(merged.map((record) => [recordId(record), record]));
  for (const record of incoming) {
    const copy = clone(record);
    const originalId = recordId(copy);
    if (!originalId || !byId.has(originalId)) {
      merged.push(copy);
      if (originalId) byId.set(originalId, copy);
      continue;
    }
    if (JSON.stringify(byId.get(originalId)) === JSON.stringify(copy)) continue;
    let replacement = createUuid();
    while (!UUID_PATTERN.test(replacement) || byId.has(replacement)) replacement = createUuid();
    copy.id = replacement;
    idRemap[originalId] = replacement;
    merged.push(copy);
    byId.set(replacement, copy);
  }
  return merged;
}

function mergeImportedState(current, incoming, createUuid, importedAt) {
  const merged = clone(current);
  const taskIdRemap = {};
  merged.tasks.work = mergeRecords(merged.tasks.work, incoming.tasks.work, createUuid, taskIdRemap);
  merged.tasks.personal = mergeRecords(merged.tasks.personal, incoming.tasks.personal, createUuid, taskIdRemap);
  const linkedSessions = clone(incoming.sessions).map((session) => {
    if (session?.taskId && taskIdRemap[session.taskId]) session.taskId = taskIdRemap[session.taskId];
    return session;
  });
  const linkedBlocks = clone(incoming.blocks).map((block) => {
    if (block?.taskId && taskIdRemap[block.taskId]) block.taskId = taskIdRemap[block.taskId];
    return block;
  });
  merged.sessions = mergeRecords(merged.sessions, linkedSessions, createUuid, {});
  merged.blocks = mergeRecords(merged.blocks, linkedBlocks, createUuid, {});
  merged.daily = { ...clone(incoming.daily), ...merged.daily };
  if (merged.timer === null && incoming.timer !== null) merged.timer = clone(incoming.timer);
  if (merged.activeTask === null && incoming.activeTask !== null) {
    merged.activeTask = clone(incoming.activeTask);
    if (merged.activeTask?.id && taskIdRemap[merged.activeTask.id]) merged.activeTask.id = taskIdRemap[merged.activeTask.id];
  }
  const imports = Array.isArray(merged.legacy.imports) ? merged.legacy.imports : [];
  merged.legacy = {
    ...merged.legacy,
    imports: [...imports, { importedAt, taskIdRemap, sourceLegacy: clone(incoming.legacy) }],
  };
  validateState(merged);
  return merged;
}

/**
 * Creates an account-scoped local store. Call open() before other methods.
 * Mutators must be synchronous; IndexedDB serializes each read-modify-write transaction.
 */
export function createStore(options = {}) {
  const idb = options.indexedDB || globalThis.indexedDB;
  const local = options.localStorage === undefined ? globalThis.localStorage : options.localStorage;
  const namespace = options.namespace || 'guest';
  const dbName = options.dbName || 'loughdin-local';
  const now = options.now || (() => new Date());
  const cryptoSource = options.crypto || globalThis.crypto;
  const createUuid = options.createUuid || (() => cryptoSource?.randomUUID?.() || fallbackUuid());
  const Broadcast = options.BroadcastChannel === undefined ? globalThis.BroadcastChannel : options.BroadcastChannel;
  let database = null;
  let channel = null;
  let recovery = null;
  let opening = null;
  const subscribers = new Set();

  function ensureReady() {
    if (!database) throw new StorageError('Call open() before using the store.', { code: 'NOT_OPEN' });
    if (recovery) throw new StorageRecoveryError('Local data needs recovery before writes can continue.', recovery);
  }

  async function notifySubscribers() {
    if (!subscribers.size || recovery) return;
    try {
      const state = await readState();
      for (const subscriber of subscribers) subscriber(clone(state));
    } catch (error) {
      for (const subscriber of subscribers) subscriber(undefined, error);
    }
  }

  function broadcast() {
    channel?.postMessage({ namespace, changedAt: timestamp(now) });
    void notifySubscribers();
  }

  async function initialize() {
    if (!idb) throw new StorageError('IndexedDB is unavailable.', { code: 'UNAVAILABLE' });
    try {
      database = await openDatabase(idb, dbName);
    } catch (cause) {
      throw new StorageError('Unable to open durable local storage.', { code: 'OPEN_FAILED', cause });
    }
    database.onversionchange = () => database.close();
    if (Broadcast) {
      channel = new Broadcast(`loughdin:${dbName}`);
      channel.onmessage = (event) => {
        if (event.data?.namespace === namespace) void notifySubscribers();
      };
    }

    let legacyRaw = null;
    if (namespace === 'guest' && local) {
      try {
        legacyRaw = local.getItem(LEGACY_KEY);
      } catch (cause) {
        recovery = { source: LEGACY_KEY, raw: null, readOnly: true, cause };
        return { status: 'recovery', recovery };
      }
    }

    const transaction = database.transaction(['state', 'backups'], 'readwrite');
    const stateStore = transaction.objectStore('state');
    try {
      const existing = await requestResult(stateStore.get(namespace));
      if (existing !== undefined) {
        validateState(existing);
        await transactionDone(transaction);
        return { status: 'ready', migrated: false };
      }

      let initial = makeDefaultState();
      if (legacyRaw !== null) initial = migrateLegacy(legacyRaw, createUuid, now);
      stateStore.put(initial, namespace);
      if (legacyRaw !== null) {
        const backupId = createUuid();
        transaction.objectStore('backups').put({
          key: `${namespace}\u0000legacy\u0000${backupId}`,
          namespace,
          id: backupId,
          kind: 'legacy-import',
          createdAt: timestamp(now),
          raw: legacyRaw,
        });
      }
      await transactionDone(transaction);
      return { status: 'ready', migrated: legacyRaw !== null };
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof StorageRecoveryError) {
        recovery = cause.recovery;
        return { status: 'recovery', recovery };
      }
      if (cause instanceof TypeError) {
        recovery = { source: 'indexeddb', raw: null, readOnly: true, cause };
        return { status: 'recovery', recovery };
      }
      throw new StorageError('Unable to initialize durable local storage.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function open() {
    if (!opening) opening = initialize();
    return opening;
  }

  async function readState() {
    if (!database) throw new StorageError('Call open() before using the store.', { code: 'NOT_OPEN' });
    if (recovery) throw new StorageRecoveryError('Local data needs recovery before it can be read.', recovery);
    try {
      const transaction = database.transaction('state', 'readonly');
      const state = await requestResult(transaction.objectStore('state').get(namespace));
      await transactionDone(transaction);
      validateState(state);
      return clone(state);
    } catch (cause) {
      if (cause instanceof StorageError || cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to read local data.', { code: 'READ_FAILED', cause });
    }
  }

  async function mutate(mutator, { command, commands } = {}) {
    ensureReady();
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    if (command && commands) throw new TypeError('Use command or commands, not both');
    const commandSource = commands || command;
    const stores = commandSource ? ['state', 'outbox'] : ['state'];
    const transaction = database.transaction(stores, 'readwrite');
    const stateStore = transaction.objectStore('state');
    let result;
    const commandRecords = [];
    try {
      const latest = await requestResult(stateStore.get(namespace));
      validateState(latest);
      const draft = clone(latest);
      result = mutator(draft);
      if (result && typeof result.then === 'function') {
        throw new TypeError('Storage mutators must be synchronous');
      }
      validateState(draft);
      stateStore.put(draft, namespace);
      if (commandSource) {
        const commandValue = typeof commandSource === 'function' ? commandSource(result, draft) : commandSource;
        if (commandValue && typeof commandValue.then === 'function') {
          throw new TypeError('Storage command factories must be synchronous');
        }
        const values = commandValue === null || commandValue === undefined
          ? []
          : (commands ? commandValue : [commandValue]);
        if (!Array.isArray(values)) throw new TypeError('Storage commands must be an array');
        const outbox = transaction.objectStore('outbox');
        const existing = await requestResult(outbox.index('namespace').getAll(namespace));
        for (const value of values) {
          if (!plainObject(value)) throw new TypeError('command must be an object');
          const prepared = clone(value);
          if (prepared.entityId && !prepared.predecessorOpId && !prepared.afterOpId) {
            const predecessor = [...existing, ...commandRecords]
              .filter((entry) => entry.entityId === prepared.entityId)
              .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
              .at(-1);
            if (predecessor) prepared.predecessorOpId = predecessor.opId;
          }
          const record = normalizeCommand(prepared, namespace, createUuid, now);
          outbox.add(record);
          commandRecords.push(record);
        }
      }
      await transactionDone(transaction);
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to save local data.', { code: 'WRITE_FAILED', cause });
    }
    broadcast();
    return {
      result,
      state: await readState(),
      command: commandRecords[0] ? clone(commandRecords[0]) : null,
      commands: commandRecords.map(clone),
    };
  }

  async function readOutbox() {
    ensureReady();
    const transaction = database.transaction('outbox', 'readonly');
    const index = transaction.objectStore('outbox').index('namespace');
    const records = await requestResult(index.getAll(namespace));
    await transactionDone(transaction);
    return records.map(clone);
  }

  async function listOutbox({ status } = {}) {
    const records = await readOutbox();
    return status ? records.filter((record) => record.status === status) : records;
  }

  async function updateOutbox(opId, updates) {
    ensureReady();
    if (!UUID_PATTERN.test(opId)) throw new TypeError('Outbox opId must be a UUID');
    if (!plainObject(updates)) throw new TypeError('Outbox updates must be an object');
    const mutable = new Set([
      'status', 'attempts', 'lastError', 'nextAttemptAt', 'serverReceipt',
      'baseRevision', 'predecessorOpId',
    ]);
    for (const key of Object.keys(updates)) {
      if (!mutable.has(key)) throw new TypeError(`Outbox command field is immutable: ${key}`);
    }
    const transaction = database.transaction('outbox', 'readwrite');
    const outbox = transaction.objectStore('outbox');
    try {
      const key = `${namespace}\u0000${opId}`;
      const current = await requestResult(outbox.get(key));
      if (!current) throw new TypeError(`Unknown outbox command: ${opId}`);
      if (current.status !== 'pending' && ('baseRevision' in updates || 'predecessorOpId' in updates)) {
        throw new TypeError('A transmitted command cannot be rebased');
      }
      const updated = { ...current, ...clone(updates), key, namespace, opId };
      outbox.put(updated);
      await transactionDone(transaction);
      broadcast();
      return clone(updated);
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to update the outbox.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function ackOutbox(opId) {
    ensureReady();
    if (!UUID_PATTERN.test(opId)) throw new TypeError('Outbox opId must be a UUID');
    const transaction = database.transaction('outbox', 'readwrite');
    try {
      transaction.objectStore('outbox').delete(`${namespace}\u0000${opId}`);
      await transactionDone(transaction);
      broadcast();
    } catch (cause) {
      try { transaction.abort(); } catch {}
      throw new StorageError('Unable to acknowledge the outbox command.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function replaceOutboxConflict(opId, { mutator = () => {}, command = null } = {}) {
    ensureReady();
    if (!UUID_PATTERN.test(opId)) throw new TypeError('Outbox opId must be a UUID');
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    const transaction = database.transaction(['state', 'outbox'], 'readwrite');
    const stateStore = transaction.objectStore('state');
    const outbox = transaction.objectStore('outbox');
    try {
      const current = await requestResult(outbox.get(`${namespace}\u0000${opId}`));
      if (!current || current.status !== 'conflict') throw new TypeError(`Unknown outbox conflict: ${opId}`);
      const latest = await requestResult(stateStore.get(namespace));
      validateState(latest);
      const draft = clone(latest);
      const records = await requestResult(outbox.index('namespace').getAll(namespace));
      const dependents = records.filter(
        (entry) => (entry.predecessorOpId || entry.afterOpId) === opId,
      );
      if (dependents.some((entry) => entry.status !== 'pending')) {
        throw new TypeError('A transmitted dependent command cannot be rebased');
      }
      const replacement = command ? normalizeCommand(command, namespace, createUuid, now) : null;
      const result = mutator(draft, clone(current), dependents.map(clone), replacement && clone(replacement));
      if (result && typeof result.then === 'function') throw new TypeError('Storage mutators must be synchronous');
      validateState(draft);
      stateStore.put(draft, namespace);
      outbox.delete(current.key);
      if (replacement) outbox.add(replacement);
      const baseRevision = current.serverReceipt?.revision
        ?? current.serverReceipt?.currentRevision
        ?? current.baseRevision;
      for (const dependent of dependents) {
        dependent.predecessorOpId = replacement?.opId ?? null;
        delete dependent.afterOpId;
        if (!replacement && baseRevision !== undefined) dependent.baseRevision = baseRevision;
        outbox.put(dependent);
      }
      await transactionDone(transaction);
      broadcast();
      return { result, state: clone(draft), command: replacement && clone(replacement) };
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to resolve the outbox conflict.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function getMetadata(key, fallback = null) {
    ensureReady();
    if (typeof key !== 'string' || !key) throw new TypeError('Metadata key cannot be empty');
    const transaction = database.transaction('metadata', 'readonly');
    const value = await requestResult(transaction.objectStore('metadata').get(`${namespace}\u0000${key}`));
    await transactionDone(transaction);
    return value === undefined ? clone(fallback) : clone(value);
  }

  async function setMetadata(key, value) {
    ensureReady();
    if (typeof key !== 'string' || !key) throw new TypeError('Metadata key cannot be empty');
    const transaction = database.transaction('metadata', 'readwrite');
    try {
      transaction.objectStore('metadata').put(clone(value), `${namespace}\u0000${key}`);
      await transactionDone(transaction);
      return clone(value);
    } catch (cause) {
      try { transaction.abort(); } catch {}
      throw new StorageError('Unable to save local metadata.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function getDeviceId() {
    ensureReady();
    const key = `${namespace}\u0000deviceId`;
    const transaction = database.transaction('metadata', 'readwrite');
    const metadata = transaction.objectStore('metadata');
    try {
      let deviceId = await requestResult(metadata.get(key));
      if (deviceId === undefined) {
        deviceId = createUuid();
        if (!UUID_PATTERN.test(deviceId)) throw new TypeError('Device id must be a UUID');
        metadata.add(deviceId, key);
      }
      await transactionDone(transaction);
      return deviceId;
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to load the device id.', { code: 'WRITE_FAILED', cause });
    }
  }

  async function exportJSON() {
    if (recovery) {
      return JSON.stringify({ format: 'loughdin-recovery', version: 1, namespace, recovery }, null, 2);
    }
    const [state, outbox] = await Promise.all([readState(), readOutbox()]);
    return JSON.stringify({
      format: 'loughdin-backup',
      version: 1,
      exportedAt: timestamp(now),
      namespace,
      state,
      outbox,
    }, null, 2);
  }

  async function importJSON(input) {
    ensureReady();
    let document;
    try {
      document = typeof input === 'string' ? JSON.parse(input) : clone(input);
    } catch (cause) {
      throw new TypeError('Import is not valid JSON', { cause });
    }
    if (!plainObject(document) || document.format !== 'loughdin-backup' || document.version !== 1) {
      throw new TypeError('Unsupported Lough’d In backup format');
    }
    validateState(document.state);
    const transaction = database.transaction(['state', 'outbox', 'backups'], 'readwrite');
    try {
      const current = await requestResult(transaction.objectStore('state').get(namespace));
      validateState(current);
      const importedAt = timestamp(now);
      const merged = mergeImportedState(current, document.state, createUuid, importedAt);
      const backupId = createUuid();
      transaction.objectStore('backups').add({
        key: `${namespace}\u0000pre-import\u0000${backupId}`,
        namespace,
        id: backupId,
        kind: 'pre-import',
        createdAt: importedAt,
        state: clone(current),
      });
      transaction.objectStore('state').put(merged, namespace);
      const commandRecord = normalizeCommand({
        type: 'backup.import',
        payload: { backupExportedAt: document.exportedAt || null },
      }, namespace, createUuid, now);
      transaction.objectStore('outbox').add(commandRecord);
      await transactionDone(transaction);
      broadcast();
      return { state: clone(merged), command: clone(commandRecord) };
    } catch (cause) {
      try { transaction.abort(); } catch {}
      if (cause instanceof TypeError) throw cause;
      throw new StorageError('Unable to import local data.', { code: 'WRITE_FAILED', cause });
    }
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') throw new TypeError('subscriber must be a function');
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function close() {
    channel?.close();
    channel = null;
    database?.close();
    database = null;
    opening = null;
  }

  return {
    open,
    readState,
    mutate,
    readOutbox,
    listOutbox,
    updateOutbox,
    ackOutbox,
    replaceOutboxConflict,
    getMetadata,
    setMetadata,
    getDeviceId,
    exportJSON,
    importJSON,
    subscribe,
    close,
    createId() {
      const id = createUuid();
      if (!UUID_PATTERN.test(id)) throw new TypeError('Generated id must be a UUID');
      return id;
    },
    get namespace() { return namespace; },
    get recovery() { return recovery ? clone(recovery) : null; },
  };
}
