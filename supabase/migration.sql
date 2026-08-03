-- =====================================================================
-- Exalted sheet: campaigns, members, characters, files.
--
-- Paste the whole file into the Supabase SQL Editor and hit Run.
-- It is idempotent: running it again is safe.
--
-- The site is static and the anon key ships to the browser, so every rule
-- that matters lives here. Nothing is trusted client-side.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text not null default '',
  gm_id        uuid not null references auth.users(id) on delete cascade,
  join_code    text not null unique,
  starting_xp  integer not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('gm', 'player')),
  joined_at   timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

-- A second key onto profiles, which every user has (handle_new_user sees to that).
-- Beyond the integrity it states, this is what lets the API embed a member's name in
-- one request: without a declared relationship the embed is rejected outright.
do $$ begin
  alter table public.campaign_members
    add constraint campaign_members_profile_fk
    foreign key (user_id) references public.profiles(id) on delete cascade;
exception when duplicate_object then null;
end $$;

-- `sheet` holds the very same state object the offline /sheet page keeps in
-- localStorage, so the engine and its normalize() need no changes.
create table if not exists public.characters (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  campaign_id   uuid references public.campaigns(id) on delete set null,
  name          text not null default '',
  concept       text not null default '',
  sheet         jsonb not null default '{}'::jsonb,
  portrait_path text,
  portrait_pos  jsonb,
  description   text not null default '',
  backstory     text not null default '',
  notes         text not null default '',
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'approved')),
  review_note   text not null default '',
  approved_at   timestamptz,
  approved_by   uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

-- XP lives apart from the character precisely so the player cannot write it.
create table if not exists public.character_xp (
  character_id uuid primary key references public.characters(id) on delete cascade,
  xp           integer not null default 0,
  set_by       uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);

create table if not exists public.session_notes (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.campaigns(id) on delete cascade,
  title              text not null default '',
  body               text not null default '',
  visible_to_players boolean not null default false,
  position           integer not null default 0,
  created_at         timestamptz not null default now()
);

-- A row is either an upload (storage_path) or an external link (url).
-- category: 'attachment' | 'handout' | 'session-summary'
create table if not exists public.files (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid references public.campaigns(id) on delete cascade,
  character_id       uuid references public.characters(id) on delete cascade,
  owner_id           uuid not null references auth.users(id) on delete cascade,
  name               text not null,
  storage_path       text,
  url                text,
  bucket             text not null default 'characters',
  mime               text not null default '',
  category           text not null default 'attachment',
  session_no         integer,
  visible_to_players boolean not null default false,
  visible_to         uuid[] not null default '{}',
  created_at         timestamptz not null default now(),
  constraint files_target_chk check (storage_path is not null or url is not null)
);

create index if not exists characters_campaign_idx on public.characters(campaign_id);
create index if not exists characters_owner_idx    on public.characters(owner_id);
create index if not exists files_campaign_idx      on public.files(campaign_id);
create index if not exists files_character_idx     on public.files(character_id);
create index if not exists notes_campaign_idx      on public.session_notes(campaign_id);

-- ---------------------------------------------------------------------
-- Helpers
--
-- These are SECURITY DEFINER for one specific reason: a policy on
-- campaign_members that queried campaign_members would recurse. Wrapping the
-- lookup in a definer function breaks the cycle. Keep search_path pinned.
-- ---------------------------------------------------------------------

create or replace function public.is_member(c uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.campaign_members where campaign_id = c and user_id = auth.uid()
  );
$$;

create or replace function public.is_gm(c uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.campaign_members
    where campaign_id = c and user_id = auth.uid() and role = 'gm'
  );
$$;

