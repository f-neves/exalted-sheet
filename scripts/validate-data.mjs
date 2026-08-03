/**
 * Build gate over src/data. Catches the mistakes that are easy to make when hand-editing
 * the splat files: a typo'd Ability id in a caste list, a missing XP entry, a pool
 * coefficient keyed on something the engine doesn't understand.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const stepSpec = z.object({ mult: z.number(), base: z.number() });
const costSpec = z.object({ normal: z.number(), favored: z.number().optional() });

const traitSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
});

const attributeSchema = traitSchema.extend({
  group: z.enum(['physical', 'social', 'mental']),
});

const abilitySchema = traitSchema.extend({
  group: z.string(),
  attr: z.string(),
  sub: z.string().optional(),
});

const POOL_KEYS = ['essence', 'willpower', 'virtuesSum', 'highestVirtue',
                   'twoHighestVirtues', 'lowestVirtue', 'breeding', 'flat'];
const poolSchema = z.record(z.enum(POOL_KEYS), z.number());

const splatSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  order: z.number().int(),
  verified: z.boolean(),
  casteLabel: z.string().min(1),
  casteKind: z.enum(['ability', 'attribute', 'none']),
  favoredAbilities: z.object({ picks: z.number().int().min(0), always: z.array(z.string()) }),
  favoredAttributes: z.object({ picks: z.number().int().min(0), always: z.array(z.string()) }),
  craftTypes: z.array(z.string().min(1)),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentSoft: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  castes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    traits: z.array(z.string()),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    yozi: z.string().optional(),
  })),
  abilityGroups: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    abilities: z.array(z.string()),
  })).optional(),
  maxRating: z.record(z.string(), z.number().int().min(1)).optional(),
  floors: z.object({
    attribute: z.number().int().min(0),
    ability: z.number().int().min(0),
    virtue: z.number().int().min(0),
    willpower: z.number().int().min(0),
    essence: z.number().int().min(0),
    background: z.number().int().min(0),
  }),
  xp: z.object({
    attribute: z.object({ normal: stepSpec, favored: stepSpec.optional() }),
    ability: z.object({
      firstDot: z.number(), favoredFirstDot: z.number().optional(),
      normal: stepSpec, favored: stepSpec.optional(),
    }),
    virtue: z.object({ normal: stepSpec, favored: stepSpec.optional() }),
    willpower: z.object({ normal: stepSpec, favored: stepSpec.optional() }),
    essence: z.object({ normal: stepSpec, favored: stepSpec.optional() }),
    background: z.object({ normal: stepSpec, favored: stepSpec.optional() }),
    specialty: costSpec,
    charm: costSpec,
    knack: costSpec.optional(),
    combo: costSpec,
    spell: z.record(z.string(), costSpec),
  }),
  sorcery: z.object({
    favoredAbility: z.string(),
    circles: z.array(z.object({
      id: z.string(), name: z.string(), kind: z.enum(['sorcery', 'necromancy']),
    })),
  }),
  pools: z.object({ personal: poolSchema, peripheral: poolSchema }),
  soak: z.object({ bashing: z.number(), lethal: z.number(), aggravated: z.number() }),
  limit: z.object({
    enabled: z.boolean(), label: z.string(), boxes: z.number().int().min(1), breakLabel: z.string(),
  }),
  anima: z.array(z.object({ range: z.string(), text: z.string() })),
}).passthrough();

const errors = [];
const warnings = [];

const attributes = z.array(attributeSchema).parse(read('src/data/attributes.json'));
const abilities = z.array(abilitySchema).parse(read('src/data/abilities.json'));
const virtues = z.array(traitSchema.extend({ flaw: z.string() })).parse(read('src/data/virtues.json'));
z.array(traitSchema.extend({ splats: z.array(z.string()).optional() })).parse(read('src/data/backgrounds.json'));
const rules = read('src/data/rules.json');

if (abilities.length !== 25) errors.push(`abilities.json: expected 25 abilities, found ${abilities.length}`);
if (attributes.length !== 9) errors.push(`attributes.json: expected 9 attributes, found ${attributes.length}`);
if (virtues.length !== 4) errors.push(`virtues.json: expected 4 virtues, found ${virtues.length}`);

const attrIds = new Set(attributes.map((a) => a.id));
const abilIds = new Set(abilities.map((a) => a.id));
for (const a of abilities) {
  if (!attrIds.has(a.attr)) errors.push(`abilities.json: "${a.id}" points at unknown attribute "${a.attr}"`);
}
for (const a of rules.attackAbilities) {
  if (!abilIds.has(a.id)) errors.push(`rules.json: attackAbilities "${a.id}" is not an ability`);
}

const splatDir = join(ROOT, 'src/data/splats');
const files = readdirSync(splatDir).filter((f) => f.endsWith('.json'));
if (files.length !== 7) errors.push(`splats: expected 7 files, found ${files.length}`);

for (const f of files) {
  const label = `splats/${f}`;
  let splat;
  try {
    splat = splatSchema.parse(read(`src/data/splats/${f}`));
  } catch (e) {
    errors.push(`${label}: ${e.errors ? e.errors.map((x) => `${x.path.join('.')} ${x.message}`).join('; ') : e.message}`);
    continue;
  }
  if (splat.id !== f.replace(/\.json$/, '')) errors.push(`${label}: id "${splat.id}" does not match the filename`);

  if (splat.casteKind === 'none') {
    if (splat.castes.length) errors.push(`${label}: casteKind is "none" but castes is not empty`);
    if (!splat.abilityGroups) errors.push(`${label}: casteKind is "none", so abilityGroups is required`);
  } else if (!splat.castes.length) {
    errors.push(`${label}: casteKind is "${splat.casteKind}" but no castes are defined`);
  }

  const valid = splat.casteKind === 'attribute' ? attrIds : abilIds;
  const seen = new Set();
  for (const caste of splat.castes) {
    for (const t of caste.traits) {
      if (!valid.has(t)) errors.push(`${label}: caste "${caste.id}" lists unknown ${splat.casteKind} "${t}"`);
      if (seen.has(t)) warnings.push(`${label}: "${t}" appears in more than one caste`);
      seen.add(t);
    }
    if (caste.traits.length === 0) warnings.push(`${label}: caste "${caste.id}" has no caste ${splat.casteKind}s`);
  }

  for (const id of splat.favoredAbilities.always) {
    if (!abilIds.has(id)) errors.push(`${label}: favoredAbilities.always names unknown ability "${id}"`);
  }
  for (const id of splat.favoredAttributes.always) {
    if (!attrIds.has(id)) errors.push(`${label}: favoredAttributes.always names unknown attribute "${id}"`);
  }

  // The Abilities block must lay out all 25 abilities exactly once, whether the layout is
  // explicit or inherited from the caste list.
  const groups = splat.abilityGroups
    || (splat.casteKind === 'ability' ? splat.castes.map((c) => ({ id: c.id, name: c.name, abilities: c.traits })) : null);
  if (!groups) {
    errors.push(`${label}: no ability layout — add abilityGroups`);
  } else {
    const laid = groups.flatMap((g) => g.abilities);
    for (const id of laid) {
      if (!abilIds.has(id)) errors.push(`${label}: abilityGroups names unknown ability "${id}"`);
    }
    const dupes = laid.filter((id, i) => laid.indexOf(id) !== i);
    if (dupes.length) errors.push(`${label}: abilities laid out more than once: ${[...new Set(dupes)].join(', ')}`);
    const missing = [...abilIds].filter((id) => !laid.includes(id));
    if (missing.length) errors.push(`${label}: abilities missing from the layout: ${missing.join(', ')}`);
  }

  for (const c of splat.sorcery.circles) {
    if (splat.xp.spell[c.id] === undefined) errors.push(`${label}: circle "${c.id}" has no xp.spell entry`);
  }
  for (const id of Object.keys(splat.xp.spell)) {
    if (!splat.sorcery.circles.some((c) => c.id === id)) {
      warnings.push(`${label}: xp.spell has "${id}" but no such sorcery circle`);
    }
  }
  if (!splat.verified) warnings.push(`${label}: marked verified:false — numbers still need checking against your table`);
}

for (const w of warnings) console.warn(`  warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  ERROR ${e}`);
  console.error(`\ndata validation failed: ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`data ok — ${files.length} splats, ${abilities.length} abilities, ${attributes.length} attributes${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
