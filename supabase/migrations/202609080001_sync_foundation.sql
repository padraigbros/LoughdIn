-- Lough'd In v1 server schema and command-sync boundary.
-- This migration is intended for a fresh Supabase project.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist;

create schema if not exists private;

create type public.task_priority as enum ('low', 'medium', 'high');
create type public.task_list as enum ('work', 'personal');
create type public.task_quadrant as enum ('do', 'schedule', 'delegate', 'eliminate');
create type public.block_status as enum ('draft', 'confirmed', 'cancelled');
create type public.focus_mode as enum ('pomodoro', 'flow');
create type public.focus_state as enum ('running', 'paused', 'ended');
create type public.focus_phase as enum ('focus', 'short_break', 'long_break');
create type public.focus_outcome as enum ('completed', 'partial', 'abandoned', 'needs_review');
create type public.focus_event_kind as enum
  ('start', 'pause', 'resume', 'phase_end', 'interrupt', 'end', 'takeover', 'correct');

create table public.tasks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  text text not null check (length(btrim(text)) between 1 and 300),
  done boolean not null default false,
  priority public.task_priority not null default 'medium',
  list_key public.task_list not null default 'personal',
  quadrant public.task_quadrant,
  details text not null default '' check (length(details) <= 20000),
  estimate_minutes integer check (estimate_minutes between 1 and 10080),
  next_action text not null default '' check (length(next_action) <= 1000),
  revision bigint not null default 1 check (revision > 0),
  field_revisions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_revisions) = 'object'),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);

create table public.time_blocks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  task_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null check (length(time_zone) between 1 and 100),
  color_key text not null default 'lake'
    check (color_key in ('lake', 'clay', 'heather', 'neutral')),
  status public.block_status not null default 'confirmed',
  revision bigint not null default 1 check (revision > 0),
  field_revisions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_revisions) = 'object'),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  exclude using gist (
    owner_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (deleted_at is null and status = 'confirmed')
);

create table public.focus_sessions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  task_id uuid,
  block_id uuid,
  mode public.focus_mode not null,
  state public.focus_state not null,
  owner_device_id uuid not null,
  revision bigint not null default 1 check (revision > 0),
  phase public.focus_phase not null default 'focus',
  phase_index integer not null default 0 check (phase_index >= 0),
  phase_started_at timestamptz not null,
  phase_deadline_at timestamptz,
  paused_remaining_ms bigint check (paused_remaining_ms >= 0),
  focus_ms bigint not null default 0 check (focus_ms >= 0),
  break_ms bigint not null default 0 check (break_ms >= 0),
  interruptions integer not null default 0 check (interruptions >= 0),
  completed_focus_cycles integer not null default 0 check (completed_focus_cycles >= 0),
  outcome public.focus_outcome,
  ended_at timestamptz,
  config_snapshot jsonb not null check (
    jsonb_typeof(config_snapshot) = 'object'
    and octet_length(config_snapshot::text) <= 8192
  ),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id),
  foreign key (owner_id, block_id) references public.time_blocks(owner_id, id),
  check ((state = 'ended') = (ended_at is not null)),
  check ((state = 'ended') = (outcome is not null)),
  check (mode = 'flow' or state = 'ended' or phase_deadline_at is not null or state = 'paused')
);

create unique index one_active_session_per_owner
  on public.focus_sessions(owner_id) where state in ('running', 'paused');

create table public.focus_events (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  session_id uuid not null,
  device_id uuid not null,
  kind public.focus_event_kind not null,
  logical_key text not null check (length(logical_key) between 1 and 200),
  occurred_at timestamptz not null,
  received_at timestamptz not null default statement_timestamp(),
  elapsed_ms bigint check (elapsed_ms >= 0),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
  ),
  primary key (owner_id, id),
  unique (owner_id, session_id, logical_key),
  foreign key (owner_id, session_id) references public.focus_sessions(owner_id, id)
);

create table private.devices (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  platform text not null check (platform in ('web', 'android', 'test')),
  supported_protocol integer not null default 1 check (supported_protocol >= 1),
  acknowledged_cursor bigint not null default 0 check (acknowledged_cursor >= 0),
  created_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz not null default statement_timestamp(),
  revoked_at timestamptz,
  primary key (owner_id, id)
);

create table private.sync_heads (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  current_sequence bigint not null default 0 check (current_sequence >= 0),
  minimum_retained_sequence bigint not null default 0 check (
    minimum_retained_sequence >= 0 and minimum_retained_sequence <= current_sequence
  ),
  epoch uuid not null default extensions.gen_random_uuid(),
  updated_at timestamptz not null default statement_timestamp()
);

create table private.operation_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  op_id uuid not null,
  device_id uuid not null,
  request_hash bytea not null,
  request_body jsonb not null,
  outcome text not null check (outcome in ('applied', 'conflict')),
  entity_type text not null check (entity_type in ('task', 'block', 'session')),
  entity_id uuid not null,
  result_revision bigint,
  result jsonb not null,
  processed_at timestamptz not null default statement_timestamp(),
  primary key (owner_id, op_id),
  foreign key (owner_id, device_id) references private.devices(owner_id, id)
);

create table private.change_log (
  owner_id uuid not null references auth.users(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  group_id uuid not null,
  entity_type text not null check (entity_type in ('task', 'block', 'session')),
  entity_id uuid not null,
  entity_revision bigint not null check (entity_revision > 0),
  operation text not null check (operation in ('upsert', 'delete')),
  row_data jsonb not null,
  committed_at timestamptz not null default statement_timestamp(),
  primary key (owner_id, sequence)
);

create table private.conflicts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default extensions.gen_random_uuid(),
  op_id uuid not null,
  device_id uuid not null,
  entity_type text not null check (entity_type in ('task', 'block', 'session')),
  entity_id uuid not null,
  base_revision bigint not null,
  current_revision bigint,
  reason text not null,
  proposed jsonb not null,
  current_value jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by_op uuid,
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  primary key (owner_id, id),
  unique (owner_id, op_id),
  foreign key (owner_id, device_id) references private.devices(owner_id, id)
);

