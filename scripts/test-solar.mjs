/**
 * Golden test: src/lib/calc.js must reproduce Solar.xlsx.
 *
 * The spreadsheet's own formulas are transcribed literally below, straight from the
 * cells, and checked against the sheet engine across the whole useful rating range.
 *
 * Two deliberate deviations are asserted rather than matched:
 *   - below a trait's floor the spreadsheet returns negative XP (a refund); we return 0.
 *   - Dodge DV in the spreadsheet carries a stray "+3" and "PDV" is a broken copy-down;
 *     we implement canonical 2e instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as calc from '../src/lib/calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const splat = read('src/data/splats/solar.json');
const rules = read('src/data/rules.json');
const data = {
  attributes: read('src/data/attributes.json'),
  abilities: read('src/data/abilities.json'),
  virtues: read('src/data/virtues.json'),
};

let failures = 0;
let checks = 0;
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  FAIL  ${label}\n        expected ${expected}, got ${actual}`);
  }
}

/* ---- Solar.xlsx formulas, transcribed from the cells ---------------- */
const xlAttr = (n, fav) => (fav ? (n ** 2 - n) * 3 / 2 - 3 : (n ** 2 - n) * 4 / 2 - 4);
const xlAbil = (n, fav) =>
  fav ? (n < 2 ? n * 3 : n ** 2 - n + 4 - n) : (n < 2 ? n * 3 : n ** 2 - n + 3);
const xlWill = (n) => ((10 + (n - 1) * 2) * (n - 5)) / 2;
const xlVirtue = (n) => ((n ** 2 - n) * 3) / 2;
const xlEssence = (n) => ((n ** 2 - n) * 8) / 2 - 8;
const xlCharms = (fav, unfav) => fav * 8 + unfav * 10;
const xlSpells = (t, c, s, favOccult) =>
  favOccult ? t * 6 + c * 8 + s * 10 : t * 8 + c * 10 + s * 12;
const xlSpecialty = (n) => n * 3;
const xlMdv = (integrity, wp, ess) => Math.ceil((integrity + wp + ess) / 2);
const xlPersonal = (ess, wp) => ess * 3 + wp;
const xlPeripheral = (ess, wp, virtuesSum) => virtuesSum + ess * 7 + wp;

console.log('Solar.xlsx golden test');

/* ---- W2: attributes ------------------------------------------------- */
for (let n = 2; n <= 10; n++) {
  for (const fav of [false, true]) {
    eq(calc.traitXp('attribute', n, 0, fav, splat), xlAttr(n, fav),
       `W2 attribute ${n}${fav ? ' favored' : ''}`);
  }
}

/* ---- W4: abilities -------------------------------------------------- */
for (let n = 0; n <= 10; n++) {
  for (const fav of [false, true]) {
    eq(calc.traitXp('ability', n, 0, fav, splat), xlAbil(n, fav),
       `W4 ability ${n}${fav ? ' favored' : ''}`);
  }
}

/* ---- W6: willpower -------------------------------------------------- */
for (let n = 5; n <= 12; n++) {
  eq(calc.traitXp('willpower', n, 0, false, splat), xlWill(n), `W6 willpower ${n}`);
}

/* ---- W8: virtues ---------------------------------------------------- */
for (let n = 1; n <= 10; n++) {
  eq(calc.traitXp('virtue', n, 0, false, splat), xlVirtue(n), `W8 virtue ${n}`);
}

/* ---- W10: charms ---------------------------------------------------- */
for (const [f, u] of [[0, 0], [1, 0], [0, 1], [3, 2], [12, 7]]) {
  const S = { charms: { list: [] } };
  for (let i = 0; i < f; i++) S.charms.list.push({ favored: true });
  for (let i = 0; i < u; i++) S.charms.list.push({ favored: false });
  const got = S.charms.list.reduce((a, c) => a + calc.flatCost('charm', c.favored, splat), 0);
  eq(got, xlCharms(f, u), `W10 charms ${f}F/${u}NF`);
}

/* ---- W12 + W13: essence, including the -16 manual grant -------------- */
for (let n = 2; n <= 10; n++) {
  eq(calc.traitXp('essence', n, 0, false, splat), xlEssence(n), `W12 essence ${n}`);
}
// The spreadsheet's hardcoded W13 = -16 cancels Essence 3. Here: granted = 3.
eq(calc.traitXp('essence', 3, 3, false, splat), xlEssence(3) - 16, 'W12+W13 essence 3 granted');
eq(calc.traitXp('essence', 4, 3, false, splat), xlEssence(4) - 16, 'W12+W13 essence 4 granted 3');
eq(calc.traitXp('essence', 5, 3, false, splat), xlEssence(5) - 16, 'W12+W13 essence 5 granted 3');

/* ---- W16: spells (first spell of a bought circle is free) ------------ */
for (const favOccult of [false, true]) {
  for (const [t, c, s] of [[1, 0, 0], [3, 2, 1], [4, 4, 2]]) {
    const S = { circles: {}, spells: [] };
    for (let i = 0; i < t; i++) S.spells.push({ circle: 'terrestrial' });
    for (let i = 0; i < c; i++) S.spells.push({ circle: 'celestial' });
    for (let i = 0; i < s; i++) S.spells.push({ circle: 'solar' });
    // No circle bought: matches the spreadsheet, which charges every spell.
    eq(calc.spellsXp(S, splat, favOccult).total, xlSpells(t, c, s, favOccult),
       `W16 spells ${t}/${c}/${s}${favOccult ? ' favored Occult' : ''}`);
    // Circles bought: one spell per initiated circle comes free.
    S.circles = { terrestrial: t > 0, celestial: c > 0, solar: s > 0 };
    const freed = xlSpells(t > 0 ? 1 : 0, c > 0 ? 1 : 0, s > 0 ? 1 : 0, favOccult);
    eq(calc.spellsXp(S, splat, favOccult).total, xlSpells(t, c, s, favOccult) - freed,
       `W16 spells ${t}/${c}/${s} with free first spell`);
  }
}

