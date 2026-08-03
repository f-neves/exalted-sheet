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