create index tasks_matrix on public.tasks(owner_id, quadrant, done)
  where deleted_at is null;
create index blocks_agenda on public.time_blocks(owner_id, starts_at)
  where deleted_at is null;
create index blocks_task_active on public.time_blocks(owner_id, task_id)
  where deleted_at is null;
create index sessions_history on public.focus_sessions(owner_id, ended_at);
create index sessions_task on public.focus_sessions(owner_id, task_id)
  where task_id is not null;
create index sessions_block on public.focus_sessions(owner_id, block_id)
  where block_id is not null;
create index focus_events_session on public.focus_events(owner_id, session_id, occurred_at);
create index receipts_device on private.operation_receipts(owner_id, device_id);
create index changes_group on private.change_log(owner_id, group_id, sequence);
create index conflicts_open on private.conflicts(owner_id, created_at) where status = 'open';
create index conflicts_device on private.conflicts(owner_id, device_id);

create function private.reject_immutable_change()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception using errcode = '55000', message = tg_table_name || ' rows are immutable';
end
$fn$;

create trigger operation_receipts_immutable
before update or delete on private.operation_receipts
for each row execute function private.reject_immutable_change();
create trigger change_log_immutable
before update or delete on private.change_log
for each row execute function private.reject_immutable_change();

create function private.task_document(p_owner uuid, p_id uuid)
returns jsonb language sql stable set search_path = '' as $fn$
  select jsonb_build_object(
    'id', t.id, 'text', t.text, 'done', t.done, 'priority', t.priority,
    'list', t.list_key, 'quadrant', t.quadrant, 'details', t.details,
    'estimateMinutes', t.estimate_minutes, 'nextAction', t.next_action,
    'revision', t.revision, 'fieldRevisions', t.field_revisions,
    'createdAt', t.created_at, 'updatedAt', t.updated_at, 'deletedAt', t.deleted_at
  ) from public.tasks t where t.owner_id = p_owner and t.id = p_id
$fn$;

create function private.block_document(p_owner uuid, p_id uuid)
returns jsonb language sql stable set search_path = '' as $fn$
  select jsonb_build_object(
    'id', b.id, 'taskId', b.task_id, 'startsAt', b.starts_at, 'endsAt', b.ends_at,
    'timeZone', b.time_zone, 'colorKey', b.color_key, 'status', b.status,
    'revision', b.revision, 'fieldRevisions', b.field_revisions,
    'createdAt', b.created_at, 'updatedAt', b.updated_at, 'deletedAt', b.deleted_at
  ) from public.time_blocks b where b.owner_id = p_owner and b.id = p_id
$fn$;

create function private.session_document(p_owner uuid, p_id uuid)
returns jsonb language sql stable set search_path = '' as $fn$
  select jsonb_build_object(
    'id', s.id, 'taskId', s.task_id, 'blockId', s.block_id, 'mode', s.mode,
    'state', s.state, 'ownerDeviceId', s.owner_device_id, 'revision', s.revision,
    'phase', s.phase, 'phaseIndex', s.phase_index, 'phaseStartedAt', s.phase_started_at,
    'phaseDeadlineAt', s.phase_deadline_at, 'pausedRemainingMs', s.paused_remaining_ms,
    'focusMs', s.focus_ms, 'breakMs', s.break_ms, 'interruptions', s.interruptions,
    'completedFocusCycles', s.completed_focus_cycles, 'outcome', s.outcome,
    'endedAt', s.ended_at, 'configSnapshot', s.config_snapshot,
    'createdAt', s.created_at, 'updatedAt', s.updated_at
  ) from public.focus_sessions s where s.owner_id = p_owner and s.id = p_id
$fn$;

create function private.assert_allowed_keys(p_value jsonb, p_allowed text[], p_context text)
returns void language plpgsql immutable set search_path = '' as $fn$
declare v_key text;
begin
  if jsonb_typeof(p_value) <> 'object' then
    raise exception using errcode = '22023', message = p_context || ' must be a JSON object';
  end if;
  for v_key in select jsonb_object_keys(p_value) loop
    if not (v_key = any(p_allowed)) then
      raise exception using errcode = '22023', message = 'unexpected ' || p_context || ' key: ' || v_key;
    end if;
  end loop;
end
$fn$;

create function private.save_conflict(
  p_owner uuid, p_op uuid, p_device uuid, p_hash bytea, p_request jsonb,
  p_entity_type text, p_entity_id uuid, p_base_revision bigint,
  p_current_revision bigint, p_reason text, p_proposed jsonb,
  p_current jsonb, p_sequence bigint
) returns jsonb language plpgsql set search_path = '' as $fn$
declare v_conflict_id uuid := extensions.gen_random_uuid(); v_result jsonb;
begin
  insert into private.conflicts(
    owner_id, id, op_id, device_id, entity_type, entity_id, base_revision,
    current_revision, reason, proposed, current_value
  ) values (
    p_owner, v_conflict_id, p_op, p_device, p_entity_type, p_entity_id,
    p_base_revision, p_current_revision, p_reason, p_proposed, p_current
  );
  v_result := jsonb_build_object(
    'protocol', 1, 'opId', p_op, 'outcome', 'conflict', 'sequence', p_sequence,
    'entityType', p_entity_type, 'entityId', p_entity_id,
    'revision', p_current_revision,
    'conflict', jsonb_build_object(
      'id', v_conflict_id, 'reason', p_reason, 'current', p_current, 'proposed', p_proposed
    )
  );
  insert into private.operation_receipts(
    owner_id, op_id, device_id, request_hash, request_body, outcome,
    entity_type, entity_id, result_revision, result
  ) values (
    p_owner, p_op, p_device, p_hash, p_request, 'conflict', p_entity_type,
    p_entity_id, p_current_revision, v_result
  );
  return v_result;
end
$fn$;

