-- Bounded retention for operational sync data.
--
-- `private.change_log`, `private.operation_receipts` and `private.conflicts`
-- grow without limit for the life of an account. This migration adds a pruning
-- routine so a scheduled job can bound them, and advances
-- `private.sync_heads.minimum_retained_sequence` so any client left behind the
-- window is told to bootstrap through the existing `stale_cursor` path rather
-- than silently missing changes.
--
-- Nothing here grants new privileges to `anon` or `authenticated`. Pruning is
-- for the service role only.

-- The immutability triggers exist to stop application code from rewriting
-- history. Retention is the one exception, and it announces itself with a
-- transaction-local setting that no application path sets.
create or replace function private.reject_immutable_change()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'DELETE' and current_setting('loughdin.retention', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = tg_table_name || ' rows are immutable';
end
$fn$;

create function private.prune_sync_history(
  p_owner uuid,
  p_keep_days integer default 30,
  p_keep_minimum integer default 500
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_head bigint; v_min bigint; v_cutoff bigint;
  v_changes integer := 0; v_receipts integer := 0; v_conflicts integer := 0;
  v_horizon timestamptz;
begin
  if p_keep_days < 0 or p_keep_minimum < 0 then
    raise exception using errcode = '22023', message = 'retention arguments must not be negative';
  end if;
  select current_sequence, minimum_retained_sequence into v_head, v_min
    from private.sync_heads where owner_id = p_owner for update;
  if not found then
    return jsonb_build_object('owner', p_owner, 'pruned', false, 'reason', 'unknown_owner');
  end if;

  v_horizon := statement_timestamp() - make_interval(days => p_keep_days);

  -- Never prune inside the newest p_keep_minimum entries, whatever their age,
  -- so a briefly idle device can still page forward instead of bootstrapping.
  select coalesce(max(sequence), v_min) into v_cutoff
  from (
    select sequence, committed_at, row_number() over (order by sequence desc) as recency
    from private.change_log where owner_id = p_owner
  ) ranked
  where recency > p_keep_minimum and committed_at < v_horizon;

  if v_cutoff <= v_min then
    return jsonb_build_object(
      'owner', p_owner, 'pruned', false, 'reason', 'nothing_older_than_window',
      'minimumRetainedSequence', v_min, 'currentSequence', v_head
    );
  end if;

  perform set_config('loughdin.retention', 'on', true);
  delete from private.change_log where owner_id = p_owner and sequence <= v_cutoff;
  get diagnostics v_changes = row_count;
  delete from private.operation_receipts where owner_id = p_owner and processed_at < v_horizon;
  get diagnostics v_receipts = row_count;
  perform set_config('loughdin.retention', 'off', true);

  delete from private.conflicts
    where owner_id = p_owner and status <> 'open' and created_at < v_horizon;
  get diagnostics v_conflicts = row_count;

  update private.sync_heads
    set minimum_retained_sequence = v_cutoff, updated_at = statement_timestamp()
    where owner_id = p_owner;

  return jsonb_build_object(
    'owner', p_owner, 'pruned', true, 'minimumRetainedSequence', v_cutoff,
    'currentSequence', v_head, 'changeLogRows', v_changes,
    'receiptRows', v_receipts, 'conflictRows', v_conflicts
  );
end
$fn$;

create function private.prune_all_sync_history(
  p_keep_days integer default 30,
  p_keep_minimum integer default 500
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_owner uuid; v_results jsonb := '[]'::jsonb; v_pruned integer := 0;
begin
  for v_owner in select owner_id from private.sync_heads order by owner_id loop
    v_results := v_results || jsonb_build_array(private.prune_sync_history(v_owner, p_keep_days, p_keep_minimum));
  end loop;
  select count(*) into v_pruned from jsonb_array_elements(v_results) entry
    where (entry->>'pruned')::boolean;
  return jsonb_build_object('accounts', jsonb_array_length(v_results), 'prunedAccounts', v_pruned, 'results', v_results);
end
$fn$;

revoke all on function private.prune_sync_history(uuid, integer, integer) from public, anon, authenticated;
revoke all on function private.prune_all_sync_history(integer, integer) from public, anon, authenticated;
