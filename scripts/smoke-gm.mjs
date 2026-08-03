/**
 * Browser test of the GM area: two people, two browser contexts, one campaign.
 *
 * The database rules are already proven by smoke-supabase.mjs; this drives the actual
 * pages, so what it checks is the wiring — that signing up works, the code moves a player
 * into a campaign, the sheet saves and comes back, the portrait uploads, and the approval
 * lock reaches the interface.
 *
 *   npm run dev
 *   node scripts/smoke-gm.mjs [baseUrl]
 */
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(process.env.PUPPETEER_FROM || 'C:/Users/Neves/ClaudeCode/rpg-system/package.json');
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch { console.error('puppeteer-core not resolvable; set PUPPETEER_FROM'); process.exit(2); }

const CHROME = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_PATH'); process.exit(2); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://localhost:4321/exalted-sheet/').replace(/\/?$/, '/');
const stamp = Date.now();

const results = [];
const check = (label, ok, extra = '') => results.push({ label, ok: !!ok, extra: String(extra) });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

/** A separate incognito context per person, so the two sessions never share cookies. */
async function person(tag) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  return { ctx, page, errors, email: `gm-smoke-${tag}-${stamp}@example.com`, password: `pw-${stamp}` };
}

async function signUp(p, name) {
  await p.page.goto(BASE + 'login', { waitUntil: 'networkidle0' });
  await p.page.waitForSelector('#forms:not([hidden])', { timeout: 15000 });
  await p.page.click('[data-tab="up"]');
  await p.page.type('#form-up [name=name]', name);
  await p.page.type('#form-up [name=email]', p.email);
  await p.page.type('#form-up [name=password]', p.password);
  await Promise.all([
    p.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {}),
    p.page.click('#form-up button[type=submit]'),
  ]);
}