create function private.save_applied(
  p_owner uuid, p_op uuid, p_device uuid, p_hash bytea, p_request jsonb,
  p_entity_type text, p_entity_id uuid, p_revision bigint,
  p_sequence bigint, p_change jsonb
) returns jsonb language plpgsql set search_path = '' as $fn$
declare v_result jsonb;
begin
  v_result := jsonb_build_object(
    'protocol', 1, 'opId', p_op, 'outcome', 'applied', 'sequence', p_sequence,
    'entityType', p_entity_type, 'entityId', p_entity_id,
    'revision', p_revision, 'change', p_change
  );
  insert into private.operation_receipts(
    owner_id, op_id, device_id, request_hash, request_body, outcome,
    entity_type, entity_id, result_revision, result
  ) values (
    p_owner, p_op, p_device, p_hash, p_request, 'applied', p_entity_type,
    p_entity_id, p_revision, v_result
  );
  return v_result;
end
$fn$;

create function public.register_device(
  p_device_id uuid, p_platform text, p_supported_protocol integer default 1
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception using errcode = '28000', message = 'authentication required'; end if;
  if p_device_id is null or p_platform not in ('web', 'android', 'test') or p_supported_protocol < 1 then
    raise exception using errcode = '22023', message = 'invalid device registration';
  end if;
  insert into private.sync_heads(owner_id) values (v_owner) on conflict (owner_id) do nothing;
  insert into private.devices(owner_id, id, platform, supported_protocol)
  values (v_owner, p_device_id, p_platform, p_supported_protocol)
  on conflict (owner_id, id) do update set
    platform = excluded.platform,
    supported_protocol = excluded.supported_protocol,
    last_seen_at = statement_timestamp()
  where private.devices.revoked_at is null;
  if not found then raise exception using errcode = '42501', message = 'device is revoked'; end if;
  return jsonb_build_object('deviceId', p_device_id, 'protocol', p_supported_protocol, 'registered', true);
end
$fn$;

create function public.apply_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_owner uuid := auth.uid();
  v_op uuid; v_device uuid; v_entity uuid; v_kind text; v_entity_type text;
  v_protocol integer; v_base bigint; v_payload jsonb; v_hash bytea;
  v_sequence bigint; v_epoch uuid; v_stored_hash bytea; v_result jsonb;
  v_current jsonb; v_change jsonb; v_fields jsonb; v_group text; v_groups text[];
  v_task public.tasks%rowtype; v_block public.time_blocks%rowtype; v_session public.focus_sessions%rowtype;
  v_related_block public.time_blocks%rowtype; v_related_session public.focus_sessions%rowtype;
  v_revision bigint; v_conflicting jsonb; v_count integer;
  v_task_id uuid; v_block_id uuid; v_starts timestamptz; v_ends timestamptz;
  v_zone text; v_color text; v_block_status public.block_status;
  v_new_state public.focus_state; v_event_kind public.focus_event_kind;
  v_logical_key text; v_occurred timestamptz; v_new_phase public.focus_phase;
  v_ended timestamptz; v_outcome public.focus_outcome;
begin
  if v_owner is null then raise exception using errcode = '28000', message = 'authentication required'; end if;
  if jsonb_typeof(p_command) <> 'object' or octet_length(p_command::text) > 65536 then
    raise exception using errcode = '22023', message = 'command must be a JSON object no larger than 64 KiB';
  end if;
  perform private.assert_allowed_keys(
    p_command, array['protocol','opId','deviceId','kind','entityId','baseRevision','payload'], 'command'
  );
  if not (p_command ?& array['protocol','opId','deviceId','kind','entityId','baseRevision','payload']) then
    raise exception using errcode = '22023', message = 'command is missing a required key';
  end if;
  begin
    v_protocol := (p_command->>'protocol')::integer;
    v_op := (p_command->>'opId')::uuid;
    v_device := (p_command->>'deviceId')::uuid;
    v_entity := (p_command->>'entityId')::uuid;
    v_base := (p_command->>'baseRevision')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid command scalar value';
  end;
  v_kind := p_command->>'kind';
  v_payload := p_command->'payload';
  if v_protocol <> 1 then raise exception using errcode = '0A000', message = 'unsupported sync protocol'; end if;
  if v_base < 0 then raise exception using errcode = '22023', message = 'baseRevision must be non-negative'; end if;
  if jsonb_typeof(v_payload) <> 'object' then raise exception using errcode = '22023', message = 'payload must be an object'; end if;
  if v_kind like 'task.%' then v_entity_type := 'task';
  elsif v_kind like 'block.%' then v_entity_type := 'block';
  elsif v_kind like 'session.%' then v_entity_type := 'session';
  else raise exception using errcode = '22023', message = 'unsupported command kind'; end if;

  if not exists (
    select 1 from private.devices d where d.owner_id = v_owner and d.id = v_device
      and d.revoked_at is null and d.supported_protocol >= v_protocol
  ) then raise exception using errcode = '42501', message = 'device is not registered, is revoked, or lacks protocol support'; end if;

  insert into private.sync_heads(owner_id) values (v_owner) on conflict (owner_id) do nothing;
  select h.current_sequence, h.epoch into v_sequence, v_epoch
  from private.sync_heads h where h.owner_id = v_owner for update;

  v_hash := extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256');
  select r.request_hash, r.result into v_stored_hash, v_result
  from private.operation_receipts r where r.owner_id = v_owner and r.op_id = v_op;
  if found then
    if v_stored_hash <> v_hash then
      raise exception using errcode = '22023', message = 'opId was already used with a different command';
    end if;
    update private.devices set last_seen_at = statement_timestamp()
      where owner_id = v_owner and id = v_device;
    return v_result;
  end if;

  if v_kind = 'task.create' then
    perform private.assert_allowed_keys(v_payload,
      array['text','done','priority','list','quadrant','details','estimateMinutes','nextAction'], 'task payload');
    if v_base <> 0 or not (v_payload ? 'text') then
      raise exception using errcode = '22023', message = 'task.create requires baseRevision 0 and text';
    end if;
    if exists (select 1 from public.tasks where owner_id = v_owner and id = v_entity) then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'task',v_entity,v_base,null,
        'entity_exists',v_payload,private.task_document(v_owner,v_entity),v_sequence);
    end if;
    insert into public.tasks(
      owner_id,id,text,done,priority,list_key,quadrant,details,estimate_minutes,next_action,
      revision,field_revisions
    ) values (
      v_owner,v_entity,v_payload->>'text',coalesce((v_payload->>'done')::boolean,false),
      coalesce((v_payload->>'priority')::public.task_priority,'medium'),
      coalesce((v_payload->>'list')::public.task_list,'personal'),
      (v_payload->>'quadrant')::public.task_quadrant,coalesce(v_payload->>'details',''),
      (v_payload->>'estimateMinutes')::integer,coalesce(v_payload->>'nextAction',''),1,
      '{"text":1,"done":1,"classification":1,"details":1,"estimate":1,"nextAction":1}'::jsonb
    );
    v_revision := 1; v_change := private.task_document(v_owner,v_entity); v_sequence := v_sequence + 1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'task',v_entity,v_revision,'upsert',v_change,statement_timestamp());

  elsif v_kind = 'task.update' then
    perform private.assert_allowed_keys(v_payload,
      array['text','done','priority','list','quadrant','details','estimateMinutes','nextAction'], 'task payload');
    if v_payload = '{}'::jsonb then raise exception using errcode = '22023', message = 'task.update payload is empty'; end if;
    select * into v_task from public.tasks where owner_id = v_owner and id = v_entity for update;
    if not found then raise exception using errcode = 'P0002', message = 'task not found'; end if;
    v_current := private.task_document(v_owner,v_entity);
    if v_task.deleted_at is not null then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'task',v_entity,v_base,v_task.revision,
        'entity_deleted',v_payload,v_current,v_sequence);
    end if;
    v_groups := array[]::text[];
    if v_payload ? 'text' then v_groups := array_append(v_groups,'text'); end if;
    if v_payload ? 'done' then v_groups := array_append(v_groups,'done'); end if;
    if v_payload ?| array['priority','list','quadrant'] then v_groups := array_append(v_groups,'classification'); end if;
    if v_payload ? 'details' then v_groups := array_append(v_groups,'details'); end if;
    if v_payload ? 'estimateMinutes' then v_groups := array_append(v_groups,'estimate'); end if;
    if v_payload ? 'nextAction' then v_groups := array_append(v_groups,'nextAction'); end if;
    foreach v_group in array v_groups loop
      if coalesce((v_task.field_revisions->>v_group)::bigint,0) > v_base then
        return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'task',v_entity,v_base,v_task.revision,
          'stale_' || v_group,v_payload,v_current,v_sequence);
      end if;
    end loop;
    v_revision := v_task.revision + 1; v_fields := v_task.field_revisions;
    foreach v_group in array v_groups loop
      v_fields := jsonb_set(v_fields,array[v_group],to_jsonb(v_revision),true);
    end loop;
    update public.tasks set
      text = case when v_payload ? 'text' then v_payload->>'text' else text end,
      done = case when v_payload ? 'done' then (v_payload->>'done')::boolean else done end,
      priority = case when v_payload ? 'priority' then (v_payload->>'priority')::public.task_priority else priority end,
      list_key = case when v_payload ? 'list' then (v_payload->>'list')::public.task_list else list_key end,
      quadrant = case when v_payload ? 'quadrant' then (v_payload->>'quadrant')::public.task_quadrant else quadrant end,
      details = case when v_payload ? 'details' then v_payload->>'details' else details end,
      estimate_minutes = case when v_payload ? 'estimateMinutes' then (v_payload->>'estimateMinutes')::integer else estimate_minutes end,
      next_action = case when v_payload ? 'nextAction' then v_payload->>'nextAction' else next_action end,
      revision = v_revision, field_revisions = v_fields, updated_at = statement_timestamp()
    where owner_id = v_owner and id = v_entity;
    v_change := private.task_document(v_owner,v_entity); v_sequence := v_sequence + 1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'task',v_entity,v_revision,'upsert',v_change,statement_timestamp());

  elsif v_kind = 'task.delete' then
    perform private.assert_allowed_keys(v_payload,array[]::text[],'task.delete payload');
    select * into v_task from public.tasks where owner_id = v_owner and id = v_entity for update;
    if not found then raise exception using errcode = 'P0002', message = 'task not found'; end if;
    v_current := private.task_document(v_owner,v_entity);
    if v_task.deleted_at is not null or v_task.revision <> v_base then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'task',v_entity,v_base,v_task.revision,
        case when v_task.deleted_at is not null then 'entity_deleted' else 'stale_delete' end,v_payload,v_current,v_sequence);
    end if;
    select count(*) into v_count from public.time_blocks
      where owner_id=v_owner and task_id=v_entity and deleted_at is null and ends_at > statement_timestamp();
    if v_count > 100 then raise exception using errcode = '54000', message = 'task has too many future blocks for one bounded command'; end if;
    for v_related_block in
      update public.time_blocks set status='cancelled', deleted_at=statement_timestamp(),
        revision=revision+1,
        field_revisions=jsonb_set(field_revisions,'{status}',to_jsonb(revision+1),true),
        updated_at=statement_timestamp()
      where owner_id=v_owner and task_id=v_entity and deleted_at is null and ends_at > statement_timestamp()
      returning *
    loop
      v_sequence := v_sequence + 1; v_change := private.block_document(v_owner,v_related_block.id);
      insert into private.change_log values(v_owner,v_sequence,v_op,'block',v_related_block.id,
        v_related_block.revision,'delete',v_change,statement_timestamp());
    end loop;
    for v_related_session in
      update public.focus_sessions set task_id=null, revision=revision+1, updated_at=statement_timestamp()
      where owner_id=v_owner and task_id=v_entity and state in ('running','paused') returning *
    loop
      v_sequence := v_sequence + 1; v_change := private.session_document(v_owner,v_related_session.id);
      insert into private.change_log values(v_owner,v_sequence,v_op,'session',v_related_session.id,
        v_related_session.revision,'upsert',v_change,statement_timestamp());
    end loop;
    v_revision := v_task.revision + 1;
    update public.tasks set deleted_at=statement_timestamp(), revision=v_revision,
      field_revisions=jsonb_set(field_revisions,'{deleted}',to_jsonb(v_revision),true),
      updated_at=statement_timestamp() where owner_id=v_owner and id=v_entity;
    v_change := private.task_document(v_owner,v_entity); v_sequence := v_sequence + 1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'task',v_entity,v_revision,'delete',v_change,statement_timestamp());

  elsif v_kind = 'block.create' then
    perform private.assert_allowed_keys(v_payload,array['taskId','startsAt','endsAt','timeZone','colorKey','status'],'block payload');
    if v_base <> 0 or not (v_payload ?& array['taskId','startsAt','endsAt','timeZone']) then
      raise exception using errcode = '22023', message = 'block.create requires baseRevision 0 and placement fields';
    end if;
    if exists(select 1 from public.time_blocks where owner_id=v_owner and id=v_entity) then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,null,
        'entity_exists',v_payload,private.block_document(v_owner,v_entity),v_sequence);
    end if;
    v_task_id := (v_payload->>'taskId')::uuid; v_starts := (v_payload->>'startsAt')::timestamptz;
    v_ends := (v_payload->>'endsAt')::timestamptz; v_zone := v_payload->>'timeZone';
    v_color := coalesce(v_payload->>'colorKey','lake');
    v_block_status := coalesce((v_payload->>'status')::public.block_status,'confirmed');
    if not exists(select 1 from public.tasks where owner_id=v_owner and id=v_task_id and deleted_at is null) then
      raise exception using errcode = '23503', message = 'linked task is missing, deleted, or owned by another account';
    end if;
    select private.block_document(v_owner,b.id) into v_conflicting from public.time_blocks b
      where b.owner_id=v_owner and b.deleted_at is null and b.status='confirmed'
        and v_block_status='confirmed' and b.starts_at < v_ends and v_starts < b.ends_at limit 1;
    if v_conflicting is not null then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,null,
        'schedule_overlap',v_payload,v_conflicting,v_sequence);
    end if;
    insert into public.time_blocks(owner_id,id,task_id,starts_at,ends_at,time_zone,color_key,status,revision,field_revisions)
    values(v_owner,v_entity,v_task_id,v_starts,v_ends,v_zone,v_color,v_block_status,1,
      '{"placement":1,"appearance":1,"status":1}'::jsonb);
    v_revision := 1; v_change := private.block_document(v_owner,v_entity); v_sequence := v_sequence + 1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'block',v_entity,v_revision,'upsert',v_change,statement_timestamp());

  elsif v_kind = 'block.update' then
    perform private.assert_allowed_keys(v_payload,array['taskId','startsAt','endsAt','timeZone','colorKey','status'],'block payload');
    if v_payload='{}'::jsonb then raise exception using errcode='22023', message='block.update payload is empty'; end if;
    select * into v_block from public.time_blocks where owner_id=v_owner and id=v_entity for update;
    if not found then raise exception using errcode='P0002', message='block not found'; end if;
    v_current := private.block_document(v_owner,v_entity);
    if v_block.deleted_at is not null then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,v_block.revision,
        'entity_deleted',v_payload,v_current,v_sequence);
    end if;
    v_groups := array[]::text[];
    if v_payload ?| array['taskId','startsAt','endsAt','timeZone'] then v_groups:=array_append(v_groups,'placement'); end if;
    if v_payload ? 'colorKey' then v_groups:=array_append(v_groups,'appearance'); end if;
    if v_payload ? 'status' then v_groups:=array_append(v_groups,'status'); end if;
    foreach v_group in array v_groups loop
      if coalesce((v_block.field_revisions->>v_group)::bigint,0)>v_base then
        return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,v_block.revision,
          'stale_'||v_group,v_payload,v_current,v_sequence);
      end if;
    end loop;
    v_task_id:=case when v_payload?'taskId' then (v_payload->>'taskId')::uuid else v_block.task_id end;
    v_starts:=case when v_payload?'startsAt' then (v_payload->>'startsAt')::timestamptz else v_block.starts_at end;
    v_ends:=case when v_payload?'endsAt' then (v_payload->>'endsAt')::timestamptz else v_block.ends_at end;
    v_zone:=case when v_payload?'timeZone' then v_payload->>'timeZone' else v_block.time_zone end;
    v_color:=case when v_payload?'colorKey' then v_payload->>'colorKey' else v_block.color_key end;
    v_block_status:=case when v_payload?'status' then (v_payload->>'status')::public.block_status else v_block.status end;
    if not exists(select 1 from public.tasks where owner_id=v_owner and id=v_task_id and deleted_at is null) then
      raise exception using errcode='23503', message='linked task is missing, deleted, or owned by another account';
    end if;
    select private.block_document(v_owner,b.id) into v_conflicting from public.time_blocks b
      where b.owner_id=v_owner and b.id<>v_entity and b.deleted_at is null and b.status='confirmed'
        and v_block_status='confirmed' and b.starts_at<v_ends and v_starts<b.ends_at limit 1;
    if v_conflicting is not null then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,v_block.revision,
        'schedule_overlap',v_payload,jsonb_build_object('entity',v_current,'overlap',v_conflicting),v_sequence);
    end if;
    v_revision:=v_block.revision+1; v_fields:=v_block.field_revisions;
    foreach v_group in array v_groups loop v_fields:=jsonb_set(v_fields,array[v_group],to_jsonb(v_revision),true); end loop;
    update public.time_blocks set task_id=v_task_id,starts_at=v_starts,ends_at=v_ends,time_zone=v_zone,
      color_key=v_color,status=v_block_status,revision=v_revision,field_revisions=v_fields,
      updated_at=statement_timestamp() where owner_id=v_owner and id=v_entity;
    v_change:=private.block_document(v_owner,v_entity); v_sequence:=v_sequence+1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'block',v_entity,v_revision,'upsert',v_change,statement_timestamp());

  elsif v_kind = 'block.delete' then
    perform private.assert_allowed_keys(v_payload,array[]::text[],'block.delete payload');
    select * into v_block from public.time_blocks where owner_id=v_owner and id=v_entity for update;
    if not found then raise exception using errcode='P0002', message='block not found'; end if;
    v_current:=private.block_document(v_owner,v_entity);
    if v_block.deleted_at is not null or v_block.revision<>v_base then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'block',v_entity,v_base,v_block.revision,
        case when v_block.deleted_at is not null then 'entity_deleted' else 'stale_delete' end,v_payload,v_current,v_sequence);
    end if;
    v_revision:=v_block.revision+1;
    update public.time_blocks set status='cancelled',deleted_at=statement_timestamp(),revision=v_revision,
      field_revisions=jsonb_set(field_revisions,'{deleted}',to_jsonb(v_revision),true),updated_at=statement_timestamp()
      where owner_id=v_owner and id=v_entity;
    v_change:=private.block_document(v_owner,v_entity); v_sequence:=v_sequence+1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'block',v_entity,v_revision,'delete',v_change,statement_timestamp());

  elsif v_kind = 'session.record' then
    perform private.assert_allowed_keys(v_payload,
      array['taskId','mode','startedAt','endedAt','focusMs','interruptions','outcome'],
      'session record payload');
    if v_base<>0 or not (v_payload?&array['mode','startedAt','endedAt','focusMs','interruptions','outcome']) then
      raise exception using errcode='22023',
        message='session.record requires baseRevision 0, mode, startedAt, endedAt, focusMs, interruptions, and outcome';
    end if;
    if exists(select 1 from public.focus_sessions where owner_id=v_owner and id=v_entity) then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,null,
        'entity_exists',v_payload,private.session_document(v_owner,v_entity),v_sequence);
    end if;
    v_task_id:=(v_payload->>'taskId')::uuid;
    if v_task_id is not null and not exists(
      select 1 from public.tasks where owner_id=v_owner and id=v_task_id
    ) then
      raise exception using errcode='23503', message='linked task is missing or owned by another account';
    end if;
    v_starts:=(v_payload->>'startedAt')::timestamptz;
    v_ended:=(v_payload->>'endedAt')::timestamptz;
    v_outcome:=(v_payload->>'outcome')::public.focus_outcome;
    if v_ended<=v_starts then
      raise exception using errcode='23514', message='session endedAt must be later than startedAt';
    end if;
    if (v_payload->>'focusMs')::bigint > extract(epoch from (v_ended-v_starts))*1000 then
      raise exception using errcode='23514', message='session focusMs exceeds its elapsed wall time';
    end if;
    if v_outcome not in ('completed','partial') then
      raise exception using errcode='23514', message='session.record outcome must be completed or partial';
    end if;
    insert into public.focus_sessions(
      owner_id,id,task_id,mode,state,owner_device_id,phase,phase_started_at,
      focus_ms,interruptions,outcome,ended_at,config_snapshot
    ) values(
      v_owner,v_entity,v_task_id,(v_payload->>'mode')::public.focus_mode,'ended',v_device,'focus',v_starts,
      (v_payload->>'focusMs')::bigint,(v_payload->>'interruptions')::integer,v_outcome,v_ended,
      jsonb_build_object('source','session.record','protocol',1)
    );
    insert into public.focus_events(owner_id,id,session_id,device_id,kind,logical_key,occurred_at,payload)
    values(v_owner,extensions.gen_random_uuid(),v_entity,v_device,'start','session:start',v_starts,
      jsonb_build_object('source','session.record'));
    insert into public.focus_events(
      owner_id,id,session_id,device_id,kind,logical_key,occurred_at,elapsed_ms,payload
    ) values(
      v_owner,v_op,v_entity,v_device,'end','session:end',v_ended,(v_payload->>'focusMs')::bigint,
      jsonb_build_object('source','session.record','outcome',v_outcome)
    );
    v_revision:=1; v_change:=private.session_document(v_owner,v_entity); v_sequence:=v_sequence+1;
    insert into private.change_log values(
      v_owner,v_sequence,v_op,'session',v_entity,v_revision,'upsert',v_change,statement_timestamp()
    );

  elsif v_kind = 'session.create' then
    perform private.assert_allowed_keys(v_payload,
      array['taskId','blockId','mode','phase','phaseIndex','phaseStartedAt','phaseDeadlineAt',
        'pausedRemainingMs','configSnapshot'],'session payload');
    if v_base<>0 or not (v_payload?&array['mode','phaseStartedAt','configSnapshot']) then
      raise exception using errcode='22023', message='session.create requires baseRevision 0, mode, phaseStartedAt, and configSnapshot';
    end if;
    if exists(select 1 from public.focus_sessions where owner_id=v_owner and id=v_entity) then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,null,
        'entity_exists',v_payload,private.session_document(v_owner,v_entity),v_sequence);
    end if;
    v_task_id:=(v_payload->>'taskId')::uuid; v_block_id:=(v_payload->>'blockId')::uuid;
    if v_task_id is not null and not exists(select 1 from public.tasks where owner_id=v_owner and id=v_task_id and deleted_at is null) then
      raise exception using errcode='23503', message='linked task is missing, deleted, or owned by another account';
    end if;
    if v_block_id is not null and not exists(select 1 from public.time_blocks where owner_id=v_owner and id=v_block_id and deleted_at is null) then
      raise exception using errcode='23503', message='linked block is missing, deleted, or owned by another account';
    end if;
    if v_task_id is not null and v_block_id is not null and not exists(
      select 1 from public.time_blocks where owner_id=v_owner and id=v_block_id and task_id=v_task_id
    ) then raise exception using errcode='23514', message='session task and block do not match'; end if;
    if exists(select 1 from public.focus_sessions where owner_id=v_owner and state in ('running','paused')) then
      select private.session_document(v_owner,s.id) into v_conflicting from public.focus_sessions s
        where s.owner_id=v_owner and s.state in ('running','paused') limit 1;
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,null,
        'active_session_exists',v_payload,v_conflicting,v_sequence);
    end if;
    insert into public.focus_sessions(
      owner_id,id,task_id,block_id,mode,state,owner_device_id,phase,phase_index,phase_started_at,
      phase_deadline_at,paused_remaining_ms,config_snapshot
    ) values(
      v_owner,v_entity,v_task_id,v_block_id,(v_payload->>'mode')::public.focus_mode,
      'running',v_device,
      coalesce((v_payload->>'phase')::public.focus_phase,'focus'),coalesce((v_payload->>'phaseIndex')::integer,0),
      (v_payload->>'phaseStartedAt')::timestamptz,(v_payload->>'phaseDeadlineAt')::timestamptz,
      (v_payload->>'pausedRemainingMs')::bigint,v_payload->'configSnapshot'
    );
    insert into public.focus_events(owner_id,id,session_id,device_id,kind,logical_key,occurred_at,payload)
    values(v_owner,v_op,v_entity,v_device,'start','session:start',(v_payload->>'phaseStartedAt')::timestamptz,v_payload);
    v_revision:=1; v_change:=private.session_document(v_owner,v_entity); v_sequence:=v_sequence+1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'session',v_entity,v_revision,'upsert',v_change,statement_timestamp());

  elsif v_kind = 'session.transition' then
    perform private.assert_allowed_keys(v_payload,
      array['eventKind','logicalKey','occurredAt','state','phase','phaseIndex','phaseStartedAt','phaseDeadlineAt',
        'pausedRemainingMs','focusMs','breakMs','completedFocusCycles','outcome','endedAt','elapsedMs','eventPayload'],
      'session transition payload');
    if not (v_payload?&array['eventKind','logicalKey','occurredAt']) then
      raise exception using errcode='22023', message='session.transition requires eventKind, logicalKey, and occurredAt';
    end if;
    select * into v_session from public.focus_sessions where owner_id=v_owner and id=v_entity for update;
    if not found then raise exception using errcode='P0002', message='session not found'; end if;
    v_current:=private.session_document(v_owner,v_entity);
    if v_session.revision<>v_base then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,v_session.revision,
        'stale_session',v_payload,v_current,v_sequence);
    end if;
    v_event_kind:=(v_payload->>'eventKind')::public.focus_event_kind;
    if v_event_kind='start' then raise exception using errcode='22023', message='start is emitted by session.create'; end if;
    v_logical_key:=v_payload->>'logicalKey'; v_occurred:=(v_payload->>'occurredAt')::timestamptz;
    if exists(select 1 from public.focus_events where owner_id=v_owner and session_id=v_entity and logical_key=v_logical_key) then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,v_session.revision,
        'semantic_event_exists',v_payload,v_current,v_sequence);
    end if;
    v_new_state:=coalesce((v_payload->>'state')::public.focus_state,v_session.state);
    if v_event_kind='pause' and not (v_session.state='running' and v_new_state='paused') then
      raise exception using errcode='23514', message='invalid pause transition';
    elsif v_event_kind='resume' and not (v_session.state='paused' and v_new_state='running') then
      raise exception using errcode='23514', message='invalid resume transition';
    elsif v_event_kind='end' and not (v_session.state in ('running','paused') and v_new_state='ended') then
      raise exception using errcode='23514', message='invalid end transition';
    elsif v_event_kind='correct' and not (v_session.state='ended' and v_new_state='ended') then
      raise exception using errcode='23514', message='only an ended session may be corrected';
    elsif v_event_kind in ('interrupt','takeover') and v_new_state<>v_session.state then
      raise exception using errcode='23514', message='interrupt/takeover cannot change session state';
    elsif v_event_kind='phase_end' and v_session.state<>'running' then
      raise exception using errcode='23514', message='phase_end requires a running session';
    end if;
    if v_session.owner_device_id<>v_device and v_event_kind<>'takeover' then
      return private.save_conflict(v_owner,v_op,v_device,v_hash,p_command,'session',v_entity,v_base,v_session.revision,
        'takeover_required',v_payload,v_current,v_sequence);
    end if;
    v_new_phase:=coalesce((v_payload->>'phase')::public.focus_phase,v_session.phase);
    v_ended:=case when v_new_state='ended' then (v_payload->>'endedAt')::timestamptz else null end;
    v_outcome:=case when v_new_state='ended' then (v_payload->>'outcome')::public.focus_outcome else null end;
    if v_new_state='ended' and (v_ended is null or v_outcome is null) then
      raise exception using errcode='22023', message='ended session requires endedAt and outcome';
    end if;
    v_revision:=v_session.revision+1;
    update public.focus_sessions set
      state=v_new_state, owner_device_id=case when v_event_kind='takeover' then v_device else owner_device_id end,
      phase=v_new_phase, phase_index=case when v_payload?'phaseIndex' then (v_payload->>'phaseIndex')::integer else phase_index end,
      phase_started_at=case when v_payload?'phaseStartedAt' then (v_payload->>'phaseStartedAt')::timestamptz else phase_started_at end,
      phase_deadline_at=case when v_payload?'phaseDeadlineAt' then (v_payload->>'phaseDeadlineAt')::timestamptz else phase_deadline_at end,
      paused_remaining_ms=case when v_payload?'pausedRemainingMs' then (v_payload->>'pausedRemainingMs')::bigint else paused_remaining_ms end,
      focus_ms=case when v_payload?'focusMs' then (v_payload->>'focusMs')::bigint else focus_ms end,
      break_ms=case when v_payload?'breakMs' then (v_payload->>'breakMs')::bigint else break_ms end,
      interruptions=interruptions+case when v_event_kind='interrupt' then 1 else 0 end,
      completed_focus_cycles=case when v_payload?'completedFocusCycles' then (v_payload->>'completedFocusCycles')::integer else completed_focus_cycles end,
      outcome=v_outcome, ended_at=v_ended, revision=v_revision, updated_at=statement_timestamp()
      where owner_id=v_owner and id=v_entity;
    insert into public.focus_events(owner_id,id,session_id,device_id,kind,logical_key,occurred_at,elapsed_ms,payload)
    values(v_owner,v_op,v_entity,v_device,v_event_kind,v_logical_key,v_occurred,
      (v_payload->>'elapsedMs')::bigint,coalesce(v_payload->'eventPayload','{}'::jsonb));
    v_change:=private.session_document(v_owner,v_entity); v_sequence:=v_sequence+1;
    insert into private.change_log values(v_owner,v_sequence,v_op,'session',v_entity,v_revision,'upsert',v_change,statement_timestamp());
  else
    raise exception using errcode='22023', message='unsupported command kind';
  end if;

  update private.sync_heads set current_sequence=v_sequence,updated_at=statement_timestamp() where owner_id=v_owner;
  update private.devices set last_seen_at=statement_timestamp() where owner_id=v_owner and id=v_device;
  return private.save_applied(v_owner,v_op,v_device,v_hash,p_command,v_entity_type,v_entity,v_revision,v_sequence,v_change);
