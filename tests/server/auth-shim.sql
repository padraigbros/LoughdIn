\set ON_ERROR_STOP on

-- Minimal stand-in for the Supabase auth schema so the migrations can be applied
-- to a disposable Postgres. Run only against an empty test database.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end
$roles$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);

create or replace function auth.uid()
returns uuid language sql stable set search_path = '' as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to public;

