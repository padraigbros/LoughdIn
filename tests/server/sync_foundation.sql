\set ON_ERROR_STOP on
begin;
\ir bootstrap.sql

insert into auth.users(id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

create function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $fn$
begin
  if not coalesce(p_condition,false) then raise exception 'assertion failed: %',p_message; end if;
end
$fn$;

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select public.register_device('aaaaaaaa-0000-4000-8000-000000000001','test',1);

select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000001","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.create","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":0,"payload":{"text":"Write proposal","done":false,"priority":"high","list":"work","quadrant":null}}') ->> 'outcome' = 'applied',
  'task create applies'
);

-- Lost acknowledgement: the byte-for-byte semantic retry returns the saved result.
select pg_temp.assert_true(
  (public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000001","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.create","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":0,"payload":{"text":"Write proposal","done":false,"priority":"high","list":"work","quadrant":null}}')->>'sequence') = '1',
  'exact retry returns original receipt'
);
select pg_temp.assert_true(
  (select count(*)=1 from public.tasks where id='aaaaaaaa-1000-4000-8000-000000000001'),
  'retry did not duplicate entity'
);

-- Reusing an operation id with changed content is rejected, never reinterpreted.
do $test$
declare caught boolean:=false;
begin
  begin
    perform public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000001","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.create","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":0,"payload":{"text":"Changed request"}}');
  exception when sqlstate '22023' then caught:=true;
  end;
  perform pg_temp.assert_true(caught,'changed retry is rejected');
end
$test$;

-- Classification and title are separate revision groups. Both offline edits survive.
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000002","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.update","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":1,"payload":{"quadrant":"do"}}')->>'outcome'='applied',
  'classification update applies'
);
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000003","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.update","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":1,"payload":{"text":"Write revised proposal"}}')->>'outcome'='applied',
  'stale entity base still merges untouched title group'
);
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000004","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"task.update","entityId":"aaaaaaaa-1000-4000-8000-000000000001","baseRevision":1,"payload":{"text":"Competing title"}}')->>'outcome'='conflict',
  'same-group stale edit becomes a conflict'
);
select pg_temp.assert_true(
  (select text='Write revised proposal' and quadrant='do' from public.tasks where owner_id=auth.uid() and id='aaaaaaaa-1000-4000-8000-000000000001'),
  'conflict did not overwrite canonical task'
);

-- Calendar reservations are half-open: overlap conflicts, adjacency succeeds.
select public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000010","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"block.create","entityId":"aaaaaaaa-2000-4000-8000-000000000001","baseRevision":0,"payload":{"taskId":"aaaaaaaa-1000-4000-8000-000000000001","startsAt":"2026-09-09T09:00:00Z","endsAt":"2026-09-09T09:30:00Z","timeZone":"Europe/Dublin"}}');
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000011","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"block.create","entityId":"aaaaaaaa-2000-4000-8000-000000000002","baseRevision":0,"payload":{"taskId":"aaaaaaaa-1000-4000-8000-000000000001","startsAt":"2026-09-09T09:15:00Z","endsAt":"2026-09-09T09:45:00Z","timeZone":"Europe/Dublin"}}')->>'outcome'='conflict',
  'overlap becomes recoverable conflict'
);
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000012","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"block.create","entityId":"aaaaaaaa-2000-4000-8000-000000000003","baseRevision":0,"payload":{"taskId":"aaaaaaaa-1000-4000-8000-000000000001","startsAt":"2026-09-09T09:30:00Z","endsAt":"2026-09-09T10:00:00Z","timeZone":"Europe/Dublin"}}')->>'outcome'='applied',
  'adjacent half-open reservation applies'
);

-- A locally completed session is recorded atomically, without a transient active row.
select pg_temp.assert_true(
  public.apply_command('{"protocol":1,"opId":"10000000-0000-4000-8000-000000000020","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","kind":"session.record","entityId":"aaaaaaaa-3000-4000-8000-000000000001","baseRevision":0,"payload":{"taskId":"aaaaaaaa-1000-4000-8000-000000000001","mode":"pomodoro","startedAt":"2026-09-09T10:00:00Z","endedAt":"2026-09-09T10:25:00Z","focusMs":1500000,"interruptions":1,"outcome":"completed"}}')->>'outcome'='applied',
  'terminal session record applies'
);
select pg_temp.assert_true(
  (select state='ended' and focus_ms=1500000 and interruptions=1 and outcome='completed'
   from public.focus_sessions where owner_id=auth.uid() and id='aaaaaaaa-3000-4000-8000-000000000001'),
  'terminal session stores final aggregates'
);
select pg_temp.assert_true(
  (select count(*)=2 from public.focus_events
   where owner_id=auth.uid() and session_id='aaaaaaaa-3000-4000-8000-000000000001'),
  'terminal session writes start and end audit events atomically'
);