end
$fn$;

create function public.pull_changes(p_cursor bigint default 0, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_owner uuid:=auth.uid(); v_high bigint; v_min bigint; v_epoch uuid; v_changes jsonb; v_cursor bigint;
begin
  if v_owner is null then raise exception using errcode='28000', message='authentication required'; end if;
  if p_cursor<0 or p_limit<1 or p_limit>500 then raise exception using errcode='22023', message='cursor/limit out of range'; end if;
  insert into private.sync_heads(owner_id) values(v_owner) on conflict(owner_id) do nothing;
  select current_sequence,minimum_retained_sequence,epoch into v_high,v_min,v_epoch
    from private.sync_heads where owner_id=v_owner for share;
  if p_cursor<v_min then raise exception using errcode='P0001', message='stale_cursor'; end if;
  with pending as (
    select c.*, min(sequence) over(partition by group_id) as group_start,
      count(*) over(partition by group_id) as group_size
    from private.change_log c where c.owner_id=v_owner and c.sequence>p_cursor and c.sequence<=v_high
  ), groups as (
    select group_id,group_start,group_size,
      sum(group_size) over(order by group_start) as running_size,
      row_number() over(order by group_start) as group_number
    from pending group by group_id,group_start,group_size
  ), selected as (
    select p.* from pending p join groups g using(group_id)
    where g.running_size<=p_limit or g.group_number=1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sequence',sequence,'groupId',group_id,'entityType',entity_type,'entityId',entity_id,
      'revision',entity_revision,'operation',operation,'row',row_data,'committedAt',committed_at
    ) order by sequence),'[]'::jsonb), coalesce(max(sequence),p_cursor)
  into v_changes,v_cursor from selected;
  return jsonb_build_object('protocol',1,'epoch',v_epoch,'cursor',v_cursor,'highWatermark',v_high,
    'hasMore',v_cursor<v_high,'changes',v_changes);