/* ---- R15 * 3: specialties ------------------------------------------- */
for (let n = 0; n <= 6; n++) {
  eq(n * calc.flatCost('specialty', false, splat), xlSpecialty(n), `specialties ×${n}`);
}

/* ---- W18: a whole Dawn Caste character ------------------------------ */
const dawn = {
  splat: 'solar',
  caste: 'dawn',
  favored: { abilities: ['athletics', 'awareness', 'dodge', 'presence', 'resistance'], attributes: [] },
  attrs: {
    strength: { v: 4 }, dexterity: { v: 5 }, stamina: { v: 3 },
    charisma: { v: 3 }, manipulation: { v: 2 }, appearance: { v: 2 },
    perception: { v: 3 }, intelligence: { v: 2 }, wits: { v: 3 },
  },
  abils: {
    archery: { v: 3 }, melee: { v: 5, specialties: [{ name: 'Daiklave', v: 1 }] },
    thrown: { v: 2 }, war: { v: 3 },
    integrity: { v: 2 }, presence: { v: 3 }, resistance: { v: 3 }, survival: { v: 2 },
    athletics: { v: 3 }, awareness: { v: 4 }, dodge: { v: 4 },
    lore: { v: 2 }, occult: { v: 1 }, socialize: { v: 2 },
  },
  crafts: [], styles: [],
  virtues: { compassion: { v: 2 }, temperance: { v: 2 }, conviction: { v: 4 }, valor: { v: 4 } },
  willpower: { v: 7 },
  essence: { v: 3, granted: 3 },
  backgrounds: [{ name: 'Artifact', v: 3, granted: 2 }, { name: 'Resources', v: 2 }],
  charms: { list: Array.from({ length: 15 }, (_, i) => ({ favored: i < 10 })) },
  sorcery: { circles: {}, spells: [] },
  combos: [],
};

const casteAbils = ['archery', 'martial-arts', 'melee', 'thrown', 'war'];
const favAbils = new Set([...casteAbils, ...dawn.favored.abilities]);

let expAttr = 0;
for (const a of data.attributes) expAttr += xlAttr(dawn.attrs[a.id].v, false);

let expAbil = 0, expSpec = 0;
for (const a of data.abilities) {
  if (a.sub) continue;
  const t = dawn.abils[a.id] || { v: 0 };
  expAbil += xlAbil(t.v || 0, favAbils.has(a.id));
  for (const sp of t.specialties || []) expSpec += xlSpecialty(sp.v);
}
const expWill = xlWill(dawn.willpower.v);
const expVirtue = Object.values(dawn.virtues).reduce((a, v) => a + xlVirtue(v.v), 0);
const expEssence = xlEssence(dawn.essence.v) - xlEssence(3);
const expBg = (3 - 2) * 3 + 2 * 3;              // Artifact 2→3 granted, Resources 0→2
const expCharms = xlCharms(10, 5);

const got = calc.totalXp(dawn, splat, data);
eq(got.breakdown.attributes, expAttr, 'W18 attributes');
eq(got.breakdown.abilities, expAbil, 'W18 abilities');
eq(got.breakdown.specialties, expSpec, 'W18 specialties');
eq(got.breakdown.willpower, expWill, 'W18 willpower');
eq(got.breakdown.virtues, expVirtue, 'W18 virtues');
eq(got.breakdown.essence, expEssence, 'W18 essence (granted 3)');
eq(got.breakdown.backgrounds, expBg, 'W18 backgrounds');
eq(got.breakdown.charms, expCharms, 'W18 charms');
eq(got.total, expAttr + expAbil + expSpec + expWill + expVirtue + expEssence + expBg + expCharms,
   'W18 grand total');

/* ---- P14 / P16 / P17: derived --------------------------------------- */
const vs = calc.virtueStats(dawn.virtues);
eq(calc.mentalDV({ willpower: 7, integrity: 2, essence: 3 }).value, xlMdv(2, 7, 3), 'P14 MDV');
eq(calc.poolValue(splat.pools.personal, { essence: 3, willpower: 7, ...vs }).value,
   xlPersonal(3, 7), 'P16 personal essence');
eq(calc.poolValue(splat.pools.peripheral, { essence: 3, willpower: 7, ...vs }).value,
   xlPeripheral(3, 7, vs.virtuesSum), 'P17 peripheral essence');

/* ---- Deliberate deviations ------------------------------------------ */
// No refunds below a floor (the spreadsheet would hand back XP).
eq(calc.traitXp('attribute', 1, 0, false, splat), 0, 'no refund: attribute 1');
eq(calc.traitXp('essence', 1, 0, false, splat), 0, 'no refund: essence 1');
eq(calc.traitXp('willpower', 3, 0, false, splat), 0, 'no refund: willpower 3');
// Canonical Dodge DV: no stray +3.
eq(calc.dodgeDV({ dexterity: 5, dodge: 4, essence: 3 }).value, 6, 'canonical Dodge DV');
eq(calc.parryDV({ dexterity: 5, ability: 5, weaponDefense: 2 }).value, 6, 'canonical Parry DV');

/* --------------------------------------------------------------------- */
if (failures) {
  console.error(`\n${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`  ${checks} checks passed`);
