/**
 * Pure formula library for the Exalted 2e sheet. No DOM, no imports.
 *
 * Every function takes the splat config (src/data/splats/*.json) and, where relevant,
 * the shared rules (src/data/rules.json) as explicit arguments, so this file can be
 * loaded identically by Astro/Vite and by the plain Node test scripts.
 *
 * Derived stats return { value, formula } — `formula` is the human-readable working
 * with the real numbers substituted, which the engine drops into the data-calc tooltip.
 */

const ceil = Math.ceil;
const floor = Math.floor;

/* ------------------------------------------------------------------ *
 * XP
 * ------------------------------------------------------------------ */

/**
 * Cost of the single dot that takes a trait from (v-1) to v.
 * Ability dot 1 is a flat "new ability" price; everything else is mult*(v-1) + base.
 */
export function dotCost(kind, v, favored, splat) {
  const cfg = splat.xp[kind];
  if (!cfg) return 0;
  if (v <= 0) return 0;
  if (v === 1 && cfg.firstDot !== undefined) {
    return favored && cfg.favoredFirstDot !== undefined ? cfg.favoredFirstDot : cfg.firstDot;
  }
  const spec = (favored && cfg.favored) || cfg.normal;
  if (!spec) return 0;
  return spec.mult * (v - 1) + spec.base;
}

/** Total cost of every dot from 1 up to `rating`, ignoring floors and grants. */
export function cumulativeCost(kind, rating, favored, splat) {
  let c = 0;
  for (let v = 1; v <= rating; v++) c += dotCost(kind, v, favored, splat);
  return c;
}

/**
 * XP actually owed for a trait.
 *
 * Dots up to max(floor, granted) are free — `floor` is the splat's baseline, `granted`
 * is what the Storyteller handed the character. Everything above that is paid for.
 */
export function traitXp(kind, rating, granted, favored, splat) {
  const r = Math.max(0, rating || 0);
  const base = Math.max(splat.floors?.[kind] ?? 0, granted || 0);
  const free = Math.min(base, r);
  return cumulativeCost(kind, r, favored, splat) - cumulativeCost(kind, free, favored, splat);
}

/** Flat per-item cost (specialty, charm, combo). */
export function flatCost(kind, favored, splat) {
  const cfg = splat.xp[kind];
  if (cfg === undefined) return 0;
  if (typeof cfg === 'number') return cfg;
  return (favored && cfg.favored !== undefined ? cfg.favored : cfg.normal) || 0;
}

/** Cost of one spell of the given circle. */
export function spellCost(circleId, favoredOccult, splat) {
  const cfg = splat.xp.spell?.[circleId];
  if (cfg === undefined) return 0;
  if (typeof cfg === 'number') return cfg;
  return (favoredOccult && cfg.favored !== undefined ? cfg.favored : cfg.normal) || 0;
}

/* ------------------------------------------------------------------ *
 * Favored / caste resolution
 * ------------------------------------------------------------------ */

export function casteTraits(splat, casteId) {
  if (splat.casteKind === 'none') return [];
  const caste = (splat.castes || []).find((c) => c.id === casteId);
  return caste ? caste.traits || [] : [];
}

/** The favored config for one kind of trait, or null when the type cannot favor it. */
export function favoredConfig(splat, kind) {
  return (kind === 'ability' ? splat.favoredAbilities : splat.favoredAttributes) || null;
}

export function isCaste(traitId, kind, splat, casteId) {
  if (kind !== splat.casteKind) return false;
  return casteTraits(splat, casteId).includes(traitId);
}

/**
 * Is `traitId` favored for XP purposes?
 *
 * Caste traits always are. Beyond those, each kind has its own `always` list (Survival for
 * every Lunar) and its own free picks, so a Lunar can hold caste Attributes and favored
 * Abilities at the same time.
 */
export function isFavored(traitId, kind, splat, casteId, picks) {
  if (isCaste(traitId, kind, splat, casteId)) return true;
  const cfg = favoredConfig(splat, kind);
  if (!cfg) return false;
  if ((cfg.always || []).includes(traitId)) return true;
  return (picks || []).includes(traitId);
}

