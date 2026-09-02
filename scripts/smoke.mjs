/**
 * Headless smoke test for the Exalted sheet.
 * Drives the real page in Chrome and asserts the engine wires up end to end.
 */
/*
 * Browser smoke test. Needs a running dev server and a local Chrome; puppeteer-core is not
 * a dependency of this project, so point PUPPETEER_FROM at a package.json that has it.
 *
 *   npm run dev
 *   node scripts/smoke.mjs [url] [screenshot.png]
 *
 * Override with the CHROME_PATH and PUPPETEER_FROM environment variables.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const FROM = process.env.PUPPETEER_FROM || 'C:/Users/Neves/ClaudeCode/rpg-system/package.json';
let puppeteer;
try {
  puppeteer = createRequire(FROM)('puppeteer-core');
} catch {
  console.error(`puppeteer-core not resolvable from ${FROM}. Set PUPPETEER_FROM to a package.json that depends on it.`);
  process.exit(2);
}

const URL = process.argv[2] || 'http://localhost:4321/exalted-sheet/sheet';
const CHROME = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1100 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForSelector('#attrs .dot', { timeout: 15000 });

const results = [];
const check = (label, ok, extra = '') => results.push({ label, ok, extra });

// Everything rendered
const counts = await page.evaluate(() => ({
  attrRows: document.querySelectorAll('#attrs .trow').length,
  abilRows: document.querySelectorAll('#abils .trow').length,
  virtueRows: document.querySelectorAll('#power .trow').length,
  derived: document.querySelectorAll('#derived .derv').length,
  healthBoxes: document.querySelectorAll('#health .hl-box').length,
  circles: document.querySelectorAll('#circles .lrow').length,
  splatOpts: document.querySelectorAll('#splat-sel option').length,
  casteOpts: document.querySelectorAll('#caste-sel option').length,
}));
check('9 attribute rows', counts.attrRows === 9, JSON.stringify(counts));
check('25 ability rows (Craft is a marker row)', counts.abilRows === 25);
check('6 power rows (4 virtues + willpower + essence)', counts.virtueRows === 6);
check('derived panel populated', counts.derived >= 10);
check('health track rendered', counts.healthBoxes === 7);
check('3 sorcery circles for Solar', counts.circles === 3);
check('7 exalt types', counts.splatOpts === 7);
check('5 solar castes', counts.casteOpts === 5);

// Ability layout follows the caste names, and Craft is seeded per type
const layout = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
  craftMarker: !!document.querySelector('#abils .trow-marker'),
  craftRows: [...document.querySelectorAll('#crafts [data-subname]')].map((i) => i.value),
}));
check('solar groups are the caste names',
      JSON.stringify(layout.groups) === JSON.stringify(['Dawn', 'Zenith', 'Twilight', 'Night', 'Eclipse']),
      JSON.stringify(layout.groups));
check('Craft renders as a marker row, not a rated one', layout.craftMarker === true);
check('Craft types seeded from the splat',
      JSON.stringify(layout.craftRows) === JSON.stringify(['Air', 'Earth', 'Fire', 'Water', 'Wood', 'Glamour']),
      JSON.stringify(layout.craftRows));

// Baseline XP is zero at the floors
const xp0 = await page.$eval('#xpSpent', (e) => e.textContent);
check('fresh sheet costs 0 xp', xp0 === '0', `got ${xp0}`);

// Raise Dexterity 2 -> 5 : 4*2 + 4*3 + 4*4 = 36
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.includes('Dexterity'));
  row.querySelector('.dots [data-v="5"]').click();
});
let xp = await page.$eval('#xpSpent', (e) => e.textContent);
check('Dexterity 2->5 costs 36', xp === '36', `got ${xp}`);

// Raise Melee (Dawn caste = favored) 0 -> 5 : 3 + 1 + 3 + 5 + 7 = 19
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#abils .trow')].find((r) => r.textContent.trim().startsWith('Melee'));
  row.querySelector('.dots [data-v="5"]').click();
});
xp = await page.$eval('#xpSpent', (e) => e.textContent);
check('+ favored Melee 0->5 costs 19 (total 55)', xp === '55', `got ${xp}`);

// Grant 3 dots of Essence: rating 3 becomes free
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#power .trow')].find((r) => r.textContent.includes('Essence'));
  row.querySelector('.dots [data-v="3"]').click();
});
const xpEssPaid = await page.$eval('#xpSpent', (e) => e.textContent);
check('Essence 2->3 costs 16 (total 71)', xpEssPaid === '71', `got ${xpEssPaid}`);

await page.evaluate(() => {
  const row = [...document.querySelectorAll('#power .trow')].find((r) => r.textContent.includes('Essence'));
  const g = row.querySelector('.grant');
  g.value = '3';
  g.dispatchEvent(new Event('input', { bubbles: true }));
});
const xpEssFree = await page.$eval('#xpSpent', (e) => e.textContent);
check('granting Essence 3 refunds it (back to 55)', xpEssFree === '55', `got ${xpEssFree}`);

// Derived values: Dodge DV with Dex 5, Dodge 0, Essence 3 -> ceil(8/2) = 4
const derived = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('#derived .derv')]
    .map((d) => [d.querySelector('.dl').textContent, d.querySelector('.dv').textContent])));
check('Dodge DV = 4', derived['Dodge DV'] === '4', JSON.stringify(derived));
check('Mental DV = ceil((5+0+3)/2) = 4', derived['Mental DV'] === '4');
check('Personal Essence = 3*3+5 = 14', derived['Personal Essence'] === '14');
check('Peripheral = 3*7+5+4 = 30', derived['Peripheral Essence'] === '30');
check('Soak with Stamina 2 = 2/1/2', derived['Soak B / L / A'] === '2 / 1 / 2');

// Favored toggle
const favBefore = await page.$eval('#xpSpent', (e) => e.textContent);
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#abils .trow')].find((r) => r.textContent.trim().startsWith('Dodge'));
  row.querySelector('[data-fav]').click();
});
const favInfo = await page.$eval('#caste-info', (e) => e.textContent);
check('favored pick registered', favInfo.includes('1/5'), favInfo.slice(0, 120));
check('favoring an empty ability changes nothing', (await page.$eval('#xpSpent', (e) => e.textContent)) === favBefore);

// Switch splat: Lunar has caste Attributes AND favored Abilities at the same time
await page.select('#splat-sel', 'lunar');
await new Promise((r) => setTimeout(r, 200));
const lunar = await page.evaluate(() => ({
  castes: document.querySelectorAll('#caste-sel option').length,
  circles: document.querySelectorAll('#circles .lrow').length,
  attrTags: document.querySelectorAll('#attrs [data-fav]').length,
  abilTags: document.querySelectorAll('#abils [data-fav]').length,
  groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
  survivalLocked: document.querySelector('[data-fav="ability:survival"]')?.classList.contains('locked'),
  survivalOn: document.querySelector('[data-fav="ability:survival"]')?.classList.contains('on'),
  strengthCaste: [...document.querySelectorAll('#attrs .trow')]
    .find((r) => r.textContent.trim().startsWith('Strength'))?.querySelector('.tag')?.classList.contains('on'),
  craftRows: [...document.querySelectorAll('#crafts [data-subname]')].map((i) => i.value),
  personal: [...document.querySelectorAll('#derived .derv')]
    .find((d) => d.querySelector('.dl').textContent === 'Personal Essence')?.querySelector('.dv').textContent,
}));
check('lunar has 4 castes', lunar.castes === 4, JSON.stringify(lunar));
check('lunar has 2 sorcery circles', lunar.circles === 2);
check('lunar can favor both attributes and abilities', lunar.attrTags === 9 && lunar.abilTags === 25,
      `${lunar.attrTags} attrs / ${lunar.abilTags} abils`);
check('lunar groups are War / Life / Wisdom',
      JSON.stringify(lunar.groups) === JSON.stringify(['War', 'Life', 'Wisdom']), JSON.stringify(lunar.groups));
check('Survival is always favored and locked for Lunars',
      lunar.survivalLocked === true && lunar.survivalOn === true);
check('Full Moon grants Strength as a caste attribute', lunar.strengthCaste === true);
check('lunar Craft types swap to Magitech',
      lunar.craftRows.includes('Magitech'), JSON.stringify(lunar.craftRows));
// Essence is 3 at this point (granted), Willpower 5 -> 1*3 + 2*5 = 13
check('lunar personal = Ess 3 + WP*2 10 = 13', lunar.personal === '13', String(lunar.personal));

// Survival costs the favored price without any pick being spent
const survivalXp = await page.evaluate(() => {
  const before = Number(document.getElementById('xpSpent').textContent);
  const row = [...document.querySelectorAll('#abils .trow')].find((r) => r.textContent.trim().startsWith('Survival'));
  row.querySelector('.dots [data-v="3"]').click();
  return Number(document.getElementById('xpSpent').textContent) - before;
});
check('Survival 0->3 costs the favored 3+1+3 = 7', survivalXp === 7, String(survivalXp));

// Infernal now mirrors the Solar castes with abilities
await page.select('#splat-sel', 'infernal');
await new Promise((r) => setTimeout(r, 200));
const infernal = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
  slayerTraits: [...document.querySelectorAll('#abils > div')][0]?.textContent,
  warn: !!document.querySelector('#caste-info .warn-todo'),
}));
check('infernal groups are the five castes',
      JSON.stringify(infernal.groups) === JSON.stringify(['Slayer', 'Malefactor', 'Defiler', 'Scourge', 'Fiend']),
      JSON.stringify(infernal.groups));
check('Slayer holds the Dawn abilities',
      ['Archery', 'Martial Arts', 'Melee', 'Thrown', 'War'].every((n) => infernal.slayerTraits.includes(n)),
      infernal.slayerTraits);

// Heroic mortal: no caste, peripheral-only pool at Essence x 10, Essence capped at 3
await page.select('#splat-sel', 'mortal');
await new Promise((r) => setTimeout(r, 200));
const mortal = await page.evaluate(() => {
  const derv = Object.fromEntries([...document.querySelectorAll('#derived .derv')]
    .map((d) => [d.querySelector('.dl').textContent, d.querySelector('.dv').textContent]));
  const essRow = [...document.querySelectorAll('#power .trow')].find((r) => r.textContent.includes('Essence'));
  return {
    casteHidden: document.getElementById('caste-label-wrap').style.display === 'none',
    groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
    essenceDots: essRow.querySelectorAll('.dot').length,
    limitTrack: document.querySelectorAll('#power .box.limit').length,
    hasPersonal: 'Personal Essence' in derv,
    peripheral: derv['Peripheral Essence'],
    poolRows: [...document.querySelectorAll('#pools .cmb b')].map((b) => b.textContent),
  };
});
check('mortal hides the caste selector', mortal.casteHidden === true, JSON.stringify(mortal));
check('mortal groups are Warrior / Priest / Savant / Criminal / Broker',
      JSON.stringify(mortal.groups) === JSON.stringify(['Warrior', 'Priest', 'Savant', 'Criminal', 'Broker']),
      JSON.stringify(mortal.groups));
check('mortal Essence caps at 3 dots', mortal.essenceDots === 3, String(mortal.essenceDots));
check('mortal has no Limit track', mortal.limitTrack === 0);
check('mortal has no personal pool row', mortal.hasPersonal === false);
check('mortal peripheral = Essence 3 x 10 = 30', mortal.peripheral === '30', String(mortal.peripheral));
check('mortal pool panel drops Personal and Total',
      !mortal.poolRows.includes('Personal') && !mortal.poolRows.includes('Total'),
      JSON.stringify(mortal.poolRows));

// Add a weapon and confirm the combat panel computes
await page.select('#splat-sel', 'solar');
await new Promise((r) => setTimeout(r, 200));
await page.click('#weapon-add');
// Type character by character: this is what breaks when a render steals focus.
await page.focus('#weapons [data-wname="0"]');
await page.keyboard.type('Daiklave');
const focusKept = await page.evaluate(() =>
  document.activeElement?.getAttribute('data-wname') === '0'
  && document.activeElement.value === 'Daiklave');
check('typing a weapon name keeps focus and the full text', focusKept === true);

for (const [field, v] of [['accuracy', '2'], ['damage', '4'], ['defense', '2']]) {
  await page.evaluate((f, val) => {
    const n = document.querySelector(`#weapons [data-w="${f}:0"]`);
    n.value = val;
    n.dispatchEvent(new Event('input', { bubbles: true }));
  }, field, v);
}
const combat = await page.$eval('#combat', (e) => e.textContent);
check('combat line present', combat.includes('Daiklave'), combat.slice(0, 200));
// Dex 5 + Melee 5 + Acc 2 = 12d; Str 2 + Dmg 4 = 6L; Parry ceil((5+5+2)/2) = 6
check('attack pool 12d', combat.includes('12d'), combat.slice(0, 200));
check('damage 6L', combat.includes('6L'), combat.slice(0, 200));
check('Parry DV 6', combat.includes('Parry DV 6'), combat.slice(0, 200));

// Armour feeds Soak and the mobility penalty
await page.click('#armor-add');
await page.evaluate(() => {
  const set = (f, val) => {
    const n = document.querySelector(`#armor [data-a="${f}:0"]`);
    n.value = val; n.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('soakB', '8'); set('soakL', '7'); set('mobility', '2'); set('hardness', '4');
});
const withArmor = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('#derived .derv')]
    .map((d) => [d.querySelector('.dl').textContent, d.querySelector('.dv').textContent])));
check('armour adds to Soak (2+8 / 1+7 / 2)', withArmor['Soak B / L / A'] === '10 / 8 / 2', JSON.stringify(withArmor));
check('hardness picked up', withArmor['Hardness'] === '4');
check('mobility drops Dodge DV 4 -> 2', withArmor['Dodge DV'] === '2');

// Sorcery: initiating spends a Charm and frees the first spell of that circle
const xpBeforeSorcery = Number(await page.$eval('#xpSpent', (e) => e.textContent));
await page.click('[data-circle="terrestrial"]');
const xpCircle = Number(await page.$eval('#xpSpent', (e) => e.textContent));
check('initiating Terrestrial costs one unfavored Charm (10)', xpCircle - xpBeforeSorcery === 10,
      `${xpBeforeSorcery} -> ${xpCircle}`);
await page.click('#spell-add');
const xpSpell1 = Number(await page.$eval('#xpSpent', (e) => e.textContent));
check('first Terrestrial spell is free', xpSpell1 === xpCircle, `${xpCircle} -> ${xpSpell1}`);
await page.click('#spell-add');
const xpSpell2 = Number(await page.$eval('#xpSpent', (e) => e.textContent));
check('second Terrestrial spell costs 8', xpSpell2 - xpSpell1 === 8, `${xpSpell1} -> ${xpSpell2}`);
// Favoring Occult drops the Charm to 8 and the spells to 6
await page.evaluate(() => document.querySelector('[data-fav="ability:occult"]').click());
const xpFavOccult = Number(await page.$eval('#xpSpent', (e) => e.textContent));
check('favoring Occult saves 2 on the Charm and 2 on the paid spell', xpSpell2 - xpFavOccult === 4,
      `${xpSpell2} -> ${xpFavOccult}`);
await page.evaluate(() => document.querySelector('[data-fav="ability:occult"]').click());
await page.click('[data-circle="terrestrial"]');

// Health damage drives the wound penalty into the attack pool
// The track re-renders after each click, so re-query every time.
for (const i of [0, 1, 2]) {
  await page.evaluate((n) => document.querySelectorAll('#health .hl-box')[n].click(), i);
}
const hurt = await page.$eval('#health', (e) => e.textContent);
check('3 health levels marked', hurt.includes('Damage taken 3'), hurt.slice(0, 120));
check('wound penalty -1 at the third box', hurt.includes('Wound penalty -1'), hurt.slice(0, 120));

// Export round-trip through localStorage
const persisted = await page.evaluate(() => {
  const raw = localStorage.getItem('exalted:sheet');
  return raw ? JSON.parse(raw).weapons?.[0]?.name : null;
});
check('state persisted to localStorage', persisted === 'Daiklave', String(persisted));

// Print stylesheet + collapse
await page.click('h2.barh-tog[data-sec="abils"]');
const collapsed = await page.$eval('#sec-abils', (e) => e.classList.contains('sec-hidden'));
check('sections collapse', collapsed === true);

// A rating can never be pushed below its splat floor
const floorClamp = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.trim().startsWith('Stamina'));
  row.querySelector('.dots [data-v="2"]').click();   // already at the floor of 2
  const afterFloorClick = Number(row.querySelector('.dots').getAttribute('aria-valuenow'));
  row.querySelector('.dots [data-v="1"]').click();
  const afterBelowClick = Number(
    [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.trim().startsWith('Stamina'))
      .querySelector('.dots').getAttribute('aria-valuenow'));
  return { afterFloorClick, afterBelowClick };
});
check('clicking the floor dot does not drop below it', floorClamp.afterFloorClick === 2, JSON.stringify(floorClamp));
check('clicking under the floor does not drop below it', floorClamp.afterBelowClick === 2);

// Mystic backgrounds: 3 a dot up to 3, then 6
const bg = await page.evaluate(() => {
  const xp = () => Number(document.getElementById('xpSpent').textContent);
  const before = xp();
  document.getElementById('bg-add').click();
  const n = document.querySelector('[data-bgname="0"]');
  n.value = 'Artifact'; n.dispatchEvent(new Event('input', { bubbles: true }));
  const mysticAuto = document.querySelector('[data-bgmystic="0"]').checked;
  document.querySelector('#backgrounds .dots [data-v="5"]').click();
  const atFive = xp() - before;
  document.querySelector('[data-bgmystic="0"]').click();
  const mundaneAtFive = xp() - before;
  return { mysticAuto, atFive, mundaneAtFive };
});
check('Artifact is auto-flagged mystic from the list', bg.mysticAuto === true, JSON.stringify(bg));
check('mystic Artifact 5 costs 3+3+3+6+6 = 21', bg.atFive === 21, String(bg.atFive));
check('unticking mystic drops it to 5 x 3 = 15', bg.mundaneAtFive === 15, String(bg.mundaneAtFive));

// Charm categories: 10 native, 12 Sidereal MA, 20 other; favored 8 / 10 / 16
const charmXp = await page.evaluate(() => {
  const xp = () => Number(document.getElementById('xpSpent').textContent);
  const base = xp();
  document.getElementById('charm-add').click();
  const out = {};
  for (const cat of ['native', 'sidereal-ma', 'other']) {
    const sel = document.querySelector('[data-chcat="0"]');
    sel.value = cat; sel.dispatchEvent(new Event('change', { bubbles: true }));
    out[cat] = xp() - base;
    const fav = document.querySelector('[data-chfav="0"]');
    fav.click();
    out[cat + '-fav'] = xp() - base;
    document.querySelector('[data-chfav="0"]').click();
  }
  document.querySelector('[data-del="charm:0"]').click();
  return out;
});
check('native Charm 10 / favored 8', charmXp.native === 10 && charmXp['native-fav'] === 8, JSON.stringify(charmXp));
check('Sidereal Martial Arts 12 / favored 10', charmXp['sidereal-ma'] === 12 && charmXp['sidereal-ma-fav'] === 10);
check('other Charm 20 / favored 16', charmXp.other === 20 && charmXp['other-fav'] === 16);

// Thaumaturgy, mutations, merits and flaws
const other = await page.evaluate(() => {
  const xp = () => Number(document.getElementById('xpSpent').textContent);
  const set = (sel, v, ev = 'input') => { const n = document.querySelector(sel); n.value = v; n.dispatchEvent(new Event(ev, { bubbles: true })); };
  const base = xp();
  document.getElementById('thaum-add').click();
  set('[data-thlevel="0"]', '3');
  const degree3 = xp() - base;
  set('[data-thkind="0"]', 'procedure', 'change');
  const procedure3 = xp() - base;

  const afterThaum = xp();
  document.getElementById('mut-add').click();
  set('[data-mutlevel="0"]', '4', 'change');
  const mutation4 = xp() - afterThaum;
  document.querySelector('[data-mutneg="0"]').click();
  const defect4 = xp() - afterThaum;

  const afterMut = xp();
  document.getElementById('mf-add').click();
  set('[data-mfpoints="0"]', '3');
  const merit3 = xp() - afterMut;
  document.querySelector('[data-mfflaw="0"]').click();
  const flaw3 = xp() - afterMut;
  return { degree3, procedure3, mutation4, defect4, merit3, flaw3 };
});
check('thaumaturgy degree 3 costs 30', other.degree3 === 30, JSON.stringify(other));
check('thaumaturgy procedure 3 costs 6', other.procedure3 === 6);
check('mutation grade 4 costs 12', other.mutation4 === 12);
check('a grade 4 defect refunds 12', other.defect4 === -12);
check('a 3-point Merit costs 9', other.merit3 === 9);
check('a 3-point Flaw refunds 9', other.flaw3 === -9);

// Astrological Colleges are Sidereal-only
const astroSolar = await page.$eval('#sec-astro-wrap', (e) => e.style.display);
check('colleges hidden for Solars', astroSolar === 'none', astroSolar);
await page.select('#splat-sel', 'sidereal');
await new Promise((r) => setTimeout(r, 200));
const astro = await page.evaluate(() => {
  const xp = () => Number(document.getElementById('xpSpent').textContent);
  const shown = document.getElementById('sec-astro-wrap').style.display !== 'none';
  const base = xp();
  document.getElementById('college-add').click();
  document.querySelector('#colleges .dots [data-v="3"]').click();
  const three = xp() - base;
  document.querySelector('[data-colfav="0"]').click();
  const threeFav = xp() - base;
  return { shown, three, threeFav };
});
check('colleges shown for Sidereals', astro.shown === true, JSON.stringify(astro));
check('college 3 costs 5+4+8 = 17', astro.three === 17, String(astro.three));
check('favored college 3 costs 5+3+6 = 14', astro.threeFav === 14, String(astro.threeFav));

// Starting-sheet checks report without blocking
const checksPanel = await page.evaluate(() => {
  document.getElementById('checks-toggle').click();
  return {
    visible: !document.getElementById('checks').classList.contains('hidden'),
    lines: [...document.querySelectorAll('#checks .chk')].map((c) => c.textContent),
    failing: document.querySelectorAll('#checks .chk.bad').length,
  };
});
check('checks panel opens', checksPanel.visible === true);
check('willpower cap rule is listed',
      checksPanel.lines.some((l) => /two highest Virtues/.test(l)), JSON.stringify(checksPanel.lines));
check('virtue dot minimum is listed', checksPanel.lines.some((l) => /5 Virtue dots/.test(l)));
check('favored-needs-a-dot rule is listed', checksPanel.lines.some((l) => /at least 1 dot/.test(l)));
check('checks flag problems without blocking', checksPanel.failing > 0, String(checksPanel.failing));

// Casteless Lunars choose three Attributes where the others choose one
await page.select('#splat-sel', 'lunar');
await new Promise((r) => setTimeout(r, 200));
const lunarPicks = await page.$eval('#caste-info', (e) => e.textContent);
await page.select('#caste-sel', 'casteless');
await new Promise((r) => setTimeout(r, 200));
const castelessPicks = await page.$eval('#caste-info', (e) => e.textContent);
check('a Full Moon chooses 1 favored attribute', /Favored attributes 0\/1/.test(lunarPicks), lunarPicks.slice(0, 160));
check('a Casteless Lunar chooses 3', /Favored attributes 0\/3/.test(castelessPicks), castelessPicks.slice(0, 160));
await page.select('#splat-sel', 'solar');
await new Promise((r) => setTimeout(r, 200));

// The Charm picker, in its own context so it starts from an untouched sheet
{
  const ctx = await browser.createBrowserContext();
  const p3 = await ctx.newPage();
  await p3.setViewport({ width: 1400, height: 1100 });
  p3.on('pageerror', (e) => errors.push('pageerror(picker): ' + e.message));
  p3.on('console', (m) => { if (m.type() === 'error') errors.push('console(picker): ' + m.text()); });
  await p3.goto(URL, { waitUntil: 'networkidle0' });
  await p3.waitForSelector('#attrs .dot', { timeout: 15000 });

  const spent = () => p3.$eval('#xpSpent', (e) => Number(e.textContent));
  const rows = () => p3.$$eval('#charms .lrow:not(.head)', (ns) => ns.map((n) => ({
    name: n.querySelector('.lname')?.textContent || n.querySelector('.lname')?.value || '',
    category: n.querySelector('select')?.value,
    favored: n.querySelector('input[type=checkbox]')?.checked,
    xp: Number(n.querySelector('.xpc')?.textContent),
    warn: n.querySelector('.rowwarn')?.textContent || '',
  })));
  const pick = (name) => p3.evaluate((n) => {
    const row = [...document.querySelectorAll('.cp-row')]
      .find((r) => r.querySelector('.cp-name')?.textContent === n);
    if (!row) throw new Error('no such charm in the picker: ' + n);
    row.querySelector('.cp-take').click();
  }, name);
  const useSet = async (label) => {
    await p3.evaluate((l) => [...document.querySelectorAll('.cp-chip')]
      .find((c) => c.textContent.startsWith(l)).click(), label);
    await p3.waitForFunction(() => document.querySelectorAll('.cp-row').length > 0, { timeout: 15000 });
  };

  await p3.click('#charm-pick');
  await p3.waitForSelector('.cp-row', { timeout: 15000 });
  const chips = await p3.$$eval('.cp-chip', (ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check('picker offers all nine Charm sets', chips.length === 9, chips.join(' | '));
  check('the character\'s own set comes first', chips[0] === 'Solar Charms', chips[0]);
  check('martial arts follow, Terrestrial before Celestial before Sidereal',
        chips.slice(1, 4).join('|') === 'Terrestrial Martial Arts|Celestial Martial Arts|Sidereal Martial Arts',
        chips.slice(1, 4).join('|'));
  check('the Solar list holds 488 charms',
        (await p3.$eval('.cp-count', (e) => e.textContent)) === '488 of 488');

  // A caste ability's charm is favored automatically and costs the favored price.
  await pick('Hungry Tiger Technique');
  let list = await rows();
  check('picking a charm puts it on the sheet', list.length === 1, JSON.stringify(list));
  check('a Dawn caste Melee charm comes in favored', list[0].favored === true);
  check('a favored Charm costs 8', list[0].xp === 8, String(list[0].xp));
  check('the sheet row names its tree', list[0].name.includes('Melee'), list[0].name);
  check('XP went up by the favored Charm price', (await spent()) === 8);

  // Clicking it again takes it back off.
  await pick('Hungry Tiger Technique');
  check('picking it again removes it', (await rows()).length === 0);

  // Minimums the character does not meet are reported, never enforced.
  await pick('Accuracy without Distance');
  list = await rows();
  check('a charm above the character\'s rating is still allowed', list.length === 1);
  check('the sheet says what the charm needs', /Archery 5 \(you have 0\)/.test(list[0].warn), list[0].warn);

  const warned = await p3.$eval('.cp-row.warn .cp-warn', (e) => e.textContent);
  check('the picker says the same', /needs .*\(you have/.test(warned), warned);

  // The rules text comes from the separate file, only when a charm is opened.
  await p3.evaluate(() => [...document.querySelectorAll('.cp-row')]
    .find((r) => r.querySelector('.cp-name').textContent === 'Hungry Tiger Technique')
    .querySelector('.cp-more').click());
  await p3.waitForFunction(
    () => (document.querySelector('.cp-prose')?.textContent || '').length > 80, { timeout: 15000 });
  const prose = await p3.$eval('.cp-prose', (e) => e.textContent);
  check('opening a charm loads its rules text', prose.includes('raw damage'), prose.slice(0, 90));

  // Search and the availability filter narrow the same list.
  await p3.type('.cp-search', 'tiger');
  await p3.waitForFunction(
    () => document.querySelector('.cp-count').textContent !== '488 of 488', { timeout: 15000 });
  const searched = await p3.$eval('.cp-count', (e) => e.textContent);
  check('search narrows the list', /^[1-9] of 488$/.test(searched), searched);
  await p3.$eval('.cp-search', (n) => { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await p3.click('.cp-avail');
  const avail = await p3.$eval('.cp-count', (e) => e.textContent);
  check('the availability filter hides what the character cannot take',
        Number(avail.split(' ')[0]) < 488, avail);
  check('nothing shown under the filter carries a warning',
        (await p3.$$('.cp-row.warn')).length === 0);
  await p3.click('.cp-avail');

  // Sidereal Martial Arts carry their own price, and their prerequisites resolve.
  await useSet('Sidereal Martial Arts');
  const smaTrees = await p3.$$eval('.cp-tree', (ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check('the seven Sidereal styles are there', smaTrees.length === 7, smaTrees.join(' | '));
  await pick('Reliant Soul Infiltration');
  list = await rows();
  const sma = list.find((r) => r.name.includes('Reliant Soul Infiltration'));
  check('a Sidereal Martial Arts charm is priced as one', sma && sma.category === 'sidereal-ma',
        JSON.stringify(sma));
  check('which for a Dawn caste, Martial Arts being a caste ability, is 10',
        sma && sma.xp === 10, String(sma?.xp));
  check('and its missing prerequisite charm is named',
        /Border of Kaleidoscopic Logic Form first/.test(sma.warn), sma.warn);

  // Unticking Fav proves the price really is the Sidereal Martial Arts one.
  await p3.evaluate(() => {
    const row = [...document.querySelectorAll('#charms .lrow')]
      .find((r) => r.textContent.includes('Reliant Soul Infiltration'));
    row.querySelector('input[type=checkbox]').click();
  });
  const unfav = (await rows()).find((r) => r.name.includes('Reliant Soul Infiltration'));
  check('unfavored it costs 12', unfav && unfav.xp === 12, String(unfav?.xp));
  await p3.evaluate(() => {
    const row = [...document.querySelectorAll('#charms .lrow')]
      .find((r) => r.textContent.includes('Reliant Soul Infiltration'));
    row.querySelector('input[type=checkbox]').click();
  });

  // The tree the compiled Sidereal list leaves out was filled in from the book.
  await useSet('Sidereal Charms');
  const sidTrees = await p3.$$eval('.cp-tree', (ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check('the Sidereal Martial Arts tree is present', sidTrees.includes('Martial Arts'),
        sidTrees.join(' | '));

  // A charm from another type is an out-of-type Charm.
  await useSet('Lunar Charms');
  await pick('Humble Mouse Shape');
  list = await rows();
  const knack = list.find((r) => r.name.includes('Humble Mouse Shape'));
  check('another type\'s charm is priced out-of-type', knack && knack.category === 'other',
        JSON.stringify(knack));
  check('which is 20', knack && knack.xp === 20, String(knack?.xp));

  await p3.click('.charm-picker [data-close]');
  await p3.waitForFunction(() => !document.querySelector('.charm-picker'), { timeout: 15000 });
  check('closing the picker leaves the charms on the sheet', (await rows()).length === 3);

  // And they survive a reload, tree names and warnings included.
  await p3.reload({ waitUntil: 'networkidle0' });
  await p3.waitForFunction(
    () => document.querySelector('#charms .rowwarn') !== null, { timeout: 15000 });
  const after = await rows();
  check('picked charms are saved', after.length === 3, JSON.stringify(after.map((r) => r.name)));
  check('their prices are saved', after.map((r) => r.xp).join(',') === '8,10,20',
        after.map((r) => r.xp).join(','));
  check('their warnings come back once the sets reload',
        after.filter((r) => r.warn).length === 3, JSON.stringify(after.map((r) => r.warn)));

  // A granted Charm sits on the sheet and costs nothing. This table hands out five of them
  // at creation and buys the rest with a genre currency the XP budget never sees, so the
  // flag has to survive a reload the way the picked Charms themselves do.
  const charmTotal = () => p3.$eval('#xpBreak', (n) => {
    const m = n.textContent.match(/Charms\s+(\d+)/i);
    return m ? Number(m[1]) : null;
  });
  const paidBefore = await charmTotal();
  await p3.click('#charms [data-chgr="0"]');
  await p3.waitForFunction(() => document.querySelector('#charms .xpc.granted') !== null,
                           { timeout: 15000 });
  const granted = await rows();
  check('ticking Free zeroes the price of that Charm', granted[0].xp === 0, String(granted[0].xp));
  check('and leaves the other Charms priced', granted.slice(1).map((r) => r.xp).join(',') === '10,20',
        granted.slice(1).map((r) => r.xp).join(','));
  const paidAfter = await charmTotal();
  check('the Charm total drops by exactly that price', paidBefore - paidAfter === 8,
        `${paidBefore} -> ${paidAfter}`);

  await p3.reload({ waitUntil: 'networkidle0' });
  await p3.waitForSelector('#charms .lrow', { timeout: 15000 });
  const stillFree = await p3.$$eval('#charms [data-chgr]', (ns) => ns.map((n) => n.checked));
  check('Free survives a reload', stillFree.join(',') === 'true,false,false', stillFree.join(','));
  check('and the price stays waived', (await rows())[0].xp === 0);

  await p3.click('#charms [data-chgr="0"]');
  await p3.waitForFunction(() => document.querySelector('#charms .xpc.granted') === null,
                           { timeout: 15000 });
  check('unticking it charges again', (await rows())[0].xp === 8, String((await rows())[0].xp));

  // Heroic mortals have no Charms of their own; Terrestrial Martial Arts are theirs
  // to buy, at the Charm price.
  await p3.evaluate(() => { localStorage.removeItem('exalted:sheet'); });
  await p3.goto(URL.replace(/\/?$/, '') + '?splat=mortal', { waitUntil: 'networkidle0' });
  await p3.waitForSelector('#attrs .dot', { timeout: 15000 });
  await p3.click('#charm-pick');
  await p3.waitForSelector('.cp-row', { timeout: 15000 });
  const mortalChips = await p3.$$eval('.cp-chip', (ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check('a mortal is offered Terrestrial Martial Arts first',
        mortalChips[0] === 'Terrestrial Martial Arts', mortalChips.slice(0, 3).join(' | '));
  await pick('Living Shield Technique');
  const mortalRow = (await rows())[0];
  check('and it costs a mortal the Charm price', mortalRow && mortalRow.category === 'native',
        JSON.stringify(mortalRow));

  await ctx.close();
}

// The home page routes into the sheet
{
  const home = URL.replace(/sheet\/?$/, '');
  // Its own context, so localStorage starts empty and the "you have work in progress"
  // path can be triggered deliberately rather than by leftovers from the tests above.
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  await p2.setViewport({ width: 1400, height: 1000 });
  await p2.goto(home, { waitUntil: 'networkidle0' });
  const cards = await p2.evaluate(() => ({
    splats: [...document.querySelectorAll('.splat-card')].map((a) => a.getAttribute('href')),
    ways: [...document.querySelectorAll('.way')].map((a) => ({
      href: a.getAttribute('href'),
      title: a.querySelector('h2')?.textContent,
      explained: (a.querySelector('p')?.textContent || '').length > 80,
    })),
  }));
  check('every exalt card links into the sheet with its type',
        cards.splats.length === 7 && cards.splats.every((h) => /sheet\?splat=[a-z-]+$/.test(h || '')),
        JSON.stringify(cards.splats));
  check('the page body offers Sheet and Campaigns',
        cards.ways.length === 2 && /sheet$/.test(cards.ways[0].href) && /campaigns$/.test(cards.ways[1].href),
        JSON.stringify(cards.ways.map((w) => w.href)));
  check('both are explained, not just linked',
        cards.ways.every((w) => w.explained), JSON.stringify(cards.ways.map((w) => w.title)));

  // A fresh browser: picking a type just opens that sheet, no questions asked.
  await p2.goto(home + 'sheet?splat=lunar', { waitUntil: 'networkidle0' });
  await p2.waitForSelector('#attrs .dot', { timeout: 15000 });
  const picked = await p2.evaluate(() => ({
    splat: document.getElementById('splat-sel').value,
    groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
    url: location.search,
  }));
  check('picking Lunar opens a Lunar sheet', picked.splat === 'lunar', JSON.stringify(picked));
  check('and really switches the layout',
        JSON.stringify(picked.groups) === JSON.stringify(['War', 'Life', 'Wisdom']), JSON.stringify(picked.groups));
  check('the query string is cleaned up afterwards', picked.url === '', picked.url);

  // With work in progress it must ask first, and taking "keep" must change nothing.
  await p2.evaluate(() => {
    const row = [...document.querySelectorAll('#attrs .trow')].find((r) => r.textContent.trim().startsWith('Strength'));
    row.querySelector('.dots [data-v="4"]').click();
    document.querySelector('[data-id="name"]').value = 'Work In Progress';
    document.querySelector('[data-id="name"]').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  await p2.goto(home + 'sheet?splat=sidereal', { waitUntil: 'networkidle0' });
  await p2.waitForSelector('dialog.ui-dlg', { timeout: 15000 });
  check('switching type over existing work asks first', true);
  await p2.evaluate(() => document.querySelector('dialog.ui-dlg [data-cancel]').click());
  await p2.waitForSelector('#attrs .dot', { timeout: 15000 });
  const kept = await p2.evaluate(() => ({
    splat: document.getElementById('splat-sel').value,
    name: document.querySelector('[data-id="name"]').value,
  }));
  check('declining keeps the character exactly as it was',
        kept.splat === 'lunar' && kept.name === 'Work In Progress', JSON.stringify(kept));

  // Accepting must actually switch it.
  await p2.goto(home + 'sheet?splat=sidereal', { waitUntil: 'networkidle0' });
  await p2.waitForSelector('dialog.ui-dlg', { timeout: 15000 });
  await p2.evaluate(() => document.querySelector('dialog.ui-dlg button[type=submit]').click());
  await p2.waitForSelector('#attrs .dot', { timeout: 15000 });
  const switched = await p2.evaluate(() => ({
    splat: document.getElementById('splat-sel').value,
    name: document.querySelector('[data-id="name"]').value,
    groups: [...document.querySelectorAll('#abils h3')].map((h) => h.textContent),
  }));
  check('accepting switches the type but keeps the character',
        switched.splat === 'sidereal' && switched.name === 'Work In Progress'
        && switched.groups[0] === 'Journeys', JSON.stringify(switched));
  await ctx.close();
}

// No block may push the page wider than the viewport
const overflow = await page.evaluate(() => {
  const bad = [];
  for (const id of ['attrs', 'abils', 'crafts', 'power', 'derived', 'pools', 'health', 'weapons', 'armor']) {
    const n = document.getElementById(id);
    if (!n) continue;
    const box = n.getBoundingClientRect();
    for (const child of n.querySelectorAll('*')) {
      const c = child.getBoundingClientRect();
      if (c.width && c.right > box.right + 1) { bad.push(`${id}: ${child.className || child.tagName}`); break; }
    }
  }
  return { bad, bodyScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});
check('no block overflows its container', overflow.bad.length === 0, overflow.bad.join(' | '));
check('page does not scroll horizontally', overflow.bodyScroll <= 0, String(overflow.bodyScroll));

await page.screenshot({ path: process.argv[3] || 'sheet.png', fullPage: true });

await browser.close();

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.label}${r.ok ? '' : '  — ' + r.extra}`);
}
if (errors.length) {
  bad += errors.length;
  console.log('\nBrowser errors:');
  for (const e of errors) console.log('  ' + e);
}
console.log(`\n${results.length - (bad - errors.length)}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