create or replace function public.campaign_of_character(p uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select campaign_id from public.characters where id = p;
$$;

create or replace function public.owner_of_character(p uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select owner_id from public.characters where id = p;
$$;

-- Bridges a storage object back to its files row, so campaign-bucket reads can
-- honour the per-file visibility flags.
create or replace function public.file_visible(p_path text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.files f
    where f.storage_path = p_path
      and f.campaign_id is not null
      and public.is_member(f.campaign_id)
      and (f.visible_to_players = true or auth.uid() = any(f.visible_to))
  );
$$;

-- ---------------------------------------------------------------------
-- Profile bootstrap
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Join codes
--
-- Six characters from an alphabet with no 0/O/1/I, because this code gets read
-- aloud at a table. Generated with a retry loop so a collision cannot surface
-- as an insert failure.
-- ---------------------------------------------------------------------

create or replace function public.new_join_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  i integer;
begin
  for attempt in 1..50 loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.campaigns where join_code = candidate) then
      return candidate;
    end if;
  end loop;
  raise exception 'could not generate a free join code';
end; $$;

create or replace function public.create_campaign(p_name text, p_description text default '')
returns public.campaigns language plpgsql security definer set search_path = public as $$
declare created public.campaigns;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.campaigns (name, description, gm_id, join_code)
    values (
      coalesce(nullif(trim(p_name), ''), 'Untitled campaign'),
      coalesce(p_description, ''),
      auth.uid(),
      public.new_join_code()
    )
    returning * into created;
  insert into public.campaign_members (campaign_id, user_id, role)
    values (created.id, auth.uid(), 'gm');
  return created;
end; $$;

create or replace function public.join_campaign(p_code text)
returns public.campaigns language plpgsql security definer set search_path = public as $$
declare target public.campaigns;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into target from public.campaigns where join_code = upper(trim(p_code));
  if not found then raise exception 'invalid code'; end if;
  insert into public.campaign_members (campaign_id, user_id, role)
    values (target.id, auth.uid(), 'player')
    on conflict (campaign_id, user_id) do nothing;
  return target;
end; $$;

create or replace function public.regenerate_code(p_campaign uuid)
returns text language plpgsql security definer set search_path = public as $$
declare fresh text;
begin
  if not public.is_gm(p_campaign) then raise exception 'not allowed'; end if;
  fresh := public.new_join_code();
  update public.campaigns set join_code = fresh where id = p_campaign;
  return fresh;
end; $$;

-- ---------------------------------------------------------------------
-- Sheet approval
--
-- Status only ever moves through these. The UPDATE policy on characters keeps
-- the owner out of their own sheet once it leaves draft, so the lock is real
-- rather than a disabled input.
-- ---------------------------------------------------------------------

create or replace function public.submit_sheet(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.characters set status = 'submitted', updated_at = now()
   where id = p_id and owner_id = auth.uid() and status = 'draft';
  if not found then raise exception 'not allowed'; end if;
end; $$;

create or replace function public.cancel_submission(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.characters set status = 'draft', updated_at = now()
   where id = p_id and owner_id = auth.uid() and status = 'submitted';
  if not found then raise exception 'not allowed'; end if;
end; $$;

create or replace function public.approve_sheet(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.characters
     set status = 'approved', review_note = '', approved_at = now(),
         approved_by = auth.uid(), updated_at = now()
   where id = p_id and public.is_gm(campaign_id);
  if not found then raise exception 'not allowed'; end if;
end; $$;

create or replace function public.return_sheet(p_id uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.characters
     set status = 'draft', review_note = coalesce(p_note, ''), updated_at = now()
   where id = p_id and public.is_gm(campaign_id);
  if not found then raise exception 'not allowed'; end if;
end; $$;

create or replace function public.reopen_sheet(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.characters
     set status = 'draft', approved_at = null, approved_by = null, updated_at = now()
   where id = p_id and public.is_gm(campaign_id);
  if not found then raise exception 'not allowed'; end if;
end; $$;

grant execute on function public.create_campaign(text, text)  to authenticated;
grant execute on function public.join_campaign(text)          to authenticated;
grant execute on function public.regenerate_code(uuid)        to authenticated;
grant execute on function public.submit_sheet(uuid)           to authenticated;
grant execute on function public.cancel_submission(uuid)      to authenticated;
grant execute on function public.approve_sheet(uuid)          to authenticated;
grant execute on function public.return_sheet(uuid, text)     to authenticated;
grant execute on function public.reopen_sheet(uuid)           to authenticated;

-- ---------------------------------------------------------------------
-- Row level security
--
-- Shape of it: members read, the GM writes campaign-level things, the owner
-- writes their own character while it is a draft. There is deliberately NO
-- insert policy on campaigns or campaign_members, so the only way into a
-- campaign is create_campaign / join_campaign.
-- ---------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.campaigns        enable row level security;
alter table public.campaign_members enable row level security;
alter table public.characters       enable row level security;
alter table public.character_xp     enable row level security;
alter table public.session_notes    enable row level security;
alter table public.files            enable row level security;

-- profiles: any signed-in user may read names (needed to label members)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (auth.uid() = id);

-- campaigns
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns for select to authenticated
  using (public.is_member(id));
drop policy if exists campaigns_update on public.campaigns;
create policy campaigns_update on public.campaigns for update to authenticated
  using (public.is_gm(id)) with check (public.is_gm(id));
drop policy if exists campaigns_delete on public.campaigns;
create policy campaigns_delete on public.campaigns for delete to authenticated
  using (gm_id = auth.uid());

-- campaign_members
drop policy if exists members_select on public.campaign_members;
create policy members_select on public.campaign_members for select to authenticated
  using (public.is_member(campaign_id));
drop policy if exists members_update on public.campaign_members;
create policy members_update on public.campaign_members for update to authenticated
  using (public.is_gm(campaign_id)) with check (public.is_gm(campaign_id));
-- leaving is allowed for yourself; the GM may remove anyone
drop policy if exists members_delete on public.campaign_members;
create policy members_delete on public.campaign_members for delete to authenticated
  using (user_id = auth.uid() or public.is_gm(campaign_id));

-- characters: owner always reads; GM of the campaign reads too
drop policy if exists characters_select on public.characters;
create policy characters_select on public.characters for select to authenticated
  using (owner_id = auth.uid() or (campaign_id is not null and public.is_gm(campaign_id)));
drop policy if exists characters_insert on public.characters;
create policy characters_insert on public.characters for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists characters_delete on public.characters;
create policy characters_delete on public.characters for delete to authenticated
  using (owner_id = auth.uid() or (campaign_id is not null and public.is_gm(campaign_id)));
-- the owner writes only while drafting; the GM may always correct a sheet
drop policy if exists characters_update on public.characters;
create policy characters_update on public.characters for update to authenticated
  using ((owner_id = auth.uid() and status = 'draft')
         or (campaign_id is not null and public.is_gm(campaign_id)))
  with check ((owner_id = auth.uid() and status = 'draft')
              or (campaign_id is not null and public.is_gm(campaign_id)));

-- character_xp: readable by owner and GM, writable only by the GM
drop policy if exists xp_select on public.character_xp;
create policy xp_select on public.character_xp for select to authenticated
  using (public.owner_of_character(character_id) = auth.uid()
         or public.is_gm(public.campaign_of_character(character_id)));
drop policy if exists xp_insert on public.character_xp;
create policy xp_insert on public.character_xp for insert to authenticated
  with check (public.is_gm(public.campaign_of_character(character_id)));
drop policy if exists xp_update on public.character_xp;
create policy xp_update on public.character_xp for update to authenticated
  using (public.is_gm(public.campaign_of_character(character_id)))
  with check (public.is_gm(public.campaign_of_character(character_id)));

-- session notes: GM writes, players see only what is shared
drop policy if exists notes_select on public.session_notes;
create policy notes_select on public.session_notes for select to authenticated
  using (public.is_gm(campaign_id) or (public.is_member(campaign_id) and visible_to_players));
drop policy if exists notes_write on public.session_notes;
create policy notes_write on public.session_notes for all to authenticated
  using (public.is_gm(campaign_id)) with check (public.is_gm(campaign_id));

-- files: your own, the GM's view of the campaign, or something shared with you
drop policy if exists files_select on public.files;
create policy files_select on public.files for select to authenticated using (
  owner_id = auth.uid()
  or (character_id is not null and public.owner_of_character(character_id) = auth.uid())
  or (campaign_id is not null and public.is_gm(campaign_id))
  or (campaign_id is not null and public.is_member(campaign_id) and visible_to_players)
  or (campaign_id is not null and public.is_member(campaign_id) and auth.uid() = any(visible_to))
);
drop policy if exists files_insert on public.files;
create policy files_insert on public.files for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists files_update on public.files;
create policy files_update on public.files for update to authenticated
  using (owner_id = auth.uid() or (campaign_id is not null and public.is_gm(campaign_id)));
drop policy if exists files_delete on public.files;
create policy files_delete on public.files for delete to authenticated
  using (owner_id = auth.uid() or (campaign_id is not null and public.is_gm(campaign_id)));

-- ---------------------------------------------------------------------
-- Storage
--
-- Both buckets are private; every read goes through a short-lived signed URL.
-- The path is always <row-uuid>/<file>, which is what lets the policies cast
-- the first folder and hand it to the helpers above.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public) values ('characters', 'characters', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('campaign', 'campaign', false)
  on conflict (id) do nothing;

drop policy if exists st_char_select on storage.objects;
create policy st_char_select on storage.objects for select to authenticated using (
  bucket_id = 'characters' and (
    public.owner_of_character(((storage.foldername(name))[1])::uuid) = auth.uid()
    or public.is_gm(public.campaign_of_character(((storage.foldername(name))[1])::uuid))
  )
);

drop policy if exists st_char_insert on storage.objects;
create policy st_char_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'characters'
  and public.owner_of_character(((storage.foldername(name))[1])::uuid) = auth.uid()
);

drop policy if exists st_char_update on storage.objects;
create policy st_char_update on storage.objects for update to authenticated using (
  bucket_id = 'characters'
  and public.owner_of_character(((storage.foldername(name))[1])::uuid) = auth.uid()
);

drop policy if exists st_char_delete on storage.objects;
create policy st_char_delete on storage.objects for delete to authenticated using (
  bucket_id = 'characters'
  and public.owner_of_character(((storage.foldername(name))[1])::uuid) = auth.uid()
);

drop policy if exists st_camp_select on storage.objects;
create policy st_camp_select on storage.objects for select to authenticated using (
  bucket_id = 'campaign' and (
    public.is_gm(((storage.foldername(name))[1])::uuid)
    or public.file_visible(name)
  )
);

drop policy if exists st_camp_insert on storage.objects;
create policy st_camp_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'campaign' and public.is_gm(((storage.foldername(name))[1])::uuid)
);

drop policy if exists st_camp_update on storage.objects;
create policy st_camp_update on storage.objects for update to authenticated using (
  bucket_id = 'campaign' and public.is_gm(((storage.foldername(name))[1])::uuid)
);

drop policy if exists st_camp_delete on storage.objects;
create policy st_camp_delete on storage.objects for delete to authenticated using (
  bucket_id = 'campaign' and public.is_gm(((storage.foldername(name))[1])::uuid)
);
