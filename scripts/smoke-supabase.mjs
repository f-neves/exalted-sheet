/**
 * End-to-end test of the GM area against a live Supabase project.
 *
 * Everything here runs through the anon key exactly as the browser does, so what it
 * proves is the row-level security, not just the happy path. The interesting assertions
 * are the negative ones: a player must not be able to read a table-mate's sheet, and a
 * submitted sheet must be rejected by the database rather than by a disabled input.
 *
 *   npm run smoke:db          (reads .env)
 *
 * Leaves no campaigns or characters behind. Test accounts stay, since removing them
 * needs the service-role key; they are harmless.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env() {
  const out = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* fall through to process.env */ }
  return {
    url: process.env.PUBLIC_SUPABASE_URL || out.PUBLIC_SUPABASE_URL,
    key: process.env.PUBLIC_SUPABASE_ANON_KEY || out.PUBLIC_SUPABASE_ANON_KEY,
  };
}

const { url, key } = env();
if (!url || !key) {
  console.error('No Supabase keys. Copy .env.example to .env and fill it in.');
  process.exit(2);
}

const results = [];
const check = (label, ok, extra = '') => results.push({ label, ok: !!ok, extra: String(extra) });

const stamp = Date.now();
const anon = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function account(tag) {
  const sb = anon();
  const email = `exalted-test-${tag}-${stamp}@example.com`;
  const password = `pw-${stamp}-${tag}`;
  const { error } = await sb.auth.signUp({ email, password, options: { data: { name: `Test ${tag}` } } });
  if (error) throw new Error(`signUp(${tag}): ${error.message}`);
  const { data, error: e2 } = await sb.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`signIn(${tag}): ${e2.message}`);
  return { sb, id: data.user.id, email };
}