end
$fn$;

create function public.bootstrap_snapshot(p_limit integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_owner uuid:=auth.uid(); v_high bigint; v_min bigint; v_epoch uuid; v_count bigint;
  v_tasks jsonb; v_blocks jsonb; v_sessions jsonb; v_events jsonb;
begin
  if v_owner is null then raise exception using errcode='28000', message='authentication required'; end if;
  if p_limit<1 or p_limit>5000 then raise exception using errcode='22023', message='snapshot limit out of range'; end if;
  insert into private.sync_heads(owner_id) values(v_owner) on conflict(owner_id) do nothing;
  select current_sequence,minimum_retained_sequence,epoch into v_high,v_min,v_epoch
    from private.sync_heads where owner_id=v_owner for share;
  select
    (select count(*) from public.tasks where owner_id=v_owner and deleted_at is null)+
    (select count(*) from public.time_blocks where owner_id=v_owner and deleted_at is null)+
    (select count(*) from public.focus_sessions where owner_id=v_owner)+
    (select count(*) from public.focus_events where owner_id=v_owner)
  into v_count;
  if v_count>p_limit then
    return jsonb_build_object('protocol',1,'outcome','too_large','requiredCount',v_count,
      'limit',p_limit,'epoch',v_epoch,'cursor',v_high,'minimumCursor',v_min);
  end if;
  select coalesce(jsonb_agg(private.task_document(v_owner,id) order by created_at,id),'[]'::jsonb)
    into v_tasks from public.tasks where owner_id=v_owner and deleted_at is null;
  select coalesce(jsonb_agg(private.block_document(v_owner,id) order by starts_at,id),'[]'::jsonb)
    into v_blocks from public.time_blocks where owner_id=v_owner and deleted_at is null;
  select coalesce(jsonb_agg(private.session_document(v_owner,id) order by created_at,id),'[]'::jsonb)
    into v_sessions from public.focus_sessions where owner_id=v_owner;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'sessionId',session_id,'deviceId',device_id,'kind',kind,'logicalKey',logical_key,
      'occurredAt',occurred_at,'receivedAt',received_at,'elapsedMs',elapsed_ms,'payload',payload
    ) order by occurred_at,id),'[]'::jsonb)
    into v_events from public.focus_events where owner_id=v_owner;
  return jsonb_build_object('protocol',1,'outcome','ok','epoch',v_epoch,'cursor',v_high,
    'minimumCursor',v_min,'tasks',v_tasks,'blocks',v_blocks,'sessions',v_sessions,'events',v_events);