-- Snapshot and incremental cursors describe the same owner-consistent state.
select pg_temp.assert_true(
  (public.bootstrap_snapshot(100)->>'cursor')::bigint =
    (select current_sequence from private.sync_heads where owner_id=auth.uid()),
  'snapshot cursor equals the locked owner head'
);
select pg_temp.assert_true(
  (public.pull_changes(0,2)->>'cursor')::bigint = 2
    and (public.pull_changes(0,2)->>'highWatermark')::bigint =
      (select current_sequence from private.sync_heads where owner_id=auth.uid())
    and (public.pull_changes(0,2)->>'hasMore')::boolean,
  'bounded pull advances a stable cursor below its high watermark'
);

-- Account B cannot see A and cannot reference A's task.
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
select public.register_device('bbbbbbbb-0000-4000-8000-000000000001','test',1);
select pg_temp.assert_true((select count(*)=0 from public.tasks),'RLS hides account A tasks');
select pg_temp.assert_true(jsonb_array_length(public.bootstrap_snapshot(100)->'tasks')=0,'snapshot is owner-scoped');

do $test$
declare caught boolean:=false;
begin
  begin
    perform public.apply_command('{"protocol":1,"opId":"20000000-0000-4000-8000-000000000001","deviceId":"bbbbbbbb-0000-4000-8000-000000000001","kind":"block.create","entityId":"bbbbbbbb-2000-4000-8000-000000000001","baseRevision":0,"payload":{"taskId":"aaaaaaaa-1000-4000-8000-000000000001","startsAt":"2026-09-09T12:00:00Z","endsAt":"2026-09-09T12:30:00Z","timeZone":"Europe/Dublin"}}');
  exception when foreign_key_violation then caught:=true;
  end;
  perform pg_temp.assert_true(caught,'cross-owner task reference is rejected');
end
$test$;

-- Owner ids are derived from auth.uid; submitting one is an unexpected-key error.
do $test$
declare caught boolean:=false;
begin
  begin
    perform public.apply_command('{"protocol":1,"ownerId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","opId":"20000000-0000-4000-8000-000000000002","deviceId":"bbbbbbbb-0000-4000-8000-000000000001","kind":"task.create","entityId":"bbbbbbbb-1000-4000-8000-000000000001","baseRevision":0,"payload":{"text":"Forged"}}');
  exception when sqlstate '22023' then caught:=true;
  end;
  perform pg_temp.assert_true(caught,'forged owner field is rejected');
end
$test$;

-- Authenticated clients have reads through RLS, but no direct mutation/log access.
do $test$
declare caught_write boolean:=false; caught_log boolean:=false;
begin
  begin
    insert into public.tasks(owner_id,id,text) values(auth.uid(),'bbbbbbbb-1000-4000-8000-000000000009','Direct write');
  exception when insufficient_privilege then caught_write:=true;
  end;
  begin
    perform count(*) from private.change_log;
  exception when insufficient_privilege then caught_log:=true;
  end;
  perform pg_temp.assert_true(caught_write,'direct entity writes are revoked');
  perform pg_temp.assert_true(caught_log,'private change log is inaccessible');
end
$test$;

reset role;
select pg_temp.assert_true(
  not exists(select 1 from pg_publication_tables where schemaname in ('public','private') and tablename in ('tasks','time_blocks','focus_sessions','focus_events','change_log','operation_receipts')),
  'migration does not expose personal tables through realtime publication'
);

set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $test$
declare caught boolean:=false;
begin
  begin perform public.pull_changes(0,100);
  exception when insufficient_privilege then caught:=true;
  end;
  perform pg_temp.assert_true(caught,'anon cannot execute sync RPCs');
end
$test$;

reset role;
rollback;
