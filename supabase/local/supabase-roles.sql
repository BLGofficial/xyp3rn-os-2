set client_min_messages = warning;
-- Emulates the roles + default privileges a real Supabase project ships with, so local
-- grant/RLS tests exercise the same risk surface. Idempotent; a no-op on real Supabase
-- (or `supabase start`), where these roles already exist.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's dangerous default: every new public table is fully granted to anon/authenticated.
-- Reproduced on purpose — migrations must revoke explicitly, and tests/phase-01 proves they do.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
