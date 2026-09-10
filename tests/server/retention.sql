\set ON_ERROR_STOP on
begin;
\ir bootstrap.sql
\ir ../../supabase/migrations/202609100001_sync_retention.sql

insert into auth.users(id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

create function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $fn$
begin
  if not coalesce(p_condition, false) then raise exception 'assertion failed: %', p_message; end if;
end
$fn$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select public.register_device('aaaaaaaa-0000-4000-8000-000000000001', 'test', 1);

select public.apply_command(jsonb_build_object(
  'protocol', 1, 'opId', '10000000-0000-4000-8000-00000000000' || generate_series,
  'deviceId', 'aaaaaaaa-0000-4000-8000-000000000001', 'kind', 'task.create',
  'entityId', 'aaaaaaaa-1000-4000-8000-00000000000' || generate_series, 'baseRevision', 0,
  'payload', jsonb_build_object('text', 'Task ' || generate_series, 'done', false,
    'priority', 'high', 'list', 'work', 'quadrant', null)
)) from generate_series(1, 6);

reset role;

select pg_temp.assert_true(
  (select count(*) from private.change_log where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 6,
  'six changes were recorded'
);

-- History is immutable outside retention.
do $immutable$
begin
  begin
    delete from private.change_log where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'assertion failed: change_log delete should be rejected';
  exception when sqlstate '55000' then null;
  end;
end
$immutable$;

-- Nothing is old enough yet, so a prune inside the window is a no-op.
select pg_temp.assert_true(
  (private.prune_sync_history('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 30, 2) ->> 'pruned')::boolean is false,
  'a prune inside the retention window changes nothing'
);
select pg_temp.assert_true(
  (select count(*) from private.change_log where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 6,
  'and no rows were removed'
);

-- Age the four oldest entries past the window. Only the harness may do this.
alter table private.change_log disable trigger change_log_immutable;
alter table private.operation_receipts disable trigger operation_receipts_immutable;
update private.change_log set committed_at = statement_timestamp() - interval '90 days'
  where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and sequence <= 4;
update private.operation_receipts set processed_at = statement_timestamp() - interval '90 days'
  where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
alter table private.change_log enable trigger change_log_immutable;
alter table private.operation_receipts enable trigger operation_receipts_immutable;

select pg_temp.assert_true(
  (private.prune_sync_history('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 30, 2) ->> 'minimumRetainedSequence')::bigint = 4,
  'pruning stops at the newest retained entries'
);
select pg_temp.assert_true(
  (select count(*) from private.change_log where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 2,
  'the newest two entries are kept'
);
select pg_temp.assert_true(
  (select minimum_retained_sequence from private.sync_heads where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 4,
  'the retention floor was advanced'
);
select pg_temp.assert_true(
  (select count(*) from private.operation_receipts where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0,
  'expired receipts were pruned'
);

-- A client behind the floor is told to bootstrap rather than missing changes.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
do $stale$
begin
  begin
    perform public.pull_changes(1, 100);
    raise exception 'assertion failed: a cursor below the floor should be stale';
  exception when sqlstate 'P0001' then null;
  end;
end
$stale$;
select pg_temp.assert_true(
  public.pull_changes(4, 100) ->> 'cursor' is not null,
  'a cursor at the floor still pages forward'
);
reset role;

-- The retention escape hatch does not leak outside the pruning transaction.
do $sealed$
begin
  begin
    delete from private.change_log where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'assertion failed: change_log is immutable again after pruning';
  exception when sqlstate '55000' then null;
  end;
end
$sealed$;

select pg_temp.assert_true(
  (private.prune_all_sync_history(30, 2) ->> 'accounts')::integer = 1,
  'the all-accounts wrapper visits every sync head'
);

rollback;
