# Supabase setup

The site stays static on GitHub Pages; the campaign area talks to Supabase from the
browser. The anon key ships to the client by design, so **every rule that matters lives in
`migration.sql`** as row-level security. Nothing is trusted client-side.

Without these keys the site still builds and the character sheet works exactly as before;
only the campaign pages show a "not switched on yet" notice.

## 1. Project

Create a free project at <https://supabase.com>. Pick the region closest to your table.

## 2. Migration

**SQL Editor → New query →** paste all of [`migration.sql`](./migration.sql) **→ Run.**

It creates the tables, the security policies, the functions and the two private storage
buckets. It is idempotent, so re-running it after an edit is safe and is how you apply
changes later.

## 3. Auth settings

**Authentication → URL Configuration**

- *Site URL*: `https://f-neves.github.io/exalted-sheet/`
- *Redirect URLs*: add `https://f-neves.github.io/exalted-sheet/**` and `http://localhost:4321/**`

Without these, confirmation and password-reset links bounce to the wrong origin.

**Authentication → Sign In / Providers → Email**: for a private group, turn *Confirm email*
off so people can sign up and play immediately. Leave it on and each person has to click a
link first — note that Supabase's built-in mail server is rate-limited to a couple of
messages an hour, so for anything real you would wire up your own SMTP.

## 4. Keys

**Project Settings → API**: copy *Project URL* and the *anon public* key.

- **Locally**: copy `.env.example` to `.env` and fill both in.
- **For the deploy**: repository *Settings → Secrets and variables → Actions → **Variables***
  (not Secrets — Secrets are masked, and Astro has to inline these into the bundle at build
  time). Add `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`.

## What the schema looks like

```
profiles          one per account, created by a trigger on sign-up
campaigns         name, gm_id, join_code, starting_xp
campaign_members  (campaign, user) → role: gm | player
characters        the sheet as jsonb, portrait, prose, approval status
character_xp      split out so only the Storyteller can write it
session_notes     Storyteller's notes, optionally shared
files             uploads and links: attachments, handouts, session summaries
```

Three decisions carry most of the security:

1. **There is no INSERT policy on `campaigns` or `campaign_members`.** Membership can only
   be created through `create_campaign` and `join_campaign`, which makes the invite code the
   single way in.
2. **`is_member` and `is_gm` are `SECURITY DEFINER`.** A policy on `campaign_members` that
   queried `campaign_members` would recurse; wrapping the lookup breaks the cycle.
3. **The owner can write their sheet only while it is a draft.** That is in the UPDATE
   policy, so approval is a real lock rather than a disabled input.

Storage paths are always `<row-uuid>/<file>`, which is what lets the bucket policies cast
the first folder and hand it to those same helpers. Both buckets are private; every read
goes through a one-hour signed URL.

**Invite codes** are six characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — no `0`, `O`,
`1` or `I`, because the code gets read aloud at a table. Generation retries on collision.

## Checking it

```bash
npm run smoke:db          # 42 checks against a live project, using the anon key
npm run check:migration   # applies it twice to a throwaway Postgres in Docker
```

`smoke:db` is the one that matters: it signs up three throwaway accounts and proves the
boundaries hold — a player cannot read a table-mate's sheet, cannot raise their own XP, and
cannot write a sheet they have submitted. It cleans up the campaign afterwards; the test
accounts remain, which is harmless.
