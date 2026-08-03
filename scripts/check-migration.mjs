/**
 * Runs supabase/migration.sql against a throwaway Postgres in Docker, twice, to prove
 * that it parses, applies, and is genuinely idempotent before it ever touches a real
 * project.
 *
 * Supabase-only objects (auth.users, storage.buckets/objects, auth.uid()) do not exist
 * in plain Postgres, so a small prelude stands them in. The policies still have to
 * compile against them, which is what catches the mistakes that matter: typos in column
 * names, bad casts, functions referenced before they exist.
 *
 *   node scripts/check-migration.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'exalted-migration-check';
const IMAGE = 'postgres:16-alpine';

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

const quiet = (args) => { try { docker(args); } catch { /* nothing to clean up */ } };

const PRELUDE = `
-- Stand-ins for the Supabase-managed objects the migration leans on.
create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- Supabase exposes the caller's id here; a settable GUC mimics it well enough that the
-- policies compile and can be exercised.
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(p text) returns text[] language sql immutable as $fn$
  select (string_to_array(p, '/'))[1:greatest(array_length(string_to_array(p, '/'), 1) - 1, 0)];
$fn$;

do $do$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $do$;
`;

const CHECKS = `
-- The objects the app actually calls must all exist and be callable.
do $do$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array[
    'profiles','campaigns','campaign_members','characters','character_xp','session_notes','files'
  ]) t where to_regclass('public.' || t) is null;
  if missing is not null then raise exception 'missing tables: %', missing; end if;

  select string_agg(f, ', ') into missing from unnest(array[
    'is_member','is_gm','campaign_of_character','owner_of_character','file_visible',
    'handle_new_user','new_join_code','create_campaign','join_campaign','regenerate_code',
    'submit_sheet','cancel_submission','approve_sheet','return_sheet','reopen_sheet'
  ]) f where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f
  );
  if missing is not null then raise exception 'missing functions: %', missing; end if;
end $do$;

-- RLS must actually be on: forgetting one enable is the classic silent hole.
do $do$
declare unprotected text;
begin
  select string_agg(c.relname, ', ') into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if unprotected is not null then raise exception 'tables without RLS: %', unprotected; end if;
end $do$;

-- Membership must be reachable only through the RPCs, so no INSERT policy may exist.
do $do$
declare leaky text;
begin
  select string_agg(tablename || '.' || policyname, ', ') into leaky
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT'
    and tablename in ('campaigns', 'campaign_members');
  if leaky is not null then raise exception 'unexpected insert policy: %', leaky; end if;
end $do$;

-- Join codes: right shape, right alphabet, and distinct across a decent sample.
do $do$
declare
  code text;
  seen text[] := '{}';
  i integer;
begin
  for i in 1..200 loop
    code := public.new_join_code();
    if code !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$' then
      raise exception 'join code % has the wrong shape or uses ambiguous characters', code;
    end if;
    seen := seen || code;
  end loop;
  if (select count(distinct c) from unnest(seen) c) < 195 then
    raise exception 'join codes are not random enough';
  end if;
end $do$;

-- End to end through the real functions, as two different users.
do $do$
declare
  gm uuid; player uuid; camp public.campaigns; ch uuid; code text;
begin
  insert into auth.users (email) values ('gm@example.test') returning id into gm;
  insert into auth.users (email) values ('player@example.test') returning id into player;

  perform set_config('request.jwt.claim.sub', gm::text, true);
  camp := public.create_campaign('The Fall of Thorns', 'test');
  code := camp.join_code;
  if not public.is_gm(camp.id) then raise exception 'creator is not the GM'; end if;

  perform set_config('request.jwt.claim.sub', player::text, true);
  if public.is_member(camp.id) then raise exception 'player is a member before joining'; end if;
  perform public.join_campaign(code);
  if not public.is_member(camp.id) then raise exception 'join_campaign did not add the player'; end if;
  if public.is_gm(camp.id) then raise exception 'player was made a GM'; end if;
  -- rejoining is a no-op rather than an error
  perform public.join_campaign(lower(code));

  begin
    perform public.join_campaign('ZZZZZZ');
    raise exception 'a bad code was accepted';
  exception when others then
    if sqlerrm <> 'invalid code' then raise; end if;
  end;

  insert into public.characters (owner_id, campaign_id, name)
    values (player, camp.id, 'Ragara Sunless') returning id into ch;

  -- a player may submit, but must not approve
  perform public.submit_sheet(ch);
  if (select status from public.characters where id = ch) <> 'submitted' then
    raise exception 'submit_sheet did not move the status';
  end if;
  begin
    perform public.approve_sheet(ch);
    raise exception 'a player was allowed to approve their own sheet';
  exception when others then
    if sqlerrm <> 'not allowed' then raise; end if;
  end;

  -- the GM approves, returns with a note, and reopens
  perform set_config('request.jwt.claim.sub', gm::text, true);
  perform public.approve_sheet(ch);
  if (select status from public.characters where id = ch) <> 'approved' then
    raise exception 'approve_sheet did not move the status';
  end if;
  perform public.reopen_sheet(ch);
  perform public.submit_sheet(ch);
  raise exception 'the GM was allowed to submit someone else''s sheet';
exception when others then
  if sqlerrm <> 'not allowed' then raise; end if;
end $do$;

-- Regenerating a code is GM-only and actually changes it.
do $do$
declare gm uuid; other uuid; camp public.campaigns; before text; after_ text;
begin
  insert into auth.users (email) values ('gm2@example.test') returning id into gm;
  insert into auth.users (email) values ('nobody@example.test') returning id into other;
  perform set_config('request.jwt.claim.sub', gm::text, true);
  camp := public.create_campaign('Shadows of the South');
  before := camp.join_code;
  after_ := public.regenerate_code(camp.id);
  if after_ = before then raise exception 'regenerate_code returned the same code'; end if;

  perform set_config('request.jwt.claim.sub', other::text, true);
  begin
    perform public.regenerate_code(camp.id);
    raise exception 'a non-member regenerated the code';
  exception when others then
    if sqlerrm <> 'not allowed' then raise; end if;
  end;
end $do$;

select 'migration checks passed' as result;
`;

console.log('migration check');
quiet(['rm', '-f', NAME]);

const tmp = join(ROOT, 'node_modules', '.migration-check.sql');
const migration = readFileSync(join(ROOT, 'supabase/migration.sql'), 'utf8');

try {
  console.log('  starting postgres…');
  docker(['run', '--rm', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=check', IMAGE]);

  for (let i = 0; ; i++) {
    try { docker(['exec', NAME, 'pg_isready', '-U', 'postgres']); break; }
    catch (e) {
      if (i > 60) throw new Error('postgres never came up');
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
    }
  }

  const run = (label, sql) => {
    writeFileSync(tmp, sql);
    const out = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
      { input: sql });
    console.log(`  ${label}`);
    return out;
  };

  run('prelude applied', PRELUDE);
  run('migration applied', migration);
  run('migration re-applied (idempotent)', migration);
  const out = run('checks', CHECKS);
  if (!out.includes('migration checks passed')) throw new Error('checks did not report success');
  console.log('\n  migration is valid, idempotent, and enforces its rules');
} catch (err) {
  const detail = err.stderr ? String(err.stderr) : err.message;
  console.error('\nMIGRATION CHECK FAILED\n' + detail.trim());
  process.exitCode = 1;
} finally {
  quiet(['rm', '-f', NAME]);
}
