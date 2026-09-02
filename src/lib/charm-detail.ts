/**
 * One Charm, written out in full.
 *
 * The picker and the sheet both need this, and they must not drift: a Charm read
 * before it is bought and the same Charm read afterwards should say the same words.
 * So the markup lives here and both call it.
 */
import { minsLabel, type Charm, type CharmSet } from './charms';

export const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const PRICE: Record<string, string> = {
  'sidereal-ma': 'Sidereal Martial Arts',
  other: 'out-of-type Charm',
  native: 'Charm',
};

/** Cost, minimums, type, keywords, duration and prerequisites, as printed. */
export function statLine(charm: Charm, traitName: (id: string) => string): string {
  const mins = minsLabel(charm, traitName);
  return [
    charm.cost && `<b>Cost:</b> ${esc(charm.cost)}`,
    mins && `<b>Mins:</b> ${esc(mins)}`,
    charm.type && `<b>Type:</b> ${esc(charm.type)}`,
    charm.kw && `<b>Keywords:</b> ${esc(charm.kw)}`,
    charm.dur && `<b>Duration:</b> ${esc(charm.dur)}`,
    charm.pre && `<b>Prerequisites:</b> ${esc(charm.pre)}`,
  ].filter(Boolean).join(' · ');
}

export interface DetailOpts {
  traitName: (id: string) => string;
  /** The prose, once fetched. Absent means it is still on its way. */
  prose?: string;
  /** Which XP price this Charm carries here. Omit to leave the line off. */
  category?: string;
  /** Extra classes on the wrapper, so each host can position it. */
  className?: string;
}

/** The whole block: statistics, rules text, and where it was printed. */
export function detailHtml(charm: Charm, set: CharmSet | null, opts: DetailOpts): string {
  const src = `${esc(charm.src || set?.name || '')}${charm.p ? `, p. ${charm.p}` : ''}`;
  const price = opts.category ? ` · costs the ${PRICE[opts.category] || 'Charm'} price` : '';
  return `<div class="cp-detail${opts.className ? ' ' + opts.className : ''}">`
    + `<p class="cp-stat">${statLine(charm, opts.traitName)}</p>`
    + `<p class="cp-prose">${opts.prose ? esc(opts.prose) : 'Loading the text…'}</p>`
    + (src || price ? `<p class="cp-src">${src}${price}</p>` : '')
    + `</div>`;
}

/**
 * How deep a Charm sits in its tree, counting only prerequisites inside that tree.
 *
 * A Charm tree is a directed graph, not a line, and reading one in the order the book
 * printed it tells you nothing about what opens what. Depth turns it into tiers: 0 is
 * an entry point, and everything else waits on something above it. Cycles cannot
 * happen in a well-formed tree, but a bad parse could produce one, so the walk keeps
 * a visited set rather than trusting the data.
 */
export function depths(set: CharmSet, treeId: string): Map<string, number> {
  const inTree = new Map(set.charms.filter((c) => c.t === treeId).map((c) => [c.id, c]));
  const out = new Map<string, number>();

  const walk = (id: string, seen: Set<string>): number => {
    if (out.has(id)) return out.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const pres = (inTree.get(id)?.preIds || []).filter((p) => inTree.has(p));
    const d = pres.length ? 1 + Math.max(...pres.map((p) => walk(p, seen))) : 0;
    out.set(id, d);
    return d;
  };

  for (const id of inTree.keys()) walk(id, new Set());
  return out;
}
