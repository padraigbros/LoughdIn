/**
 * In-memory reference implementation of the server defined by
 * `supabase/migrations/202609080001_sync_foundation.sql`.
 *
 * It deliberately exposes only `rpc(name, params)`, the same surface
 * `@supabase/supabase-js` offers, so a client cannot reach it by any path that
 * production does not also have. Ownership is derived from the connection's
 * token and never from the command body, mirroring `auth.uid()` in the SQL.
 *
 * Where behaviour is asserted in tests it is modelled on the SQL, including
 * field-group conflict detection, opId idempotency with request hashing,
 * per-owner monotonic sequences, group-complete cursor paging, epoch rotation
 * and retention-driven `stale_cursor`.
 */

const TASK_FIELD_GROUPS = {
  text: ['text'],
  done: ['done'],
  classification: ['priority', 'list', 'quadrant'],
  details: ['details'],
  estimate: ['estimateMinutes'],
  nextAction: ['nextAction'],
};

const BLOCK_FIELD_GROUPS = {
  placement: ['taskId', 'startsAt', 'endsAt', 'timeZone'],
  appearance: ['colorKey'],
  status: ['status'],
};

const TASK_KEYS = ['text', 'done', 'priority', 'list', 'quadrant', 'details', 'estimateMinutes', 'nextAction'];
const BLOCK_KEYS = ['taskId', 'startsAt', 'endsAt', 'timeZone', 'colorKey', 'status'];
const PRIORITIES = new Set(['low', 'medium', 'high']);
const LISTS = new Set(['work', 'personal']);
const QUADRANTS = new Set(['do', 'schedule', 'delegate', 'eliminate']);
const BLOCK_STATUSES = new Set(['draft', 'confirmed', 'cancelled']);

function pgError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function offlineError() {
  // Matches what fetch throws in a browser with no connection.
  return new TypeError('Failed to fetch');
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** Stable stringify so an identical command always produces an identical hash. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function assertAllowedKeys(payload, allowed, context) {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) throw pgError('22023', `${context} contains an unsupported key: ${key}`);
  }
}

function groupsTouched(payload, definition) {
  return Object.entries(definition)
    .filter(([, keys]) => keys.some((key) => key in payload))
    .map(([group]) => group);
}

function createAccount(uuid) {
  return {
    tasks: new Map(),
    blocks: new Map(),
    sessions: new Map(),
    devices: new Map(),
    receipts: new Map(),
    changeLog: [],
    currentSequence: 0,
    minimumRetainedSequence: 0,
    epoch: uuid(),
  };
}