/** A 1x1 PNG, so the storage tests move real bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let campaignId = null;
let gmSb = null;

try {
  console.log('supabase end-to-end');

  /* ---- accounts ---------------------------------------------------- */
  const gm = await account('gm');
  const p1 = await account('p1');
  const p2 = await account('p2');
  gmSb = gm.sb;
  check('three accounts created and signed in', gm.id && p1.id && p2.id);

  // The trigger should have materialised a profile for each.
  const { data: prof } = await gm.sb.from('profiles').select('name').eq('id', gm.id).maybeSingle();
  check('handle_new_user created the profile with the given name', prof?.name === 'Test gm', prof?.name);

  /* ---- campaign and join code -------------------------------------- */
  const { data: camp, error: campErr } = await gm.sb.rpc('create_campaign', {
    p_name: 'RLS Test Campaign', p_description: 'automated',
  });
  if (campErr) throw new Error('create_campaign: ' + campErr.message);
  campaignId = camp.id;
  check('create_campaign returned a campaign', !!camp.id);
  check('join code is 6 unambiguous characters', /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(camp.join_code), camp.join_code);

  const { error: badCode } = await p1.sb.rpc('join_campaign', { p_code: 'ZZZZZZ' });
  check('a wrong code is rejected', !!badCode, badCode?.message);

  // A non-member must not even see the campaign row.
  const { data: peek } = await p1.sb.from('campaigns').select('id').eq('id', campaignId);
  check('a non-member cannot see the campaign', (peek || []).length === 0);

  const { error: j1 } = await p1.sb.rpc('join_campaign', { p_code: camp.join_code.toLowerCase() });
  check('joining with the code works and is case-insensitive', !j1, j1?.message);
  await p2.sb.rpc('join_campaign', { p_code: camp.join_code });

  const { data: seen } = await p1.sb.from('campaigns').select('id, name').eq('id', campaignId).maybeSingle();
  check('a member can now see the campaign', seen?.id === campaignId);

  const { data: members } = await gm.sb.from('campaign_members').select('user_id, role').eq('campaign_id', campaignId);
  check('campaign has 3 members, one of them the GM',
        members?.length === 3 && members.filter((m) => m.role === 'gm').length === 1,
        JSON.stringify(members?.map((m) => m.role)));

  // Membership must only be reachable through the RPC.
  const { error: sneak } = await p1.sb.from('campaign_members')
    .insert({ campaign_id: campaignId, user_id: p1.id, role: 'gm' });
  check('a player cannot insert themselves as GM', !!sneak, sneak?.message);

  /* ---- characters and the sheet blob -------------------------------- */
  const sheet = { meta: { schema: 2 }, splat: 'solar', caste: 'dawn', budget: 400,
                  attrs: { dexterity: { v: 5, granted: 0 } } };
  const { data: ch1, error: chErr } = await p1.sb.from('characters')
    .insert({ owner_id: p1.id, campaign_id: campaignId, name: 'Ragara Sunless' })
    .select('id').single();
  if (chErr) throw new Error('insert character: ' + chErr.message);
  check('a player can create a character', !!ch1.id);

  await p1.sb.from('characters').update({ sheet }).eq('id', ch1.id);
  const { data: back } = await p1.sb.from('characters').select('sheet').eq('id', ch1.id).single();
  // jsonb is a parsed representation, so it does not preserve key order. Compare by value.
  const sameShape = (a, b) => {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameShape(a[k], b[k]));
  };
  check('the sheet blob round-trips unchanged', sameShape(back.sheet, sheet), JSON.stringify(back.sheet));

  /* ---- the boundary that matters ------------------------------------ */
  const { data: spy } = await p2.sb.from('characters').select('id, sheet').eq('id', ch1.id);
  check('a table-mate CANNOT read another player\'s character', (spy || []).length === 0,
        JSON.stringify(spy));

  const { data: tamper } = await p2.sb.from('characters')
    .update({ name: 'hacked' }).eq('id', ch1.id).select('id');
  check('a table-mate CANNOT write another player\'s character', (tamper || []).length === 0);

  const { data: gmView } = await gm.sb.from('characters').select('id, name').eq('campaign_id', campaignId);
  check('the GM can read the campaign\'s characters', gmView?.length === 1, JSON.stringify(gmView));

  /* ---- GM-controlled XP --------------------------------------------- */
  const { error: xpDenied } = await p1.sb.from('character_xp')
    .insert({ character_id: ch1.id, xp: 9999 });
  check('a player cannot set their own XP', !!xpDenied, xpDenied?.message);

  const { error: xpErr } = await gm.sb.from('character_xp')
    .upsert({ character_id: ch1.id, xp: 350, set_by: gm.id }, { onConflict: 'character_id' });
  check('the GM can set XP', !xpErr, xpErr?.message);

  const { data: xpRead } = await p1.sb.from('character_xp').select('xp').eq('character_id', ch1.id).maybeSingle();
  check('the player can read the XP the GM set', xpRead?.xp === 350, JSON.stringify(xpRead));

  await gm.sb.from('campaigns').update({ starting_xp: 300 }).eq('id', campaignId);
  const { data: startXp } = await p1.sb.from('campaigns').select('starting_xp').eq('id', campaignId).single();
  check('the GM sets the starting XP and players see it', startXp.starting_xp === 300);

  const { data: xpTamper } = await p1.sb.from('character_xp')
    .update({ xp: 9999 }).eq('character_id', ch1.id).select('character_id');
  check('a player cannot raise their own XP', (xpTamper || []).length === 0);

  /* ---- approval locks the sheet in the database --------------------- */
  const { error: subErr } = await p1.sb.rpc('submit_sheet', { p_id: ch1.id });
  check('the owner can submit', !subErr, subErr?.message);

  const { data: locked } = await p1.sb.from('characters')
    .update({ sheet: { hacked: true } }).eq('id', ch1.id).select('id');
  check('a submitted sheet CANNOT be written by its owner', (locked || []).length === 0);

  const { error: approveDenied } = await p2.sb.rpc('approve_sheet', { p_id: ch1.id });
  check('a player cannot approve a sheet', !!approveDenied, approveDenied?.message);

  await gm.sb.rpc('approve_sheet', { p_id: ch1.id });
  const { data: approved } = await gm.sb.from('characters').select('status, approved_by').eq('id', ch1.id).single();
  check('the GM approves and the stamp is recorded',
        approved.status === 'approved' && approved.approved_by === gm.id, JSON.stringify(approved));

  await gm.sb.rpc('return_sheet', { p_id: ch1.id, p_note: 'Lower your Essence.' });
  const { data: returned } = await p1.sb.from('characters').select('status, review_note').eq('id', ch1.id).single();
  check('returning sends it back to draft with the note',
        returned.status === 'draft' && returned.review_note === 'Lower your Essence.',
        JSON.stringify(returned));

  const { data: editable } = await p1.sb.from('characters')
    .update({ name: 'Ragara Sunless' }).eq('id', ch1.id).select('id');
  check('a returned sheet is writable by its owner again', (editable || []).length === 1);

  /* ---- portrait storage --------------------------------------------- */
  const path1 = `${ch1.id}/portrait-${stamp}.png`;
  const { error: upErr } = await p1.sb.storage.from('characters')
    .upload(path1, PNG, { contentType: 'image/png' });
  check('the owner can upload a portrait', !upErr, upErr?.message);

  const { data: signed } = await p1.sb.storage.from('characters').createSignedUrl(path1, 60);
  check('the portrait reads back through a signed URL', !!signed?.signedUrl);

  const { error: gmUpErr } = await p2.sb.storage.from('characters')
    .upload(`${ch1.id}/intruder-${stamp}.png`, PNG, { contentType: 'image/png' });
  check('another player CANNOT upload into someone else\'s character folder', !!gmUpErr, gmUpErr?.message);

  const { data: gmSigned } = await gm.sb.storage.from('characters').createSignedUrl(path1, 60);
  check('the GM can read a player\'s portrait', !!gmSigned?.signedUrl);

  await p1.sb.storage.from('characters').remove([path1]);
  const { data: gone } = await p1.sb.storage.from('characters').createSignedUrl(path1, 60);
  check('deleting the portrait really removes it', !gone?.signedUrl);

  /* ---- handouts and session summaries -------------------------------- */
  const handoutPath = `${campaignId}/handout-${stamp}.png`;
  const { error: hErr } = await gm.sb.storage.from('campaign')
    .upload(handoutPath, PNG, { contentType: 'image/png' });
  check('the GM can upload a handout', !hErr, hErr?.message);

  const { error: pHandout } = await p1.sb.storage.from('campaign')
    .upload(`${campaignId}/sneaky-${stamp}.png`, PNG, { contentType: 'image/png' });
  check('a player CANNOT upload into the campaign bucket', !!pHandout, pHandout?.message);

  const { data: hRow } = await gm.sb.from('files').insert({
    campaign_id: campaignId, owner_id: gm.id, name: 'Secret map',
    storage_path: handoutPath, bucket: 'campaign', mime: 'image/png',
    category: 'handout', visible_to_players: false,
  }).select('id').single();

  const { data: hiddenToP1 } = await p1.sb.from('files').select('id').eq('id', hRow.id);
  check('an unshared handout is invisible to players', (hiddenToP1 || []).length === 0);

  await gm.sb.from('files').update({ visible_to: [p1.id] }).eq('id', hRow.id);
  const { data: sharedToP1 } = await p1.sb.from('files').select('id').eq('id', hRow.id);
  const { data: stillHiddenP2 } = await p2.sb.from('files').select('id').eq('id', hRow.id);
  check('sharing with one player shows it to exactly that player',
        (sharedToP1 || []).length === 1 && (stillHiddenP2 || []).length === 0);

  const { data: p1Signed } = await p1.sb.storage.from('campaign').createSignedUrl(handoutPath, 60);
  check('the named player can open the handout file', !!p1Signed?.signedUrl);
  const { data: p2Signed } = await p2.sb.storage.from('campaign').createSignedUrl(handoutPath, 60);
  check('the other player cannot open the handout file', !p2Signed?.signedUrl);

  const summaryPath = `${campaignId}/session-1-${stamp}.png`;
  await gm.sb.storage.from('campaign').upload(summaryPath, PNG, { contentType: 'image/png' });
  await gm.sb.from('files').insert({
    campaign_id: campaignId, owner_id: gm.id, name: 'Session 1 recap',
    storage_path: summaryPath, bucket: 'campaign', mime: 'image/png',
    category: 'session-summary', session_no: 1, visible_to_players: true,
  });
  const { data: sumP2 } = await p2.sb.from('files').select('id, session_no')
    .eq('campaign_id', campaignId).eq('category', 'session-summary');
  check('a session summary is visible to every member', (sumP2 || []).length === 1, JSON.stringify(sumP2));

  /* ---- session notes -------------------------------------------------- */
  const { data: note } = await gm.sb.from('session_notes')
    .insert({ campaign_id: campaignId, title: 'Private prep', body: 'the twist' })
    .select('id').single();
  const { data: notePeek } = await p1.sb.from('session_notes').select('id').eq('id', note.id);
  check('private notes stay with the GM', (notePeek || []).length === 0);

  const { error: noteWrite } = await p1.sb.from('session_notes')
    .insert({ campaign_id: campaignId, title: 'nope', body: '' });
  check('a player cannot write session notes', !!noteWrite, noteWrite?.message);

  await gm.sb.from('session_notes').update({ visible_to_players: true }).eq('id', note.id);
  const { data: noteShared } = await p1.sb.from('session_notes').select('id').eq('id', note.id);
  check('a shared note becomes visible', (noteShared || []).length === 1);

  /* ---- leaving --------------------------------------------------------- */
  await p2.sb.from('campaign_members').delete().eq('campaign_id', campaignId).eq('user_id', p2.id);
  const { data: afterLeave } = await gm.sb.from('campaign_members').select('user_id').eq('campaign_id', campaignId);
  check('a player can leave the campaign', afterLeave?.length === 2);
} catch (err) {
  check('the run completed without throwing', false, err.message);
} finally {
  // Deleting the campaign cascades to members, characters, files and notes.
  if (gmSb && campaignId) {
    try {
      const { data: chars } = await gmSb.from('characters').select('id').eq('campaign_id', campaignId);
      for (const c of chars || []) {
        const { data: objs } = await gmSb.storage.from('characters').list(c.id);
        if (objs?.length) await gmSb.storage.from('characters').remove(objs.map((o) => `${c.id}/${o.name}`));
      }
      const { data: campObjs } = await gmSb.storage.from('campaign').list(campaignId);
      if (campObjs?.length) await gmSb.storage.from('campaign').remove(campObjs.map((o) => `${campaignId}/${o.name}`));
      await gmSb.from('campaigns').delete().eq('id', campaignId);
    } catch { /* best effort */ }
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.label}${r.ok || !r.extra ? '' : '  — ' + r.extra}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