end
$fn$;

alter table public.tasks enable row level security;
alter table public.time_blocks enable row level security;
alter table public.focus_sessions enable row level security;
alter table public.focus_events enable row level security;

create policy tasks_read_own on public.tasks for select to authenticated using (owner_id=(select auth.uid()));
create policy blocks_read_own on public.time_blocks for select to authenticated using (owner_id=(select auth.uid()));
create policy sessions_read_own on public.focus_sessions for select to authenticated using (owner_id=(select auth.uid()));
create policy events_read_own on public.focus_events for select to authenticated using (owner_id=(select auth.uid()));

revoke all on public.tasks,public.time_blocks,public.focus_sessions,public.focus_events from public,anon,authenticated;
grant select on public.tasks,public.time_blocks,public.focus_sessions,public.focus_events to authenticated;
revoke all on function public.register_device(uuid,text,integer) from public,anon;
revoke all on function public.apply_command(jsonb) from public,anon;
revoke all on function public.pull_changes(bigint,integer) from public,anon;
revoke all on function public.bootstrap_snapshot(integer) from public,anon;
grant execute on function public.register_device(uuid,text,integer) to authenticated;
grant execute on function public.apply_command(jsonb) to authenticated;
grant execute on function public.pull_changes(bigint,integer) to authenticated;
grant execute on function public.bootstrap_snapshot(integer) to authenticated;