export function createReferenceServer({ now = () => Date.now(), uuid } = {}) {
  let counter = 0;
  const nextUuid = uuid || (() => {
    counter += 1;
    return `90000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  });
  const accounts = new Map();
  const calls = { register_device: 0, apply_command: 0, pull_changes: 0, bootstrap_snapshot: 0 };

  function account(ownerId) {
    if (!accounts.has(ownerId)) accounts.set(ownerId, createAccount(nextUuid));
    return accounts.get(ownerId);
  }

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function taskDocument(owner, id) {
    const task = owner.tasks.get(id);
    return task ? clone(task) : null;
  }

  function blockDocument(owner, id) {
    const block = owner.blocks.get(id);
    return block ? clone(block) : null;
  }

  function appendChange(owner, groupId, entityType, entityId, revision, operation, row) {
    owner.currentSequence += 1;
    owner.changeLog.push({
      sequence: owner.currentSequence,
      groupId,
      entityType,
      entityId,
      revision,
      operation,
      row: clone(row),
      committedAt: timestamp(),
    });
  }

  function saveReceipt(owner, opId, hash, result) {
    owner.receipts.set(opId, { hash, result: clone(result) });
    return clone(result);
  }

  function conflictResult(owner, command, hash, entityType, entityId, currentRevision, reason, current) {
    return saveReceipt(owner, command.opId, hash, {
      protocol: 1,
      opId: command.opId,
      outcome: 'conflict',
      sequence: owner.currentSequence,
      entityType,
      entityId,
      revision: currentRevision,
      conflict: { id: nextUuid(), reason, current: clone(current), proposed: clone(command.payload) },
    });
  }

  function appliedResult(owner, command, hash, entityType, entityId, revision, change) {
    return saveReceipt(owner, command.opId, hash, {
      protocol: 1,
      opId: command.opId,
      outcome: 'applied',
      sequence: owner.currentSequence,
      entityType,
      entityId,
      revision,
      change: clone(change),
    });
  }

  function registerDevice(owner, { p_device_id: deviceId, p_platform: platform, p_supported_protocol: protocol = 1 }) {
    if (!deviceId || !['web', 'android', 'test'].includes(platform) || protocol < 1) {
      throw pgError('22023', 'invalid device registration');
    }
    const existing = owner.devices.get(deviceId);
    if (existing?.revoked) throw pgError('42501', 'device is revoked');
    owner.devices.set(deviceId, { platform, protocol, revoked: false, lastSeenAt: timestamp() });
    return { deviceId, protocol, registered: true };
  }

  function applyTaskCreate(owner, command, hash) {
    assertAllowedKeys(command.payload, TASK_KEYS, 'task payload');
    if (command.baseRevision !== 0 || !('text' in command.payload)) {
      throw pgError('22023', 'task.create requires baseRevision 0 and text');
    }
    if (owner.tasks.has(command.entityId)) {
      return conflictResult(owner, command, hash, 'task', command.entityId, null, 'entity_exists',
        taskDocument(owner, command.entityId));
    }
    const priority = command.payload.priority ?? 'medium';
    const list = command.payload.list ?? 'personal';
    const quadrant = command.payload.quadrant ?? null;
    if (!PRIORITIES.has(priority)) throw pgError('22P02', `invalid input value for enum public.task_priority: "${priority}"`);
    if (!LISTS.has(list)) throw pgError('22P02', `invalid input value for enum public.task_list: "${list}"`);
    if (quadrant !== null && !QUADRANTS.has(quadrant)) {
      throw pgError('22P02', `invalid input value for enum public.task_quadrant: "${quadrant}"`);
    }
    const at = timestamp();
    const row = {
      id: command.entityId,
      text: command.payload.text,
      done: command.payload.done ?? false,
      priority,
      list,
      quadrant,
      details: command.payload.details ?? '',
      estimateMinutes: command.payload.estimateMinutes ?? null,
      nextAction: command.payload.nextAction ?? '',
      revision: 1,
      fieldRevisions: { text: 1, done: 1, classification: 1, details: 1, estimate: 1, nextAction: 1 },
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    owner.tasks.set(row.id, row);
    appendChange(owner, command.opId, 'task', row.id, 1, 'upsert', row);
    return appliedResult(owner, command, hash, 'task', row.id, 1, clone(row));
  }

  function applyTaskUpdate(owner, command, hash) {
    assertAllowedKeys(command.payload, TASK_KEYS, 'task payload');
    if (!Object.keys(command.payload).length) throw pgError('22023', 'task.update payload is empty');
    const task = owner.tasks.get(command.entityId);
    if (!task) throw pgError('P0002', 'task not found');
    const current = clone(task);
    if (task.deletedAt) {
      return conflictResult(owner, command, hash, 'task', task.id, task.revision, 'entity_deleted', current);
    }
    for (const group of groupsTouched(command.payload, TASK_FIELD_GROUPS)) {
      if ((task.fieldRevisions[group] ?? 0) > command.baseRevision) {
        return conflictResult(owner, command, hash, 'task', task.id, task.revision, `stale_${group}`, current);
      }
    }
    if ('priority' in command.payload && !PRIORITIES.has(command.payload.priority)) {
      throw pgError('22P02', `invalid input value for enum public.task_priority: "${command.payload.priority}"`);
    }
    if ('list' in command.payload && !LISTS.has(command.payload.list)) {
      throw pgError('22P02', `invalid input value for enum public.task_list: "${command.payload.list}"`);
    }
    const revision = task.revision + 1;
    for (const group of groupsTouched(command.payload, TASK_FIELD_GROUPS)) task.fieldRevisions[group] = revision;
    for (const key of TASK_KEYS) if (key in command.payload) task[key] = command.payload[key];
    task.revision = revision;
    task.updatedAt = timestamp();
    appendChange(owner, command.opId, 'task', task.id, revision, 'upsert', task);
    return appliedResult(owner, command, hash, 'task', task.id, revision, clone(task));
  }

  function applyTaskDelete(owner, command, hash) {
    assertAllowedKeys(command.payload, [], 'task.delete payload');
    const task = owner.tasks.get(command.entityId);
    if (!task) throw pgError('P0002', 'task not found');
    const current = clone(task);
    if (task.deletedAt || task.revision !== command.baseRevision) {
      return conflictResult(owner, command, hash, 'task', task.id, task.revision,
        task.deletedAt ? 'entity_deleted' : 'stale_delete', current);
    }
    const at = timestamp();
    for (const block of owner.blocks.values()) {
      if (block.taskId !== task.id || block.deletedAt || Date.parse(block.endsAt) <= now()) continue;
      block.revision += 1;
      block.fieldRevisions.status = block.revision;
      block.status = 'cancelled';
      block.deletedAt = at;
      block.updatedAt = at;
      appendChange(owner, command.opId, 'block', block.id, block.revision, 'delete', block);
    }
    const revision = task.revision + 1;
    task.deletedAt = at;
    task.revision = revision;
    task.fieldRevisions.deleted = revision;
    task.updatedAt = at;
    appendChange(owner, command.opId, 'task', task.id, revision, 'delete', task);
    return appliedResult(owner, command, hash, 'task', task.id, revision, clone(task));
  }

  function overlappingBlock(owner, { id, startsAt, endsAt, status }) {
    if (status !== 'confirmed') return null;
    for (const block of owner.blocks.values()) {
      if (block.id === id || block.deletedAt || block.status !== 'confirmed') continue;
      if (Date.parse(block.startsAt) < Date.parse(endsAt) && Date.parse(startsAt) < Date.parse(block.endsAt)) {
        return clone(block);
      }
    }
    return null;
  }

  function applyBlockCreate(owner, command, hash) {
    assertAllowedKeys(command.payload, BLOCK_KEYS, 'block payload');
    const required = ['taskId', 'startsAt', 'endsAt', 'timeZone'];
    if (command.baseRevision !== 0 || !required.every((key) => key in command.payload)) {
      throw pgError('22023', 'block.create requires baseRevision 0 and placement fields');
    }
    if (owner.blocks.has(command.entityId)) {
      return conflictResult(owner, command, hash, 'block', command.entityId, null, 'entity_exists',
        blockDocument(owner, command.entityId));
    }
    const linked = owner.tasks.get(command.payload.taskId);
    if (!linked || linked.deletedAt) {
      throw pgError('23503', 'linked task is missing, deleted, or owned by another account');
    }
    const status = command.payload.status ?? 'confirmed';
    if (!BLOCK_STATUSES.has(status)) throw pgError('22P02', `invalid input value for enum public.block_status: "${status}"`);
    const candidate = { id: command.entityId, startsAt: command.payload.startsAt, endsAt: command.payload.endsAt, status };
    const overlap = overlappingBlock(owner, candidate);
    if (overlap) return conflictResult(owner, command, hash, 'block', candidate.id, null, 'schedule_overlap', overlap);
    const at = timestamp();
    const row = {
      id: candidate.id,
      taskId: command.payload.taskId,
      startsAt: command.payload.startsAt,
      endsAt: command.payload.endsAt,
      timeZone: command.payload.timeZone,
      colorKey: command.payload.colorKey ?? 'lake',
      status,
      revision: 1,
      fieldRevisions: { placement: 1, appearance: 1, status: 1 },
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    owner.blocks.set(row.id, row);
    appendChange(owner, command.opId, 'block', row.id, 1, 'upsert', row);
    return appliedResult(owner, command, hash, 'block', row.id, 1, clone(row));
  }

  function applyBlockUpdate(owner, command, hash) {
    assertAllowedKeys(command.payload, BLOCK_KEYS, 'block payload');
    if (!Object.keys(command.payload).length) throw pgError('22023', 'block.update payload is empty');
    const block = owner.blocks.get(command.entityId);
    if (!block) throw pgError('P0002', 'block not found');
    const current = clone(block);
    if (block.deletedAt) {
      return conflictResult(owner, command, hash, 'block', block.id, block.revision, 'entity_deleted', current);
    }
    for (const group of groupsTouched(command.payload, BLOCK_FIELD_GROUPS)) {
      if ((block.fieldRevisions[group] ?? 0) > command.baseRevision) {
        return conflictResult(owner, command, hash, 'block', block.id, block.revision, `stale_${group}`, current);
      }
    }
    const merged = { ...block, ...command.payload };
    const linked = owner.tasks.get(merged.taskId);
    if (!linked || linked.deletedAt) {
      throw pgError('23503', 'linked task is missing, deleted, or owned by another account');
    }
    const overlap = overlappingBlock(owner, merged);
    if (overlap) {
      return conflictResult(owner, command, hash, 'block', block.id, block.revision, 'schedule_overlap',
        { entity: current, overlap });
    }
    const revision = block.revision + 1;
    for (const group of groupsTouched(command.payload, BLOCK_FIELD_GROUPS)) block.fieldRevisions[group] = revision;
    for (const key of BLOCK_KEYS) if (key in command.payload) block[key] = command.payload[key];
    block.revision = revision;
    block.updatedAt = timestamp();
    appendChange(owner, command.opId, 'block', block.id, revision, 'upsert', block);
    return appliedResult(owner, command, hash, 'block', block.id, revision, clone(block));
  }

  const HANDLERS = {
    'task.create': applyTaskCreate,
    'task.update': applyTaskUpdate,
    'task.delete': applyTaskDelete,
    'block.create': applyBlockCreate,
    'block.update': applyBlockUpdate,
  };

  function applyCommand(owner, { p_command: command }) {
    if (command?.protocol !== 1) throw pgError('0A000', 'unsupported sync protocol');
    if (!(command.baseRevision >= 0)) throw pgError('22023', 'baseRevision must be non-negative');
    if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
      throw pgError('22023', 'payload must be an object');
    }
    if (!HANDLERS[command.kind]) throw pgError('22023', 'unsupported command kind');
    const device = owner.devices.get(command.deviceId);
    if (!device || device.revoked || device.protocol < command.protocol) {
      throw pgError('42501', 'device is not registered, is revoked, or lacks protocol support');
    }
    const hash = canonical(command);
    const receipt = owner.receipts.get(command.opId);
    if (receipt) {
      if (receipt.hash !== hash) throw pgError('22023', 'opId was already used with a different command');
      device.lastSeenAt = timestamp();
      return clone(receipt.result);
    }
    return HANDLERS[command.kind](owner, command, hash);
  }

  function pullChanges(owner, { p_cursor: cursor = 0, p_limit: limit = 100 }) {
    if (cursor < 0 || limit < 1 || limit > 500) throw pgError('22023', 'cursor/limit out of range');
    if (cursor < owner.minimumRetainedSequence) throw pgError('P0001', 'stale_cursor');
    const pending = owner.changeLog.filter((entry) => entry.sequence > cursor && entry.sequence <= owner.currentSequence);
    const selected = [];
    let groupNumber = 0;
    for (const groupId of [...new Set(pending.map((entry) => entry.groupId))]) {
      const group = pending.filter((entry) => entry.groupId === groupId);
      groupNumber += 1;
      if (groupNumber > 1 && selected.length + group.length > limit) break;
      selected.push(...group);
    }
    selected.sort((left, right) => left.sequence - right.sequence);
    const nextCursor = selected.length ? selected[selected.length - 1].sequence : cursor;
    return {
      protocol: 1,
      epoch: owner.epoch,
      cursor: nextCursor,
      highWatermark: owner.currentSequence,
      hasMore: nextCursor < owner.currentSequence,
      changes: clone(selected),
    };
  }

  function bootstrapSnapshot(owner, { p_limit: limit = 2000 }) {
    if (limit < 1 || limit > 5000) throw pgError('22023', 'snapshot limit out of range');
    const tasks = [...owner.tasks.values()].filter((task) => !task.deletedAt);
    const blocks = [...owner.blocks.values()].filter((block) => !block.deletedAt);
    const sessions = [...owner.sessions.values()];
    const count = tasks.length + blocks.length + sessions.length;
    if (count > limit) {
      return {
        protocol: 1,
        outcome: 'too_large',
        requiredCount: count,
        limit,
        epoch: owner.epoch,
        cursor: owner.currentSequence,
        minimumCursor: owner.minimumRetainedSequence,
      };
    }
    return {
      protocol: 1,
      outcome: 'ok',
      epoch: owner.epoch,
      cursor: owner.currentSequence,
      minimumCursor: owner.minimumRetainedSequence,
      tasks: clone(tasks),
      blocks: clone(blocks),
      sessions: clone(sessions),
      events: [],
    };
  }

  const PROCEDURES = {
    register_device: registerDevice,
    apply_command: applyCommand,
    pull_changes: pullChanges,
    bootstrap_snapshot: bootstrapSnapshot,
  };

  return {
    /** RPC call counts per procedure, so a test can prove a call was or was not made. */
    calls,

    /**
     * Opens a connection bound to one account. This object is the only thing a
     * client may hold; ownership travels with the connection and never with the
     * command body, exactly as `auth.uid()` behaves in the SQL.
     */
    connect(ownerId) {
      let signedIn = true;
      let tokenValid = true;
      let offline = false;
      let dropAck = 0;
      let expireCountdown = null;
      return {
        ownerId,
        /**
         * Mirrors `@supabase/supabase-js`: a database error is returned in the
         * envelope, and only a transport failure rejects the promise.
         */
        async rpc(name, params = {}) {
          if (offline) throw offlineError();
          if (expireCountdown !== null) {
            if (expireCountdown === 0) tokenValid = false;
            else expireCountdown -= 1;
          }
          if (!signedIn || !tokenValid) return { data: null, error: pgError('28000', 'authentication required') };
          const procedure = PROCEDURES[name];
          if (!procedure) return { data: null, error: pgError('42883', `function public.${name} does not exist`) };
          calls[name] += 1;
          let result;
          try {
            result = procedure(account(ownerId), params);
          } catch (error) {
            if (!error.code) throw error;
            return { data: null, error };
          }
          if (name === 'apply_command' && dropAck > 0) {
            // The write committed; only the response was lost in transit.
            dropAck -= 1;
            throw offlineError();
          }
          return { data: result, error: null };
        },
        goOffline() { offline = true; },
        goOnline() { offline = false; },
        expireToken() { tokenValid = false; },
        /** Let the next `count` calls through, then expire the token mid-flush. */
        expireAfter(count) { expireCountdown = count; },
        refreshToken() { tokenValid = true; expireCountdown = null; },
        signOut() { signedIn = false; },
        /** Commit the next N commands but lose their acknowledgements. */
        dropAcknowledgements(count = 1) { dropAck = count; },
      };
    },

    /** Equivalent of a `select` under the read-own row level security policies. */
    readTasksAs(ownerId) {
      return [...account(ownerId).tasks.values()].filter((task) => !task.deletedAt).map(clone);
    },

    /** Advance retention so an old cursor becomes stale, as the SQL retention job does. */
    trimRetention(ownerId, minimumRetainedSequence) {
      const owner = account(ownerId);
      owner.minimumRetainedSequence = minimumRetainedSequence;
      owner.changeLog = owner.changeLog.filter((entry) => entry.sequence > minimumRetainedSequence);
    },

    /** Rotate the epoch, which forces every client to re-bootstrap. */
    rotateEpoch(ownerId) {
      account(ownerId).epoch = nextUuid();
    },

    account,
  };
}