/** Ability layout: explicit when given, otherwise the caste list. */
export function abilityGroups(splat) {
  if (Array.isArray(splat.abilityGroups) && splat.abilityGroups.length) return splat.abilityGroups;
  if (splat.casteKind === 'ability') {
    return (splat.castes || []).map((c) => ({ id: c.id, name: c.name, abilities: c.traits || [] }));
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Essence pools
 * ------------------------------------------------------------------ */

/**
 * Evaluate a linear coefficient map against the character's numbers.
 * Recognised keys: essence, willpower, virtuesSum, highestVirtue, twoHighestVirtues,
 * lowestVirtue, breeding, flat.
 */
export function poolValue(coeffs, ctx) {
  const parts = [];
  let total = 0;
  const add = (key, label) => {
    const c = coeffs[key];
    if (!c) return;
    const raw = ctx[key] || 0;
    total += c * raw;
    parts.push(c === 1 ? `${label} ${raw}` : `${label} ${raw} × ${c}`);
  };
  add('essence', 'Essence');
  add('willpower', 'Willpower');
  add('virtuesSum', 'Virtues');
  add('twoHighestVirtues', 'Two highest Virtues');
  add('highestVirtue', 'Highest Virtue');
  add('lowestVirtue', 'Lowest Virtue');
  add('breeding', 'Breeding');
  if (coeffs.flat) {
    total += coeffs.flat;
    parts.push(String(coeffs.flat));
  }
  return { value: total, formula: `${parts.join(' + ')} = ${total}` };
}

export function virtueStats(virtues) {
  const vals = Object.values(virtues || {}).map((v) => (typeof v === 'object' ? v.v : v) || 0);
  const sorted = [...vals].sort((a, b) => b - a);
  return {
    virtuesSum: vals.reduce((a, b) => a + b, 0),
    highestVirtue: sorted[0] || 0,
    twoHighestVirtues: (sorted[0] || 0) + (sorted[1] || 0),
    lowestVirtue: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Defence values (canonical 2e — always round UP)
 * ------------------------------------------------------------------ */

export function dodgeDV({ dexterity, dodge, essence, mobility = 0, bonus = 0 }) {
  const raw = ceil((dexterity + dodge + essence) / 2);
  const value = Math.max(0, raw - Math.abs(mobility) + bonus);
  let f = `⌈(Dexterity ${dexterity} + Dodge ${dodge} + Essence ${essence}) ÷ 2⌉ = ${raw}`;
  if (mobility) f += ` − mobility ${Math.abs(mobility)}`;
  if (bonus) f += ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}`;
  return { value, formula: `${f} = ${value}` };
}

export function parryDV({ dexterity, ability, abilityName = 'Ability', weaponDefense = 0, mobility = 0, bonus = 0 }) {
  const raw = ceil((dexterity + ability + weaponDefense) / 2);
  const value = Math.max(0, raw - Math.abs(mobility) + bonus);
  let f = `⌈(Dexterity ${dexterity} + ${abilityName} ${ability} + weapon Defense ${weaponDefense}) ÷ 2⌉ = ${raw}`;
  if (mobility) f += ` − mobility ${Math.abs(mobility)}`;
  if (bonus) f += ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}`;
  return { value, formula: `${f} = ${value}` };
}

export function mentalDV({ willpower, integrity, essence, bonus = 0 }) {
  const raw = ceil((willpower + integrity + essence) / 2);
  const value = Math.max(0, raw + bonus);
  let f = `⌈(Willpower ${willpower} + Integrity ${integrity} + Essence ${essence}) ÷ 2⌉ = ${raw}`;
  if (bonus) f += ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}`;
  return { value, formula: `${f} = ${value}` };
}

/* ------------------------------------------------------------------ *
 * Soak & hardness
 * ------------------------------------------------------------------ */

export function soak({ stamina, armorB = 0, armorL = 0, armorA = 0 }, splat) {
  const c = splat.soak || { bashing: 1, lethal: 0.5, aggravated: 1 };
  const mk = (mult, armor, label) => {
    const nat = floor(stamina * mult);
    const value = nat + armor;
    const natTxt = mult === 1 ? `Stamina ${stamina}` : `⌊Stamina ${stamina} × ${mult}⌋ = ${nat}`;
    return { value, formula: `${natTxt}${armor ? ` + armour ${armor}` : ''} = ${value} ${label}` };
  };
  return {
    bashing: mk(c.bashing, armorB, 'B'),
    lethal: mk(c.lethal, armorL, 'L'),
    aggravated: mk(c.aggravated, armorA, 'A'),
  };
}

/* ------------------------------------------------------------------ *
 * Combat pools
 * ------------------------------------------------------------------ */

export function attackPool({ attribute, attributeName = 'Dexterity', ability, abilityName = 'Ability',
                             accuracy = 0, specialty = 0, wound = 0, fatigue = 0, bonus = 0 }) {
  const value = Math.max(0, attribute + ability + accuracy + specialty + bonus - Math.abs(wound) - Math.abs(fatigue));
  const parts = [`${attributeName} ${attribute}`, `${abilityName} ${ability}`];
  if (accuracy) parts.push(`Accuracy ${accuracy > 0 ? '+' : ''}${accuracy}`);
  if (specialty) parts.push(`specialty +${specialty}`);
  if (bonus) parts.push(`bonus ${bonus > 0 ? '+' : ''}${bonus}`);
  let f = parts.join(' + ');
  if (wound) f += ` − wound ${Math.abs(wound)}`;
  if (fatigue) f += ` − fatigue ${Math.abs(fatigue)}`;
  return { value, formula: `${f} = ${value} dice` };
}

export function rawDamage({ strength, damage = 0, damageType = 'L', bonus = 0 }) {
  const value = Math.max(0, strength + damage + bonus);
  let f = `Strength ${strength} + weapon ${damage > 0 ? '+' : ''}${damage}`;
  if (bonus) f += ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}`;
  return { value, formula: `${f} = ${value}${damageType}` };
}

export function joinBattle({ wits, awareness, bonus = 0 }) {
  const value = wits + awareness + bonus;
  return { value, formula: `Wits ${wits} + Awareness ${awareness}${bonus ? ` + ${bonus}` : ''} = ${value} dice` };
}

export function movement({ dexterity }, rules) {
  const m = rules.movement.move;
  const d = rules.movement.dash;
  const move = dexterity * m.dexterity + m.base;
  const dash = dexterity * d.dexterity + d.base;
  return {
    move: { value: move, formula: `Dexterity ${dexterity} + ${m.base} = ${move} yards/tick` },
    dash: { value: dash, formula: `Dexterity ${dexterity} + ${d.base} = ${dash} yards/tick` },
  };
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

/** Expand the health track into one entry per box, honouring Ox-Body extra levels. */
export function healthLevels(rules, extras = {}) {
  const out = [];
  for (const lvl of rules.healthTrack) {
    const n = lvl.count + (extras[lvl.id] || 0);
    for (let i = 0; i < n; i++) out.push({ id: lvl.id, label: lvl.label, penalty: lvl.penalty });
  }
  return out;
}

/**
 * Wound penalty for the deepest filled box. Damage fills from the top of the track.
 * Returns 0 when unhurt and the Incapacitated flag once the track is full.
 */
export function woundPenalty(levels, damageTaken) {
  const hurt = Math.max(0, Math.min(damageTaken, levels.length));
  if (hurt === 0) return { value: 0, incapacitated: false, label: '-0' };
  const idx = Math.min(hurt - 1, levels.length - 1);
  const lvl = levels[idx];
  const incapacitated = lvl.penalty === null || hurt >= levels.length;
  return { value: lvl.penalty === null ? 0 : lvl.penalty, incapacitated, label: lvl.label };
}

/* ------------------------------------------------------------------ *
 * Sorcery
 * ------------------------------------------------------------------ */

/**
 * Spell XP. Each purchased circle grants its first spell free, so only spells beyond
 * the first in each initiated circle are charged.
 */
export function spellsXp(sorceryState, splat, favoredOccult) {
  const counts = {};
  for (const s of sorceryState.spells || []) {
    if (!s || !s.circle) continue;
    counts[s.circle] = (counts[s.circle] || 0) + 1;
  }
  let total = 0;
  const detail = [];
  for (const circle of splat.sorcery?.circles || []) {
    const bought = !!sorceryState.circles?.[circle.id];
    const n = counts[circle.id] || 0;
    const charged = bought ? Math.max(0, n - 1) : n;
    const each = spellCost(circle.id, favoredOccult, splat);
    const xp = charged * each;
    total += xp;
    if (n || bought) detail.push({ circle: circle.id, name: circle.name, spells: n, free: bought ? Math.min(1, n) : 0, charged, each, xp });
  }
  return { total, detail };
}

/* ------------------------------------------------------------------ *
 * Full XP roll-up
 * ------------------------------------------------------------------ */

/**
 * Total XP for a character, broken down by category.
 * `data` supplies the trait lists: { attributes, abilities, virtues }.
 */
export function totalXp(S, splat, data) {
  const picksAbil = S.favored?.abilities || [];
  const picksAttr = S.favored?.attributes || [];
  const b = { attributes: 0, abilities: 0, specialties: 0, virtues: 0, willpower: 0,
              essence: 0, backgrounds: 0, charms: 0, spells: 0, combos: 0, adjustment: 0 };

  for (const a of data.attributes) {
    const t = S.attrs?.[a.id] || {};
    const fav = isFavored(a.id, 'attribute', splat, S.caste, picksAttr);
    b.attributes += traitXp('attribute', t.v, t.granted, fav, splat);
  }

  const abilityEntry = (id, t) => {
    const fav = isFavored(id, 'ability', splat, S.caste, picksAbil);
    b.abilities += traitXp('ability', t.v, t.granted, fav, splat);
    for (const sp of t.specialties || []) {
      b.specialties += (sp.v || 0) * flatCost('specialty', fav, splat);
    }
  };
  for (const a of data.abilities) {
    // Craft carries no rating of its own: the dots live on the individual Craft types,
    // and the Craft row only marks whether the whole group is caste or favored.
    if (a.sub) continue;
    abilityEntry(a.id, S.abils?.[a.id] || {});
  }
  for (const c of S.crafts || []) abilityEntry('craft', c);

  for (const v of data.virtues) {
    const t = S.virtues?.[v.id] || {};
    b.virtues += traitXp('virtue', t.v, t.granted, false, splat);
  }

  b.willpower = traitXp('willpower', S.willpower?.v, S.willpower?.granted, false, splat);
  b.essence = traitXp('essence', S.essence?.v, S.essence?.granted, false, splat);

  for (const bg of S.backgrounds || []) {
    b.backgrounds += traitXp('background', bg.v, bg.granted, false, splat);
  }

  const favOccult = isFavored(splat.sorcery?.favoredAbility || 'occult', 'ability', splat, S.caste, picksAbil);

  const circles = S.sorcery?.circles || {};
  const circlesBought = Object.values(circles).filter(Boolean).length;
  for (const ch of S.charms?.list || []) {
    b.charms += flatCost('charm', !!ch.favored, splat);
  }
  // Circle initiations are Occult Charms, so they follow the favoured-Occult price.
  b.charms += circlesBought * flatCost('charm', favOccult, splat);

  b.spells = spellsXp(S.sorcery || {}, splat, favOccult).total;

  for (const c of S.combos || []) b.combos += c.xp || 0;

  b.adjustment = S.adjustment || 0;

  const total = Object.values(b).reduce((a, x) => a + x, 0);
  return { breakdown: b, total };
}
