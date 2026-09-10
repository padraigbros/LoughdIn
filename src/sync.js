const SYNC_KEY = 'sync';
const DEFAULT_PAGE_SIZE = 200;
const RETRY_CAP_MS = 60_000;
const ACTIVE_OUTBOX_STATUSES = new Set(['pending', 'retry', 'sending']);
const CONFLICT_OUTCOMES = new Set(['conflict', 'dependency_conflict']);
const TERMINAL_OUTCOMES = new Set(['rejected', 'invalid', 'validation_error', 'forbidden']);

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrap(response) {
  if (plainObject(response) && 'error' in response && response.error) throw response.error;
  return plainObject(response) && 'data' in response ? response.data : response;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown sync error');
}

function errorStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

function isOfflineError(error) {
  const status = errorStatus(error);
  return status === 0 && (
    error instanceof TypeError
    || ['NETWORK_ERROR', 'OFFLINE', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code)
  );
}

function retryAfterMs(error, nowMs) {
  const value = error?.retryAfter ?? error?.response?.headers?.get?.('retry-after');
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function shouldRetry(error) {
  const status = errorStatus(error);
  return isOfflineError(error) || status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoff(attempt, random, cap = RETRY_CAP_MS) {
  const base = Math.min(cap, 1000 * (2 ** Math.max(0, attempt - 1)));
  return Math.round(base * (0.75 + random() * 0.5));
}

function priorityFromServer(priority, fallback = 'med') {
  if (priority === 'low' || priority === 'med' || priority === 'high') return priority;
  if (priority === 'medium') return 'med';
  if (typeof priority === 'number') return priority >= 3 ? 'high' : priority <= 1 ? 'low' : 'med';
  return fallback;
}

/** The local vocabulary is low|med|high; the server enum is low|medium|high. */
function priorityToServer(priority) {
  return priority === 'med' ? 'medium' : priority;
}

function quadrantFromServer(quadrant) {
  return ({
    urgent_important: 'do',
    not_urgent_important: 'schedule',
    urgent_not_important: 'delegate',
    not_urgent_not_important: 'eliminate',
  })[quadrant] || quadrant || null;
}

export function rowToLocalTask(row, existing = null) {
  if (!plainObject(row) || typeof row.id !== 'string') throw new TypeError('Canonical task row is invalid');
  const createdAt = row.createdAt || row.created_at || existing?.createdAt || new Date(0).toISOString();
  const updatedAt = row.updatedAt || row.updated_at || createdAt;
  return {
    id: row.id,
    text: row.text ?? row.title ?? existing?.text ?? '',
    done: row.done ?? (row.status ? ['done', 'cancelled'].includes(row.status) : (existing?.done ?? false)),
    priority: priorityFromServer(row.priority, existing?.priority),
    poms: Number.isInteger(row.poms) && row.poms >= 0 ? row.poms : (existing?.poms || 0),
    quadrant: quadrantFromServer(row.quadrant),
    details: row.details ?? existing?.details ?? '',
    nextAction: row.nextAction ?? row.next_action ?? existing?.nextAction ?? '',
    estimateMinutes: row.estimateMinutes ?? row.estimate_minutes ?? existing?.estimateMinutes ?? 25,
    createdAt,
    updatedAt,
    deletedAt: row.deletedAt ?? row.deleted_at ?? null,
    revision: row.revision ?? existing?.revision ?? 0,
    fieldRevisions: clone(row.fieldRevisions ?? row.field_revisions ?? existing?.fieldRevisions ?? {}),
  };
}

export function rowToLocalBlock(row, existing = null) {
  if (!plainObject(row) || typeof row.id !== 'string') throw new TypeError('Canonical block row is invalid');
  return {
    ...clone(existing || {}),
    ...clone(row),
    id: row.id,
    taskId: row.taskId ?? row.task_id ?? existing?.taskId ?? null,
    startAt: row.startAt ?? row.startsAt ?? row.starts_at ?? existing?.startAt,
    endAt: row.endAt ?? row.endsAt ?? row.ends_at ?? existing?.endAt,
    revision: row.revision ?? existing?.revision ?? 0,
    fieldRevisions: clone(row.fieldRevisions ?? row.field_revisions ?? existing?.fieldRevisions ?? {}),
    deletedAt: row.deletedAt ?? row.deleted_at ?? null,
  };
}

export function rowToLocalSession(row, existing = null) {
  if (!plainObject(row) || typeof row.id !== 'string') throw new TypeError('Canonical session row is invalid');
  return {
    ...clone(existing || {}),
    ...clone(row),
    id: row.id,
    taskId: row.taskId ?? row.task_id ?? existing?.taskId ?? null,
    startedAt: row.startedAt ?? row.phaseStartedAt ?? row.phase_started_at ?? existing?.startedAt,
    endedAt: row.endedAt ?? row.ended_at ?? existing?.endedAt ?? null,
    focusMs: row.focusMs ?? row.focus_ms ?? existing?.focusMs ?? 0,
    interruptions: row.interruptions ?? existing?.interruptions ?? 0,
    outcome: row.outcome ?? existing?.outcome ?? null,
    revision: row.revision ?? existing?.revision ?? 0,
  };
}

function changeKind(change) {
  return change.entityType || change.entity_type || change.kind || change.table;
}

function changeRow(change) {
  return change.row || change.canonical || change.value || null;
}

function changeId(change) {
  return change.entityId || change.entity_id || changeRow(change)?.id;
}

function findTask(state, id) {
  for (const list of ['work', 'personal']) {
    const index = state.tasks[list].findIndex((task) => task.id === id);
    if (index >= 0) return { list, index, task: state.tasks[list][index] };
  }
  return null;
}

function replaceRecord(records, id, row, deleted, mapRow = (value) => clone(value)) {
  const index = records.findIndex((record) => record.id === id);
  if (deleted) {
    if (index >= 0) records.splice(index, 1);
    return;
  }
  if (!row) return;
  const mapped = mapRow({ ...row, id }, index >= 0 ? records[index] : null);
  if (index >= 0) records[index] = mapped;
  else records.push(mapped);
}

/** Apply a full canonical row/tombstone to the local projection. */
export function applyCanonicalChange(state, change) {
  const kind = changeKind(change);
  const row = changeRow(change);
  const id = changeId(change);
  if (!id) throw new TypeError('Canonical change has no entity id');
  const deleted = Boolean(change.deleted || change.tombstone || row?.deleted_at || row?.deletedAt);

  if (kind === 'task' || kind === 'tasks') {
    const found = findTask(state, id);
    if (deleted) {
      if (found) state.tasks[found.list].splice(found.index, 1);
      if (state.activeTask === id || state.activeTask?.id === id) state.activeTask = null;
      return state;
    }
    const mapped = rowToLocalTask({ ...row, id }, found?.task);
    const target = row?.category === 'personal' || row?.list === 'personal' ? 'personal' : (found?.list || 'work');
    if (found && found.list !== target) state.tasks[found.list].splice(found.index, 1);
    const targetIndex = state.tasks[target].findIndex((task) => task.id === id);
    if (targetIndex >= 0) state.tasks[target][targetIndex] = mapped;
    else state.tasks[target].push(mapped);
    return state;
  }
  if (kind === 'block' || kind === 'time_block' || kind === 'time_blocks' || kind === 'blocks') {
    replaceRecord(state.blocks, id, row, deleted, rowToLocalBlock);
    return state;
  }
  if (kind === 'session' || kind === 'focus_session' || kind === 'focus_sessions' || kind === 'sessions') {
    replaceRecord(state.sessions, id, row, deleted, rowToLocalSession);
    return state;
  }
  throw new TypeError(`Unsupported canonical entity type: ${String(kind)}`);
}

function normalizePull(result) {
  const page = unwrap(result) || {};
  if (page.bootstrap_required || page.bootstrapRequired || page.status === 'bootstrap_required') {
    return { bootstrapRequired: true, raw: page };
  }
  const changes = page.changes || page.rows || [];
  if (!Array.isArray(changes)) throw new TypeError('Pull response changes must be an array');
  return {
    changes,
    cursor: page.nextCursor ?? page.next_cursor ?? page.cursor ?? null,
    epoch: page.epoch ?? null,
    hasMore: Boolean(page.hasMore ?? page.has_more),
    groupComplete: page.groupComplete ?? page.group_complete ?? true,
    snapshot: page.snapshot || null,
  };
}

function normalizeBootstrap(result) {
  const snapshot = unwrap(result) || {};
  if (snapshot.outcome === 'too_large') {
    const error = new Error(`Account snapshot has ${snapshot.requiredCount} records; this client supports ${snapshot.limit}`);
    error.code = 'BOOTSTRAP_TOO_LARGE';
    error.snapshot = snapshot;
    throw error;
  }
  if (snapshot.outcome && snapshot.outcome !== 'ok') {
    throw new Error(`Unknown bootstrap outcome: ${snapshot.outcome}`);
  }
  const changes = [];
  for (const [entityType, key] of [['task', 'tasks'], ['block', 'blocks'], ['session', 'sessions']]) {
    const rows = snapshot[key] || [];
    if (!Array.isArray(rows)) throw new TypeError(`Bootstrap ${key} must be an array`);
    for (const row of rows) changes.push({ entityType, entityId: row.id, row });
  }
  return {
    changes,
    cursor: snapshot.cursor ?? 0,
    epoch: snapshot.epoch ?? null,
    hasMore: false,
    groupComplete: true,
    snapshot: true,
  };
}

function normalizeReceipt(response) {
  const receipt = unwrap(response) || {};
  const outcome = receipt.outcome || receipt.status || (receipt.conflict ? 'conflict' : 'applied');
  return { ...receipt, outcome };
}

/** Strip all local/account fields before sending. Server ownership comes only from auth. */
export function toWireCommand(command) {
  const wire = {};
  for (const key of [
    'protocol', 'opId', 'deviceId', 'entityId', 'kind', 'baseRevision',
    'payload',
  ]) {
    if (command[key] !== undefined) wire[key] = clone(command[key]);
  }
  wire.protocol ??= 1;
  wire.kind ??= command.type;
  if (plainObject(wire.payload) && wire.payload.priority !== undefined) {
    wire.payload.priority = priorityToServer(wire.payload.priority);
  }
  return wire;
}

/**
 * The outbox also records local-only work such as `backup.import`, which the
 * server has no command kind for. Sending one would be rejected as an unknown
 * kind and would park the whole outbox in an error state, so those records stay
 * on the device and are not counted as pending sync work.
 */
function isWireCommand(command) {
  return /^(task|block|session)\./.test(String(command.kind || command.type || ''));
}

function pendingEntityIds(outbox) {
  return new Set(outbox.filter((entry) => entry.entityId).map((entry) => entry.entityId));
}

function applyChanges(state, changes, protectedIds, applyChange) {
  for (const change of changes) {
    if (protectedIds.has(changeId(change))) continue;
    applyChange(state, change);
  }
}

function syncMetaFromState(state) {
  return plainObject(state.legacy?.sync) ? state.legacy.sync : {};
}

function isDue(command, nowMs) {
  if (!ACTIVE_OUTBOX_STATUSES.has(command.status)) return false;
  return !command.nextAttemptAt || Date.parse(command.nextAttemptAt) <= nowMs;
}

function orderCommands(commands) {
  return [...commands].sort((left, right) => {
    const time = String(left.createdAt).localeCompare(String(right.createdAt));
    return time || String(left.opId).localeCompare(String(right.opId));
  });
}

function isStaleCursor(error) {
  return error?.code === 'P0001' && errorMessage(error).includes('stale_cursor')
    || errorMessage(error) === 'stale_cursor';
}

function isAuthError(error) {
  return errorStatus(error) === 401
    || ['28000', 'PGRST301'].includes(error?.code)
    || /authentication required|jwt/i.test(errorMessage(error));
}

function createTransport(client) {
  if (typeof client.rpc !== 'function') {
    return {
      registerDevice: client.registerDevice?.bind(client),
      applyCommand: client.applyCommand?.bind(client),
      pull: client.pull?.bind(client),
      bootstrap: client.bootstrap?.bind(client),
    };
  }
  return {
    registerDevice: (deviceId) => client.rpc('register_device', {
      p_device_id: deviceId,
      p_platform: 'web',
      p_supported_protocol: 1,
    }),
    applyCommand: (command) => client.rpc('apply_command', { p_command: command }),
    pull: ({ cursor, limit }) => client.rpc('pull_changes', {
      p_cursor: cursor ?? 0,
      p_limit: limit,
    }),
    bootstrap: ({ pageSize }) => client.rpc('bootstrap_snapshot', {
      p_limit: Math.min(5000, Math.max(2000, pageSize)),
    }),
  };
}

/**
 * Creates one serialized sync worker. The caller decides whether an authenticated
 * account may start it; guest namespaces are never uploaded automatically here.
 */
export function createSync({
  store,
  client,
  onStatus = () => {},
  applyChange = applyCanonicalChange,
  pageSize = DEFAULT_PAGE_SIZE,
  now = () => Date.now(),
  random = Math.random,
  retryCapMs = RETRY_CAP_MS,
  eventTarget = globalThis.window,
  locks = globalThis.navigator?.locks,
} = {}) {
  if (!store || !client) throw new TypeError('createSync requires store and client');
  const transport = createTransport(client);
  let running = false;
  let stopped = true;
  let flushPromise = null;
  let unsubscribe = null;
  let retryTimer = null;
  let generation = 0;
  let deviceRegistered = false;
  let status = { state: 'local', pending: 0, conflicts: 0, error: null };

  function publish(state, detail = {}) {
    status = { ...status, ...detail, state };
    onStatus(clone(status));
  }

  async function refreshStatus(preferred = null) {
    const outbox = (await store.listOutbox()).filter(isWireCommand);
    const conflicts = outbox.filter((command) => command.status === 'conflict').length;
    const errors = outbox.filter((command) => command.status === 'error').length;
    const pending = outbox.filter((command) => ACTIVE_OUTBOX_STATUSES.has(command.status)).length;
    const state = conflicts ? 'conflict' : errors ? 'error' : pending ? (preferred || 'pending') : (preferred || 'synced');
    publish(state, { pending, conflicts, error: errors ? status.error : null });
    return outbox;
  }

  function clearRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function schedule(delay = 0) {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush().catch(() => {});
    }, delay);
  }

  async function commitPullPage(page, outbox, replace = false) {
    if (!page.groupComplete) throw new Error('Server returned an incomplete transaction group');
    const protectedIds = pendingEntityIds(outbox);
    await store.mutate((state) => {
      if (replace) {
        for (const list of ['work', 'personal']) {
          state.tasks[list] = state.tasks[list].filter((record) => protectedIds.has(record.id));
        }
        state.blocks = state.blocks.filter((record) => protectedIds.has(record.id));
        state.sessions = state.sessions.filter((record) => protectedIds.has(record.id));
      }
      applyChanges(state, page.changes, protectedIds, applyChange);
      state.legacy.sync = {
        ...syncMetaFromState(state),
        cursor: page.cursor,
        epoch: page.epoch ?? syncMetaFromState(state).epoch ?? null,
        lastPulledAt: new Date(now()).toISOString(),
      };
    });
  }

  async function bootstrap(outbox, requested = null) {
    if (typeof transport.bootstrap !== 'function') {
      const error = new Error('The server requires a bootstrap but no bootstrap adapter is configured');
      error.code = 'BOOTSTRAP_REQUIRED';
      throw error;
    }
    const result = normalizeBootstrap(await transport.bootstrap({ pageSize, epoch: requested?.epoch ?? null }));
    await commitPullPage(result, outbox, true);
  }

  async function pull() {
    if (typeof transport.pull !== 'function') return;
    let more = true;
    while (more) {
      const state = await store.readState();
      const meta = syncMetaFromState(state);
      const outbox = await store.listOutbox();
      let page;
      try {
        page = normalizePull(await transport.pull({
          cursor: meta.cursor ?? 0,
          epoch: meta.epoch ?? null,
          limit: pageSize,
        }));
      } catch (error) {
        if (!isStaleCursor(error)) throw error;
        await bootstrap(outbox, { epoch: meta.epoch ?? null });
        return;
      }
      if (page.bootstrapRequired) {
        await bootstrap(outbox, page.raw);
        return;
      }
      if (meta.epoch && page.epoch && meta.epoch !== page.epoch) {
        await bootstrap(outbox, page);
        return;
      }
      await commitPullPage(page, outbox);
      more = page.hasMore;
      if (more && page.cursor === meta.cursor) throw new Error('Pull cursor did not advance');
    }
  }

  async function applyReceipt(command, receipt) {
    const changes = receipt.changes || (receipt.canonical || receipt.row
      ? [{
          entityType: receipt.entityType || receipt.entity_type || command.kind?.split('.')[0],
          entityId: command.entityId,
          row: receipt.canonical || receipt.row,
        }]
      : []);
    if (changes.length) {
      await store.mutate((state) => applyChanges(state, changes, new Set(), applyChange));
    }
    await store.ackOutbox(command.opId);

    const newBase = receipt.baseRevision ?? receipt.revision ?? receipt.resultRevision;
    if (newBase === undefined) return;
    const remaining = await store.listOutbox();
    for (const dependent of remaining) {
      if ((dependent.afterOpId || dependent.predecessorOpId) === command.opId && dependent.status === 'pending') {
        await store.updateOutbox(dependent.opId, { baseRevision: newBase });
      }
    }
  }

  async function markFailure(command, error) {
    const attempts = (command.attempts || 0) + 1;
    // An expired token is recoverable: the auth client refreshes it in the
    // background, so the command waits rather than being parked as an error.
    const expired = isAuthError(error);
    if (expired) deviceRegistered = false;
    if (expired || shouldRetry(error)) {
      const delay = retryAfterMs(error, now()) ?? backoff(attempts, random, retryCapMs);
      const nextAttemptAt = new Date(now() + delay).toISOString();
      await store.updateOutbox(command.opId, {
        status: 'retry', attempts, lastError: errorMessage(error), nextAttemptAt,
      });
      publish(expired ? 'auth' : isOfflineError(error) ? 'offline' : 'pending', { error: errorMessage(error) });
      schedule(delay);
      return;
    }
    await store.updateOutbox(command.opId, {
      status: 'error', attempts, lastError: errorMessage(error), nextAttemptAt: null,
    });
    publish('error', { error: errorMessage(error) });
  }

  /**
   * The server rejects any command from an unknown device, so the device has to
   * be registered once per signed-in session before the first command is sent.
   */
  async function ensureDevice() {
    if (deviceRegistered) return;
    if (typeof transport.registerDevice !== 'function' || typeof store.getDeviceId !== 'function') return;
    const deviceId = await store.getDeviceId();
    if (!deviceId) return;
    unwrap(await transport.registerDevice(deviceId));
    deviceRegistered = true;
  }

  async function push() {
    const snapshot = orderCommands((await store.listOutbox()).filter(isWireCommand));
    if (snapshot.some((command) => isDue(command, now()))) await ensureDevice();
    const byId = new Map(snapshot.map((command) => [command.opId, command]));
    const blocked = new Set(
      snapshot.filter((command) => command.status === 'conflict' || command.status === 'error').map((command) => command.opId),
    );
    for (const command of snapshot) {
      if (!isDue(command, now())) continue;
      const dependency = command.afterOpId || command.predecessorOpId;
      if (dependency && byId.has(dependency)) {
        if (blocked.has(dependency)) {
          await store.updateOutbox(command.opId, {
            status: 'conflict',
            lastError: `Blocked by unresolved command ${dependency}`,
          });
          blocked.add(command.opId);
        }
        continue;
      }
      const attempts = (command.attempts || 0) + 1;
      await store.updateOutbox(command.opId, {
        status: 'sending', attempts, lastError: null, nextAttemptAt: null,
      });
      let receipt;
      try {
        receipt = normalizeReceipt(await transport.applyCommand(toWireCommand(command)));
      } catch (error) {
        // `attempts` is already durable. markFailure receives the pre-send value.
        await markFailure(command, error);
        continue;
      }
      if (CONFLICT_OUTCOMES.has(receipt.outcome)) {
        await store.updateOutbox(command.opId, {
          status: 'conflict', attempts, lastError: receipt.reason || 'Conflict requires resolution', serverReceipt: receipt,
        });
        blocked.add(command.opId);
        publish('conflict', { error: receipt.reason || null });
        continue;
      }
      if (TERMINAL_OUTCOMES.has(receipt.outcome)) {
        await store.updateOutbox(command.opId, {
          status: 'error', attempts, lastError: receipt.reason || receipt.outcome, serverReceipt: receipt,
        });
        publish('error', { error: receipt.reason || receipt.outcome });
        continue;
      }
      if (!['applied', 'ok', 'duplicate', 'accepted'].includes(receipt.outcome)) {
        await markFailure(command, new Error(`Unknown command outcome: ${receipt.outcome}`));
        continue;
      }
      await applyReceipt(command, receipt);
      byId.delete(command.opId);
    }
  }

  async function runFlush() {
    publish('pending', { error: null });
    try {
      await pull();
      await push();
      await pull();
      await refreshStatus();
      return clone(status);
    } catch (error) {
      if (isAuthError(error)) {
        deviceRegistered = false;
        publish('auth', { error: errorMessage(error) });
      } else {
        publish(isOfflineError(error) ? 'offline' : 'error', { error: errorMessage(error) });
      }
      throw error;
    }
  }

  async function withLock(work) {
    if (!locks?.request) return work();
    let acquired = false;
    const result = await locks.request(`loughdin-sync:${store.namespace}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return null;
      acquired = true;
      return work();
    });
    if (!acquired) {
      await refreshStatus('pending');
      return clone(status);
    }
    return result;
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = withLock(runFlush).finally(() => { flushPromise = null; });
    return flushPromise;
  }

  async function start() {
    if (running) return clone(status);
    stopped = false;
    running = true;
    unsubscribe = store.subscribe(() => schedule());
    eventTarget?.addEventListener?.('online', schedule);
    await refreshStatus('local');
    return flush();
  }

  function stop() {
    stopped = true;
    running = false;
    deviceRegistered = false;
    clearRetry();
    unsubscribe?.();
    unsubscribe = null;
    eventTarget?.removeEventListener?.('online', schedule);
    publish('local', { error: null });
  }

  // A conflicted command carries the server's account of the clash in
  // serverReceipt, written by private.save_conflict. Resolution is purely
  // local: the server already refused the command and recorded it, so there is
  // nothing to withdraw remotely.
  function describeConflict(command) {
    const receipt = command.serverReceipt || {};
    return {
      opId: command.opId,
      kind: command.kind,
      entityType: receipt.entityType || receipt.entity_type || command.kind?.split('.')[0] || null,
      entityId: command.entityId ?? receipt.entityId ?? receipt.entity_id ?? null,
      reason: command.lastError || receipt.reason || 'Conflict requires resolution',
      proposed: receipt.proposed ?? command.payload ?? null,
      current: receipt.current ?? receipt.currentValue ?? receipt.current_value ?? null,
      baseRevision: command.baseRevision ?? null,
      currentRevision: receipt.currentRevision ?? receipt.current_revision ?? null,
      blockedBy: command.afterOpId || command.predecessorOpId || null,
    };
  }

  async function listConflicts() {
    const outbox = (await store.listOutbox()).filter(isWireCommand);
    return outbox.filter((command) => command.status === 'conflict').map(describeConflict);
  }

  // dependentsOf walks the queue behind opId transitively, since push() marks
  // a whole dependent chain as conflicted when its head clashes.
  function dependentsOf(outbox, opId) {
    const found = [];
    const frontier = [opId];
    while (frontier.length) {
      const parent = frontier.pop();
      for (const command of outbox) {
        if ((command.afterOpId || command.predecessorOpId) !== parent) continue;
        if (found.includes(command)) continue;
        found.push(command);
        frontier.push(command.opId);
      }
    }
    return found;
  }

  async function resolveConflict(opId, { strategy = 'server' } = {}) {
    if (strategy !== 'server' && strategy !== 'local') {
      throw new TypeError(`Unknown conflict strategy: ${strategy}`);
    }
    const outbox = (await store.listOutbox()).filter(isWireCommand);
    const command = outbox.find((entry) => entry.opId === opId);
    if (!command) throw new Error(`No queued command ${opId}`);
    if (command.status !== 'conflict') throw new Error(`Command ${opId} is not in conflict`);
    const dependents = dependentsOf(outbox, opId);

    if (strategy === 'server') {
      // Taking the server's version voids this command, and with it everything
      // queued behind it: those commands were built on a base that is now gone.
      for (const dependent of dependents) await store.ackOutbox(dependent.opId);
      await store.ackOutbox(opId);
    } else {
      // Keeping the local change means replaying it against what the server
      // holds now, so it rebases onto the revision the receipt reported.
      const receipt = command.serverReceipt || {};
      const rebase = receipt.currentRevision ?? receipt.current_revision ?? command.baseRevision;
      await store.updateOutbox(opId, {
        status: 'pending', baseRevision: rebase, attempts: 0,
        lastError: null, nextAttemptAt: null, serverReceipt: null,
      });
      // Dependents were parked only because their head was stuck. Freeing the
      // head frees them, and push() re-blocks them if it clashes again.
      for (const dependent of dependents) {
        if (dependent.status !== 'conflict') continue;
        await store.updateOutbox(dependent.opId, {
          status: 'pending', lastError: null, nextAttemptAt: null,
        });
      }
    }
    await refreshStatus();
    schedule(0);
  }

  return {
    start,
    stop,
    flush,
    listConflicts,
    resolveConflict,
    getStatus: () => clone(status),
  };
}