const png = join(ROOT, 'node_modules', `.smoke-portrait-${stamp}.png`);
writeFileSync(png, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

let gm, player, code = '', campaignUrl = '', charUrl = '';

try {
  console.log('gm area, in the browser');

  /* ---- sign up ------------------------------------------------------- */
  gm = await person('gm');
  player = await person('player');
  await signUp(gm, 'Smoke GM');
  check('signing up lands on the campaigns page', gm.page.url().includes('campaigns'), gm.page.url());

  const authLabel = await gm.page.$eval('#auth-link .auth-label', (e) => e.textContent);
  check('the topbar shows who is signed in', /Sign out/.test(authLabel), authLabel);

  await signUp(player, 'Smoke Player');

  /* ---- create a campaign --------------------------------------------- */
  await gm.page.goto(BASE + 'campaigns', { waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#content:not([hidden])');
  await gm.page.type('#form-create [name=name]', 'Smoke Campaign');
  await Promise.all([
    gm.page.waitForNavigation({ waitUntil: 'networkidle0' }),
    gm.page.click('#form-create button[type=submit]'),
  ]);
  campaignUrl = gm.page.url();
  // The dev server serves /campaign?id=, the built site /campaign/?id=.
  const CAMPAIGN_URL = /campaign\/?\?id=/;
  const CHARACTER_URL = /character\/?\?id=/;
  check('creating a campaign opens it', CAMPAIGN_URL.test(campaignUrl), campaignUrl);

  await gm.page.waitForSelector('#wrap:not([hidden])');
  code = (await gm.page.$eval('#code', (e) => e.textContent)).trim();
  check('the invite code is shown to the Storyteller and well formed',
        /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code), code);

  const gmSeal = await gm.page.$eval('#role-seal', (e) => e.textContent);
  check('the Storyteller is labelled as such', gmSeal === 'Storyteller', gmSeal);

  /* ---- join with the code -------------------------------------------- */
  await player.page.goto(BASE + 'campaigns', { waitUntil: 'networkidle0' });
  await player.page.waitForSelector('#content:not([hidden])');
  await player.page.type('#form-join [name=code]', code.toLowerCase());
  await Promise.all([
    player.page.waitForNavigation({ waitUntil: 'networkidle0' }),
    player.page.click('#form-join button[type=submit]'),
  ]);
  await player.page.waitForSelector('#wrap:not([hidden])');
  check('a player joins with the code', CAMPAIGN_URL.test(player.page.url()), player.page.url());

  const inviteHidden = await player.page.$eval('#invite', (e) => e.hidden);
  check('players never see the invite panel', inviteHidden === true);

  await gm.page.reload({ waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#wrap:not([hidden])');
  const memberText = await gm.page.$eval('#members', (e) => e.textContent);
  check('the Storyteller sees the new member',
        memberText.includes('Smoke Player') && memberText.includes('Smoke GM'), memberText.slice(0, 140));

  /* ---- the player builds a character ---------------------------------- */
  await Promise.all([
    player.page.waitForNavigation({ waitUntil: 'networkidle0' }),
    player.page.click('#new-char'),
  ]);
  await player.page.waitForSelector('#attrs .dot', { timeout: 20000 });
  charUrl = player.page.url();
  check('a new character opens the sheet', CHARACTER_URL.test(charUrl), charUrl);

  const mediaShown = await player.page.$eval('#media', (e) => !e.hidden);
  check('the portrait and gallery block appears on a campaign sheet', mediaShown === true);

  await player.page.evaluate(() => {
    const n = document.querySelector('[data-id="name"]');
    n.value = 'Smoke Solar'; n.dispatchEvent(new Event('input', { bubbles: true }));
    const row = [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.trim().startsWith('Dexterity'));
    row.querySelector('.dots [data-v="5"]').click();
  });
  const spent = await player.page.$eval('#xpSpent', (e) => e.textContent);
  check('the sheet still computes XP inside the campaign area', spent === '36', spent);

  // Wait past the 900 ms debounce, then prove it survives a reload.
  await new Promise((r) => setTimeout(r, 1600));
  await player.page.reload({ waitUntil: 'networkidle0' });
  await player.page.waitForSelector('#attrs .dot', { timeout: 20000 });
  const reloaded = await player.page.evaluate(() => ({
    spent: document.getElementById('xpSpent').textContent,
    name: document.querySelector('[data-id="name"]').value,
    title: document.getElementById('char-name').textContent,
  }));
  check('the sheet was saved to the database and reloads intact',
        reloaded.spent === '36' && reloaded.name === 'Smoke Solar', JSON.stringify(reloaded));
  check('the character name reaches the page heading', reloaded.title === 'Smoke Solar', reloaded.title);

  /* ---- portrait -------------------------------------------------------- */
  const picker = await player.page.$('#pt-file');
  await picker.uploadFile(png);
  await player.page.waitForFunction(() => {
    const f = document.getElementById('pt-frame');
    return f && !f.hidden && document.getElementById('pt-img').src.startsWith('http');
  }, { timeout: 20000 });
  check('the portrait uploads and renders', true);

  await player.page.reload({ waitUntil: 'networkidle0' });
  await player.page.waitForSelector('#pt-frame:not([hidden])', { timeout: 20000 });
  check('the portrait survives a reload', true);

  /* ---- the Storyteller's XP reaches the player ------------------------- */
  await gm.page.goto(charUrl, { waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#attrs .dot', { timeout: 20000 });
  const gmReadOnly = await gm.page.evaluate(() => ({
    budgetDisabled: document.getElementById('xpBudget').disabled,
    xpPanel: !document.getElementById('gm-xp').hidden,
    statusText: document.getElementById('status-text').textContent,
  }));
  check('the Storyteller opens a player sheet read-only',
        /read-only/i.test(gmReadOnly.statusText), gmReadOnly.statusText);
  check('the Storyteller gets the XP panel', gmReadOnly.xpPanel === true);

  await gm.page.evaluate(() => {
    const i = document.getElementById('xp-input');
    i.value = '250'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('xp-save').click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  await player.page.reload({ waitUntil: 'networkidle0' });
  await player.page.waitForSelector('#attrs .dot', { timeout: 20000 });
  const budget = await player.page.evaluate(() => ({
    value: document.getElementById('xpBudget').value,
    disabled: document.getElementById('xpBudget').disabled,
  }));
  check('the player sees the XP the Storyteller set', budget.value === '250', JSON.stringify(budget));
  check('and cannot change it', budget.disabled === true);

  /* ---- approval ---------------------------------------------------------- */
  await player.page.evaluate(() => {
    const b = [...document.querySelectorAll('#status-actions button')]
      .find((x) => /Send for approval/.test(x.textContent));
    b.click();
  });
  await player.page.waitForFunction(
    () => document.getElementById('status-seal')?.textContent === 'Awaiting approval', { timeout: 20000 });
  const afterSubmit = await player.page.evaluate(() => ({
    seal: document.getElementById('status-seal').textContent,
    firstDotDisabled: !!document.querySelector('#attrs .dot')?.disabled,
    portraitPick: document.getElementById('pt-pick').hidden,
  }));
  check('submitting flips the seal', afterSubmit.seal === 'Awaiting approval');
  check('a submitted sheet hides the portrait controls', afterSubmit.portraitPick === true);

  // A submitted sheet must not accept edits. The database refusal is proven in
  // smoke-supabase.mjs; here we check the engine went read-only, so a click does nothing.
  const before = await player.page.$eval('#xpSpent', (e) => e.textContent);
  await player.page.evaluate(() => {
    const row = [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.trim().startsWith('Stamina'));
    row.querySelector('.dots [data-v="5"]').click();
  });
  const after = await player.page.$eval('#xpSpent', (e) => e.textContent);
  check('a submitted sheet ignores edits', before === after, `${before} -> ${after}`);

  await gm.page.reload({ waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#status-actions button', { timeout: 20000 });
  await gm.page.evaluate(() => {
    [...document.querySelectorAll('#status-actions button')].find((x) => /Approve/.test(x.textContent)).click();
  });
  await gm.page.waitForFunction(
    () => document.getElementById('status-seal')?.textContent === 'Approved', { timeout: 20000 });
  check('the Storyteller approves', true);

  await gm.page.goto(campaignUrl, { waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#characters .char-card', { timeout: 20000 });
  const cardText = await gm.page.$eval('#characters', (e) => e.textContent);
  check('the campaign lists the character with its status',
        cardText.includes('Smoke Solar') && cardText.includes('Approved'), cardText.slice(0, 140));

  /* ---- session summary --------------------------------------------------- */
  gm.page.once('dialog', () => {});
  await gm.page.evaluate(() => {
    // The session-number prompt is our own dialog, so answer it as it appears.
    const observer = new MutationObserver(() => {
      const dlg = document.querySelector('dialog.ui-dlg');
      if (!dlg) return;
      const input = dlg.querySelector('input');
      if (input) { input.value = '1'; dlg.querySelector('button[type=submit]').click(); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true });
  });
  const summaryPicker = await gm.page.$('#summary-file');
  await summaryPicker.uploadFile(png);
  await gm.page.waitForFunction(
    () => document.querySelector('#summaries .frow') !== null, { timeout: 20000 });
  check('the Storyteller uploads a session summary', true);

  await player.page.goto(campaignUrl, { waitUntil: 'networkidle0' });
  await player.page.waitForSelector('#wrap:not([hidden])');
  const playerSees = await player.page.$eval('#summaries', (e) => e.textContent);
  check('players see the session summary', /session 1/i.test(playerSees), playerSees.slice(0, 120));

  /* ---- clean up ---------------------------------------------------------- */
  await gm.page.goto(campaignUrl, { waitUntil: 'networkidle0' });
  await gm.page.waitForSelector('#wrap:not([hidden])');
  await gm.page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const dlg = document.querySelector('dialog.ui-dlg');
      if (dlg) { dlg.querySelector('button[type=submit]').click(); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true });
    document.getElementById('delete-camp').click();
  });
  await gm.page.waitForFunction(() => location.href.includes('campaigns'), { timeout: 20000 });
  check('the Storyteller can delete the campaign', true);

  const pageErrors = [...gm.errors, ...player.errors].filter((e) => !/favicon/i.test(e));
  check('no uncaught errors in either browser', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('the run completed without throwing', false, err.message);
} finally {
  try { unlinkSync(png); } catch {}
  await browser.close();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.label}${r.ok || !r.extra ? '' : '  — ' + r.extra}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
