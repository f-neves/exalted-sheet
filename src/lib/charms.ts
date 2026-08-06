/**
 * The published Charm lists.
 *
 * The data lives in public/charms/ rather than in src/data/, so none of it is in
 * the bundle: a set is fetched the first time the picker shows it, and a set's
 * prose only when a charm is opened. Everything under public/charms is generated
 * by tools/build_charms.py from the PDFs; nothing here is hand-edited.
 */

export interface CharmMin { traits?: Record<string, number>; essence?: number; any?: number }

export interface Charm {
  id: string;
  /** Name. */
  n: string;
  /** Tree id. */
  t: string;
  min?: CharmMin;
  cost?: string;
  type?: string;
  /** Keywords. */
  kw?: string;
  /** Duration. */
  dur?: string;
  /** Prerequisite charms, as printed. */
  pre?: string;
  /** Prerequisites resolved to charm ids in the same set. */
  preIds?: string[];
  /** Source book. */
  src?: string;
  /** Page in the source PDF. */
  p?: number;
}

export interface Tree {
  id: string;
  name: string;
  /** Subtitle, e.g. a Sidereal tree's college. */
  sub?: string;
  /** Caste, Aspect, Attribute or other heading the tree sits under. */
  group?: string;
  /** Ability or Attribute this tree is bought against, when there is one. */
  trait?: string;
  traitKind?: 'ability' | 'attribute';
}

export interface CharmSet {
  id: string;
  name: string;
  kind: 'native' | 'martial-arts';
  /** Which Exalt type these are native to. */
  splat?: string;
  /** Which tier of martial arts. */
  tier?: 'terrestrial' | 'celestial' | 'sidereal';
  trees: Tree[];
  charms: Charm[];
}

export interface SetInfo {
  id: string; name: string; kind: 'native' | 'martial-arts';
  splat?: string; tier?: string; count: number; trees: number;
}

const BASE = import.meta.env.BASE_URL;
const sets = new Map<string, Promise<CharmSet>>();
const texts = new Map<string, Promise<Record<string, string>>>();
let index: Promise<SetInfo[]> | null = null;

async function grab<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}charms/${path}`);
  if (!res.ok) throw new Error(`charms: ${path} -> ${res.status}`);
  return res.json();
}

export function loadIndex(): Promise<SetInfo[]> {
  index = index || grab<{ sets: SetInfo[] }>('index.json').then((d) => d.sets)
    .catch((e) => { index = null; throw e; });
  return index;
}

export function loadSet(id: string): Promise<CharmSet> {
  if (!sets.has(id)) {
    sets.set(id, grab<CharmSet>(`${id}.json`)
      .then((set) => { ready.set(id, set); return set; })
      .catch((e) => { sets.delete(id); throw e; }));
  }
  return sets.get(id)!;
}

export function loadText(id: string): Promise<Record<string, string>> {
  if (!texts.has(id)) {
    texts.set(id, grab<Record<string, string>>(`${id}.text.json`)
      .catch((e) => { texts.delete(id); throw e; }));
  }
  return texts.get(id)!;
}

/** A set already fetched, for synchronous lookups during a render. */
const ready = new Map<string, CharmSet>();
export function cached(id: string): CharmSet | null { return ready.get(id) || null; }
export const warm = loadSet;

/**
 * The sets on offer, native one first.
 *
 * Every type may buy from every set: the Storyteller polices what a character can
 * actually learn, and the price is what changes here, not the availability.
 */
export function setsFor(splatId: string, all: SetInfo[]): SetInfo[] {
  const TIER: Record<string, number> = { terrestrial: 0, celestial: 1, sidereal: 2 };
  const rank = (s: SetInfo) => (s.splat === splatId ? 0 : s.kind === 'martial-arts' ? 1 : 2);
  return [...all].sort((a, b) =>
    rank(a) - rank(b)
    || (TIER[a.tier || ''] ?? 0) - (TIER[b.tier || ''] ?? 0)
    || a.name.localeCompare(b.name));
}

/**
 * Which XP price a set carries for this character.
 *
 * Sidereal Martial Arts have a price of their own; a type's own Charms and the
 * ordinary martial arts are Charms; anything else is an out-of-type Charm.
 */
export function categoryFor(set: { kind: string; splat?: string; tier?: string },
                            splatId: string): string {
  if (set.tier === 'sidereal') return 'sidereal-ma';
  if (set.kind === 'martial-arts') return 'native';
  return set.splat === splatId ? 'native' : 'other';
}

export interface Problem { kind: 'trait' | 'essence' | 'prereq'; text: string }

/**
 * What this character is short of for a charm. Never blocks a purchase: the sheet
 * says what is missing and leaves the decision to the table.
 */
export function problemsFor(
  charm: Charm,
  set: CharmSet,
  sheet: { abils: Record<string, any>; attrs: Record<string, any>; essence: { v: number };
           crafts?: any[]; owned: Set<string> },
  traitName: (id: string) => string,
): Problem[] {
  const out: Problem[] = [];
  const rating = (id: string) => {
    if (id === 'craft') {
      return (sheet.crafts || []).reduce((m: number, c: any) => Math.max(m, c?.v || 0), 0);
    }
    return sheet.abils[id]?.v ?? sheet.attrs[id]?.v ?? 0;
  };

  for (const [id, need] of Object.entries(charm.min?.traits || {})) {
    const has = rating(id);
    if (has < need) out.push({ kind: 'trait', text: `${traitName(id)} ${need} (you have ${has})` });
  }
  const ess = charm.min?.essence || 0;
  if (ess && (sheet.essence?.v || 0) < ess) {
    out.push({ kind: 'essence', text: `Essence ${ess} (you have ${sheet.essence?.v || 0})` });
  }
  const missing = (charm.preIds || []).filter((id) => !sheet.owned.has(`${set.id}:${id}`));
  if (missing.length) {
    const names = missing.map((id) => set.charms.find((c) => c.id === id)?.n || id);
    out.push({ kind: 'prereq', text: `${names.join(', ')} first` });
  }
  return out;
}

/** "Melee 3, Essence 2" from the parsed minimums, for a compact row. */
export function minsLabel(charm: Charm, traitName: (id: string) => string): string {
  const parts = Object.entries(charm.min?.traits || {}).map(([id, n]) => `${traitName(id)} ${n}`);
  if (charm.min?.any) parts.push(`(Ability) ${charm.min.any}`);
  if (charm.min?.essence) parts.push(`Essence ${charm.min.essence}`);
  return parts.join(', ');
}
