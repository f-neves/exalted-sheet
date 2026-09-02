/**
 * Exalted 2e sheet engine.
 *
 * Markup lives in src/components/SheetSkeleton.astro; formulas live in src/lib/calc.js.
 * This file owns state, rendering and events, and nothing else.
 *
 * Persistence is injected, so the same engine can be driven by localStorage today and
 * a server-backed store later without changing anything here.
 */
import * as calc from './calc.js';
import * as charmData from './charms';
import { SPLATS, SPLAT_BY_ID, DATA, RULES, BACKGROUNDS, ATTRIBUTE_GROUPS } from './data';

export interface PortraitPos { x: number; y: number; z: number }

export interface GalleryItem { id: string; name: string; kind: 'file' | 'link'; open: () => void | Promise<void> }

/**
 * Optional storage for the portrait and gallery. Left out (the offline /sheet), the whole
 * block stays hidden; supplied (/character), it drives Supabase Storage. Same idea as
 * load/save: the engine never learns where anything lives.
 */
export interface MediaAdapter {
  canEdit: boolean;
  getPortrait: () => Promise<{ url: string; pos: PortraitPos } | null>;
  setPortrait: (file: File) => Promise<{ url: string } | null>;
  clearPortrait: () => Promise<void>;
  savePortraitPos: (pos: PortraitPos) => void;
  listItems: () => Promise<GalleryItem[]>;
  addFile: (file: File) => Promise<void>;
  addLink: () => Promise<void>;
  removeItem: (id: string) => Promise<void>;
}

export interface SheetOpts {
  load: () => any | null | Promise<any | null>;
  save: (state: any) => void;
  budgetLocked?: boolean;
  budgetValue?: number | null;
  onReset?: () => void;
  readOnly?: boolean;
  media?: MediaAdapter;
  /** Fires after every recalculation, so pages need not scrape the XP bar. */
  onChange?: (info: { spent: number; budget: number; remaining: number }) => void;
}

const SCHEMA = 2;

export function mountSheet(opts: SheetOpts) {
  let S: any = {};
  let booting = true;

  /* ------------------------------------------------------------ utils */
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const esc = (s: any) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  const num = (v: any, d = 0) => (Number.isFinite(+v) ? +v : d);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const splat = () => SPLAT_BY_ID[S.splat] || SPLATS[0];
  const abilityById = (id: string) => DATA.abilities.find((a) => a.id === id);
  const ro = () => !!opts.readOnly;

  /** How many dots a row draws. A splat may override the shared cap (mortal Essence 3). */
  const dotMax = (kind: string) =>
    (splat().maxRating?.[kind] ?? (RULES.maxRating as any)[kind] ?? 5) as number;
  const picksFor = (kind: string) =>
    (kind === 'ability' ? S.favored.abilities : S.favored.attributes) as string[];

  /** Does this Background name appear on the mystic list? */
  const isMysticName = (name: string) => {
    const hit = BACKGROUNDS.find((b: any) => b.name.toLowerCase() === name.trim().toLowerCase());
    return !!hit?.mystic;
  };

  /* ------------------------------------------------------ default state */

  /** Craft has no rating of its own; each Craft type is a full Ability. */
  function seedCrafts(sp: any) {
    return (sp.craftTypes || []).map((name: string) => ({
      name, v: sp.floors.ability, granted: 0, specialties: [],
    }));
  }

  function fresh() {
    const sp = SPLAT_BY_ID[RULES.defaultSplat] || SPLATS[0];
    const st: any = {
      meta: { schema: SCHEMA },
      id: { name: '', player: '', concept: '', motivation: '', anima: '', sobriquet: '' },
      splat: sp.id,
      caste: sp.castes[0]?.id || '',
      favored: { abilities: [], attributes: [] },
      attrs: {},
      abils: {},
      crafts: seedCrafts(sp),
      virtues: {},
      virtueFlaw: '',
      limit: 0,
      willpower: { v: sp.floors.willpower, granted: 0 },
      willpowerTemp: sp.floors.willpower,
      essence: { v: sp.floors.essence, granted: 0 },
      backgrounds: [],
      charms: { list: [] },
      combos: [],
      colleges: [],
      thaumaturgy: [],
      mutations: [],
      meritsFlaws: [],
      sorcery: { circles: {}, spells: [] },
      commitments: [],
      health: { extras: {}, marks: [] },
      weapons: [],
      armor: [],
      notes: { intimacies: '', backstory: '', gear: '' },
      budget: RULES.defaultBudget,
      adjustment: 0,
    };
    for (const a of DATA.attributes) st.attrs[a.id] = { v: sp.floors.attribute, granted: 0 };
    for (const a of DATA.abilities) {
      if (a.sub) continue;
      st.abils[a.id] = { v: sp.floors.ability, granted: 0, specialties: [] };
    }
    for (const v of DATA.virtues) st.virtues[v.id] = { v: sp.floors.virtue, granted: 0 };
    return st;
  }

  /** Backfill and repair anything missing, so old saves keep working. */
  function normalize(raw: any) {
    const st = fresh();
    if (!raw || typeof raw !== 'object') return st;

    if (SPLAT_BY_ID[raw.splat]) st.splat = raw.splat;
    const sp = SPLAT_BY_ID[st.splat];
    st.caste = sp.castes.some((c: any) => c.id === raw.caste) ? raw.caste : (sp.castes[0]?.id || '');

    Object.assign(st.id, raw.id || {});
    st.favored = {
      abilities: Array.isArray(raw.favored?.abilities) ? raw.favored.abilities.slice() : [],
      attributes: Array.isArray(raw.favored?.attributes) ? raw.favored.attributes.slice() : [],
    };

    const trait = (src: any, floor: number, withSpec = false) => {
      const t: any = {
        v: clamp(num(src?.v, floor), 0, 20),
        granted: clamp(num(src?.granted, 0), 0, 20),
      };
      if (withSpec) {
        t.specialties = (Array.isArray(src?.specialties) ? src.specialties : [])
          .map((s: any) => ({ name: String(s?.name ?? ''), v: clamp(num(s?.v, 1), 0, RULES.maxRating.specialty) }));
      }
      return t;
    };

    for (const a of DATA.attributes) st.attrs[a.id] = trait(raw.attrs?.[a.id], sp.floors.attribute);
    for (const a of DATA.abilities) {
      if (a.sub) continue;
      st.abils[a.id] = trait(raw.abils?.[a.id], sp.floors.ability, true);
    }
    for (const v of DATA.virtues) st.virtues[v.id] = trait(raw.virtues?.[v.id], sp.floors.virtue);

    // Craft types: keep whatever the character has, then top up with any of this splat's
    // standard types that are missing, so switching Exalt type never drops a rating.
    const seen = new Set<string>();
    st.crafts = (Array.isArray(raw.crafts) ? raw.crafts : []).map((c: any) => {
      const name = String(c?.name ?? '');
      seen.add(name.toLowerCase());
      return { name, ...trait(c, sp.floors.ability, true) };
    });
    for (const c of seedCrafts(sp)) {
      if (!seen.has(c.name.toLowerCase())) st.crafts.push(c);
    }

    // Schema 1 tracked Martial Arts as a list of styles; it is a plain Ability now.
    if (Array.isArray(raw.styles) && raw.styles.length) {
      const best = raw.styles.reduce((m: number, s: any) => Math.max(m, num(s?.v, 0)), 0);
      if (best > st.abils['martial-arts'].v) st.abils['martial-arts'].v = best;
    }

    st.virtueFlaw = String(raw.virtueFlaw ?? '');
    st.limit = clamp(num(raw.limit, 0), 0, sp.limit.boxes);
    st.willpower = trait(raw.willpower, sp.floors.willpower);
    st.essence = trait(raw.essence, sp.floors.essence);
    st.willpowerTemp = clamp(num(raw.willpowerTemp, st.willpower.v), 0, 20);

    st.backgrounds = (Array.isArray(raw.backgrounds) ? raw.backgrounds : []).map((b: any) => {
      const name = String(b?.name ?? '');
      // Schema 2 had no mystic flag: infer it from the name the first time round.
      const mystic = b?.mystic === undefined ? isMysticName(name) : !!b.mystic;
      return { name, mystic, ...trait(b, sp.floors.background) };
    });

    const CATS = new Set(calc.CHARM_CATEGORIES.map((c: any) => c.id));
    st.charms = {
      list: (Array.isArray(raw.charms?.list) ? raw.charms.list : []).map((c: any) => ({
        name: String(c?.name ?? ''), favored: !!c?.favored,
        category: CATS.has(c?.category) ? c.category : 'native',
        // Granted Charms show on the sheet and cost no XP. Absent on older saves, which
        // is the right default: everything was paid for before this existed.
        granted: !!c?.granted,
        note: String(c?.note ?? ''),
        // Set here, a charm came from the published lists and can be checked
        // against its minimums. Absent, it is a free-text row, as before.
        set: c?.set ? String(c.set) : '',
        cid: c?.cid ? String(c.cid) : '',
        tree: c?.tree ? String(c.tree) : '',
      })),
    };
    st.combos = (Array.isArray(raw.combos) ? raw.combos : []).map((c: any) => ({
      name: String(c?.name ?? ''), xp: num(c?.xp, 0),
    }));

    st.colleges = (Array.isArray(raw.colleges) ? raw.colleges : []).map((c: any) => ({
      name: String(c?.name ?? ''), favored: !!c?.favored, ...trait(c, 0),
    }));
    st.thaumaturgy = (Array.isArray(raw.thaumaturgy) ? raw.thaumaturgy : []).map((t: any) => ({
      name: String(t?.name ?? ''),
      kind: t?.kind === 'procedure' ? 'procedure' : 'degree',
      level: clamp(num(t?.level, 1), 0, 10),
      favored: !!t?.favored,
    }));
    st.mutations = (Array.isArray(raw.mutations) ? raw.mutations : []).map((m: any) => ({
      name: String(m?.name ?? ''),
      level: RULES.mutationLevels.includes(num(m?.level, 1)) ? num(m?.level, 1) : RULES.mutationLevels[0],
      negative: !!m?.negative,
    }));
    st.meritsFlaws = (Array.isArray(raw.meritsFlaws) ? raw.meritsFlaws : []).map((m: any) => ({
      name: String(m?.name ?? ''), points: clamp(num(m?.points, 1), 0, 20), flaw: !!m?.flaw,
    }));

    const validCircles = new Set((sp.sorcery?.circles || []).map((c: any) => c.id));
    st.sorcery = {
      circles: {},
      spells: (Array.isArray(raw.sorcery?.spells) ? raw.sorcery.spells : [])
        .map((s: any) => ({ name: String(s?.name ?? ''), circle: String(s?.circle ?? '') }))
        .filter((s: any) => validCircles.has(s.circle)),
    };
    for (const id of validCircles) st.sorcery.circles[id as string] = !!raw.sorcery?.circles?.[id as string];

    st.commitments = (Array.isArray(raw.commitments) ? raw.commitments : []).map((c: any) => ({
      name: String(c?.name ?? ''), motes: num(c?.motes, 0),
    }));

    st.health = {
      extras: Object.fromEntries(RULES.healthTrack.map((l: any) => [l.id, clamp(num(raw.health?.extras?.[l.id], 0), 0, 20)])),
      marks: Array.isArray(raw.health?.marks) ? raw.health.marks.map((m: any) => (['B', 'L', 'A'].includes(m) ? m : '')) : [],
    };

    const wd = RULES.weaponDefaults;
    st.weapons = (Array.isArray(raw.weapons) ? raw.weapons : []).map((w: any, i: number) => ({
      name: String(w?.name ?? ''),
      ability: RULES.attackAbilities.some((a: any) => a.id === w?.ability) ? w.ability : 'melee',
      speed: num(w?.speed, wd.speed), accuracy: num(w?.accuracy, wd.accuracy),
      damage: num(w?.damage, wd.damage),
      damageType: ['B', 'L', 'A'].includes(w?.damageType) ? w.damageType : wd.damageType,
      rate: num(w?.rate, wd.rate), defense: num(w?.defense, wd.defense),
      tags: String(w?.tags ?? ''), primary: !!w?.primary || i === 0,
    }));
    if (st.weapons.length && !st.weapons.some((w: any) => w.primary)) st.weapons[0].primary = true;

    const ad = RULES.armorDefaults;
    st.armor = (Array.isArray(raw.armor) ? raw.armor : []).map((a: any) => ({
      name: String(a?.name ?? ''),
      soakB: num(a?.soakB, ad.soakB), soakL: num(a?.soakL, ad.soakL), soakA: num(a?.soakA, ad.soakA),
      hardness: num(a?.hardness, ad.hardness), mobility: num(a?.mobility, ad.mobility),
      fatigue: num(a?.fatigue, ad.fatigue), worn: a?.worn !== false,
    }));

    Object.assign(st.notes, raw.notes || {});
    st.budget = num(raw.budget, RULES.defaultBudget);
    st.adjustment = num(raw.adjustment, 0);
    st.meta = { schema: SCHEMA };
    return st;
  }

  /* --------------------------------------------------- trait addressing */
  /** Resolve a `kind:key` path used by the dot widgets and grant inputs. */
  function resolve(path: string): { t: any; kind: string; id: string } | null {
    const [k, key] = path.split(':');
    switch (k) {
      case 'attr': return { t: S.attrs[key], kind: 'attribute', id: key };
      case 'col': return { t: S.colleges[+key], kind: 'college', id: 'college' };
      case 'abil': return { t: S.abils[key], kind: 'ability', id: key };
      case 'craft': return { t: S.crafts[+key], kind: 'ability', id: 'craft' };
      case 'virtue': return { t: S.virtues[key], kind: 'virtue', id: key };
      case 'wp': return { t: S.willpower, kind: 'willpower', id: 'willpower' };
      case 'ess': return { t: S.essence, kind: 'essence', id: 'essence' };
      case 'bg': return { t: S.backgrounds[+key], kind: 'background', id: 'background' };
      default: return null;
    }
  }

  const favOf = (kind: string, id: string) =>
    calc.isFavored(id, kind, splat(), S.caste, kind === 'ability' ? S.favored.abilities : S.favored.attributes);

  const traitXpOf = (kind: string, id: string, t: any) =>
    calc.traitXp(kind, t?.v, t?.granted, favOf(kind, id), splat());

  /* ------------------------------------------------------- dot widgets */
  function dots(path: string, value: number, free: number, cap: number, extraClass = '') {
    // A rating already above the cap keeps all of its dots, so imported sheets never lose data.
    const max = Math.max(cap, value, free);
    let h = `<span class="dots ${extraClass}" data-dots="${path}" data-max="${max}" role="slider" tabindex="0"
      aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}">`;
    for (let i = 1; i <= max; i++) {
      h += `<button type="button" class="dot${i <= value ? ' on' : ''}${i <= free ? ' free' : ''}" data-v="${i}"
        aria-label="${i}"></button>`;
    }
    return h + '</span>';
  }

  function grantInput(path: string, granted: number) {
    return `<input class="grant" type="number" min="0" max="20" step="1" value="${granted}"
      data-grant="${path}" title="Dots granted by the Storyteller — these cost no XP" />`;
  }

  function xpChip(xp: number) {
    return `<span class="xpc${xp ? ' paid' : ''}">${xp || '·'}</span>`;
  }

  /* ------------------------------------------------------------ render */
  function renderIdentity() {
    const sp = splat();
    (el('splat-sel') as HTMLSelectElement).innerHTML =
      SPLATS.map((s: any) => `<option value="${s.id}"${s.id === S.splat ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    const hasCaste = sp.casteKind !== 'none' && sp.castes.length > 0;
    el('caste-label-wrap').style.display = hasCaste ? '' : 'none';
    el('caste-label-wrap').childNodes[0].nodeValue = sp.casteLabel;
    (el('caste-sel') as HTMLSelectElement).innerHTML =
      sp.castes.map((c: any) => `<option value="${c.id}"${c.id === S.caste ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    for (const inp of Array.from(document.querySelectorAll<HTMLInputElement>('.idrow .txt'))) {
      inp.value = S.id[inp.dataset.id as string] || '';
      inp.disabled = ro();
    }

    const caste = sp.castes.find((c: any) => c.id === S.caste);
    const nameOf = (kind: string, id: string) => {
      const rec = kind === 'ability' ? abilityById(id) : DATA.attributes.find((a) => a.id === id);
      return rec ? rec.name : id;
    };

    let info = '';
    if (hasCaste) {
      const kindLabel = sp.casteKind === 'ability' ? 'abilities' : 'attributes';
      const names = (caste?.traits || []).map((t: string) => nameOf(sp.casteKind, t));
      info += `<b>${esc(caste?.name || '')}</b> ${sp.casteLabel} ${kindLabel}: `
        + (names.length ? esc(names.join(', ')) : '<i>none</i>');
    } else {
      info += `<b>${esc(sp.name)}</b> · no caste`;
    }

    // One counter per kind the type can favor, so Lunars see both at once.
    for (const kind of ['ability', 'attribute']) {
      const cfg = calc.favoredConfig(sp, kind, S.caste);
      if (!cfg || (!cfg.picks && !(cfg.always || []).length)) continue;
      const label = kind === 'ability' ? 'Favored abilities' : 'Favored attributes';
      const always = (cfg.always || []).map((id: string) => nameOf(kind, id));
      info += ` · ${label} <b>${picksFor(kind).length}/${cfg.picks}</b>`
        + (always.length ? ` (plus ${esc(always.join(', '))} always)` : '');
    }

    info += ` · Floors: Attribute ${sp.floors.attribute}, Ability ${sp.floors.ability},`
      + ` Virtue ${sp.floors.virtue}, Willpower ${sp.floors.willpower}, Essence ${sp.floors.essence}`;

    if (!sp.verified || sp._todo) {
      info += `<div class="warn-todo"><b>Unverified data.</b> ${esc(
        Array.isArray(sp._todo) ? sp._todo.join(' ') : sp._todo || 'This splat still carries placeholder numbers.')}</div>`;
    }
    el('caste-info').innerHTML = info;

    const marks = (kind: string) => {
      const cfg = calc.favoredConfig(sp, kind, S.caste);
      const canFavor = !!cfg && (cfg.picks > 0 || (cfg.always || []).length > 0);
      if (sp.casteKind === kind) return ` · C = ${sp.casteLabel}, F = Favored`;
      return canFavor ? ' · F = Favored' : '';
    };
    el('attr-hint').textContent = `(floor ${sp.floors.attribute}${marks('attribute')})`;
    el('abil-hint').textContent = `(floor ${sp.floors.ability}${marks('ability')} · ◆ specialties)`;

    document.documentElement.style.setProperty('--accent', caste?.accent || sp.accent);
    document.documentElement.style.setProperty('--accent-soft', sp.accentSoft);
  }

  /**
   * C / F tags. The C column only appears for the kind the caste grants; the F column
   * appears whenever the type can favor that kind at all, which is how a Lunar ends up
   * with caste Attributes and favored Abilities side by side.
   */
  function tags(kind: string, id: string) {
    const sp = splat();
    const cfg = calc.favoredConfig(sp, kind, S.caste);
    const canFavor = !!cfg && (cfg.picks > 0 || (cfg.always || []).length > 0);
    const casteKind = sp.casteKind === kind;
    if (!casteKind && !canFavor) {
      return '<span class="tag ghost">C</span><span class="tag ghost">F</span>';
    }
    const isCaste = calc.isCaste(id, kind, sp, S.caste);
    const isAlways = (cfg?.always || []).includes(id);
    const isPick = picksFor(kind).includes(id);
    const locked = isCaste || isAlways;
    const cTag = casteKind
      ? `<span class="tag${isCaste ? ' on locked' : ''}" title="${esc(sp.casteLabel)}">C</span>`
      : '<span class="tag ghost">C</span>';
    return cTag
      + `<button type="button" class="tag${isPick || locked ? ' on' : ''}${locked ? ' locked' : ''}"
           data-fav="${kind}:${id}"
           title="${isAlways ? 'Always favored for this Exalt type' : 'Favored'}">F</button>`;
  }

  function renderAttrs() {
    const sp = splat();
    let h = '';
    for (const g of ATTRIBUTE_GROUPS) {
      h += `<div><h3 class="grph">${g.name}</h3>`;
      for (const a of DATA.attributes.filter((x) => x.group === g.id)) {
        const t = S.attrs[a.id];
        const free = Math.max(sp.floors.attribute, t.granted);
        const fav = favOf('attribute', a.id);
        h += `<div class="trow">`
          + `<span class="nm${fav ? ' fav' : ''}">${esc(a.name)}</span>`
          + tags('attribute', a.id)
          + dots(`attr:${a.id}`, t.v, free, dotMax('attribute'))
          + grantInput(`attr:${a.id}`, t.granted)
          + xpChip(traitXpOf('attribute', a.id, t))
          + `</div>`;
      }
      h += '</div>';
    }
    el('attrs').innerHTML = h;
  }

  function abilityRow(path: string, name: string, id: string, t: any, editableName = false) {
    const sp = splat();
    const free = Math.max(sp.floors.ability, t.granted);
    const fav = favOf('ability', id);
    const specCount = (t.specialties || []).reduce((a: number, s: any) => a + (s.v || 0), 0);
    const nameCell = editableName
      ? `<input class="lname nm" data-subname="${path}" value="${esc(t.name || '')}" placeholder="Craft type" />`
      : `<span class="nm${fav ? ' fav' : ''}">${esc(name)}</span>`;
    return `<div class="trow">${nameCell}`
      + tags('ability', id)
      + dots(path, t.v, free, dotMax('ability'))
      + `<button type="button" class="specbtn${specCount ? ' has' : ''}" data-spec="${path}"
           title="Specialties">◆</button>`
      + grantInput(path, t.granted)
      + xpChip(traitXpOf('ability', id, t) + specCount * calc.flatCost('specialty', fav, sp))
      + (editableName ? `<button type="button" class="rowx" data-del="${path}" title="Remove">×</button>` : '')
      + `</div>`;
  }

  /** Craft holds no rating of its own; the row only carries the caste / favored marks. */
  function craftMarkerRow() {
    const fav = favOf('ability', 'craft');
    return `<div class="trow trow-marker">`
      + `<span class="nm${fav ? ' fav' : ''}">Craft</span>`
      + tags('ability', 'craft')
      + `<span class="marker-note">rated per type below</span>`
      + `</div>`;
  }

  function renderAbils() {
    const sp = splat();
    let h = '';
    for (const g of calc.abilityGroups(sp)) {
      h += `<div><h3 class="grph">${esc(g.name)}</h3>`;
      for (const id of g.abilities) {
        const rec = abilityById(id);
        if (!rec) continue;
        h += rec.sub === 'craft' ? craftMarkerRow() : abilityRow(`abil:${id}`, rec.name, id, S.abils[id]);
      }
      h += '</div>';
    }
    el('abils').innerHTML = h;

    el('crafts').innerHTML = S.crafts.length
      ? S.crafts.map((t: any, i: number) => abilityRow(`craft:${i}`, '', 'craft', t, true)).join('')
      : '<div class="empty">No Craft types yet.</div>';
  }

  function renderPower() {
    const sp = splat();
    let h = '<h3 class="grph">Virtues</h3>';
    for (const v of DATA.virtues) {
      const t = S.virtues[v.id];
      h += `<div class="trow"><span class="nm">${esc(v.name)}</span>`
        + '<span class="tag ghost">C</span><span class="tag ghost">F</span>'
        + dots(`virtue:${v.id}`, t.v, Math.max(sp.floors.virtue, t.granted), dotMax('virtue'))
        + grantInput(`virtue:${v.id}`, t.granted)
        + xpChip(traitXpOf('virtue', v.id, t))
        + '</div>';
    }
    h += `<div class="tline"><span class="tl">Virtue Flaw</span>`
      + `<input class="lname" data-vf value="${esc(S.virtueFlaw)}" placeholder="e.g. Deliberate Cruelty" /></div>`;

    if (sp.limit.enabled) {
      h += `<h3 class="grph">${esc(sp.limit.label)} <small>· ${esc(sp.limit.breakLabel)} at ${sp.limit.boxes}</small></h3><div class="wp-track">`;
      for (let i = 1; i <= sp.limit.boxes; i++) {
        h += `<button type="button" class="box limit${i <= S.limit ? ' on' : ''}" data-limit="${i}" aria-label="${i}"></button>`;
      }
      h += '</div>';
    }

    h += '<h3 class="grph">Willpower &amp; Essence</h3>';
    const wp = S.willpower;
    h += `<div class="trow"><span class="nm">Willpower</span>`
      + '<span class="tag ghost">C</span><span class="tag ghost">F</span>'
      + dots('wp:x', wp.v, Math.max(sp.floors.willpower, wp.granted), dotMax('willpower'))
      + grantInput('wp:x', wp.granted)
      + xpChip(traitXpOf('willpower', 'willpower', wp))
      + '</div>';
    h += '<div class="wp-track">';
    for (let i = 1; i <= wp.v; i++) {
      h += `<button type="button" class="box${i <= S.willpowerTemp ? ' on' : ''}" data-wptemp="${i}"
        title="Temporary Willpower" aria-label="${i}"></button>`;
    }
    h += '</div>';

    const ess = S.essence;
    h += `<div class="trow"><span class="nm">Essence</span>`
      + '<span class="tag ghost">C</span><span class="tag ghost">F</span>'
      + dots('ess:x', ess.v, Math.max(sp.floors.essence, ess.granted), dotMax('essence'))
      + grantInput('ess:x', ess.granted)
      + xpChip(traitXpOf('essence', 'essence', ess))
      + '</div>';
    h += `<div class="tline"><span class="tl">XP adjustment</span>`
      + `<input class="lnum" type="number" step="1" data-adj value="${S.adjustment}"
           title="Free-form XP added to (or refunded from) the total" /></div>`;
    el('power').innerHTML = h;
  }

  function renderBackgrounds() {
    const sp = splat();
    (el('bg-list') as HTMLDataListElement).innerHTML = BACKGROUNDS
      .filter((b: any) => !b.splats || b.splats.includes(S.splat))
      .map((b: any) => `<option value="${esc(b.name)}"></option>`).join('');
    el('backgrounds').innerHTML = S.backgrounds.length
      ? S.backgrounds.map((b: any, i: number) => `<div class="trow">`
          + `<input class="lname nm" list="bg-list" data-bgname="${i}" value="${esc(b.name)}" placeholder="Background" />`
          + `<label class="mystic" title="Mystic Backgrounds cost 6 a dot at ratings 4 and 5">`
          + `<input type="checkbox" data-bgmystic="${i}"${b.mystic ? ' checked' : ''} /> mystic</label>`
          + dots(`bg:${i}`, b.v, Math.max(sp.floors.background, b.granted), dotMax('background'))
          + grantInput(`bg:${i}`, b.granted)
          + xpChip(calc.traitXp(b.mystic ? 'backgroundMystic' : 'background', b.v, b.granted, false, sp))
          + `<button type="button" class="rowx" data-del="bg:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">No backgrounds yet.</div>';
  }

  function renderColleges() {
    const sp = splat();
    const on = !!sp.astrology?.enabled;
    el('sec-astro-wrap').style.display = on ? '' : 'none';
    if (!on) return;
    el('astro-title').textContent = sp.astrology.label;
    (el('college-list') as HTMLDataListElement).innerHTML =
      (sp.astrology.colleges || []).map((c: string) => `<option value="${esc(c)}"></option>`).join('');
    el('colleges').innerHTML = S.colleges.length
      ? S.colleges.map((c: any, i: number) => `<div class="trow">`
          + `<input class="lname nm" list="college-list" data-colname="${i}" value="${esc(c.name)}" placeholder="College" />`
          + `<button type="button" class="tag${c.favored ? ' on' : ''}" data-colfav="${i}" title="Favored">F</button>`
          + dots(`col:${i}`, c.v, c.granted, dotMax('ability'))
          + grantInput(`col:${i}`, c.granted)
          + xpChip(calc.traitXp('college', c.v, c.granted, !!c.favored, sp))
          + `<button type="button" class="rowx" data-del="college:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">No colleges yet.</div>';
  }

  function renderOther() {
    const sp = splat();

    el('thaumaturgy').innerHTML =
      `<div class="lrow head"><span style="flex:1">Art or procedure</span><span style="width:9rem">Kind</span>`
      + `<span style="width:4rem;text-align:center">Level</span><span style="width:3.4rem;text-align:center">Fav</span>`
      + `<span style="width:2.6rem;text-align:right">XP</span><span style="width:1.4rem"></span></div>`
      + (S.thaumaturgy.length
        ? S.thaumaturgy.map((t: any, i: number) => {
            const xp = t.kind === 'procedure'
              ? calc.levelCost('thaumaturgyProcedure', t.level, t.favored, sp)
              : calc.levelCost('thaumaturgyDegree', t.level, t.favored, sp);
            return `<div class="lrow">`
              + `<input class="lname" data-thname="${i}" value="${esc(t.name)}" placeholder="Alchemy, Warding…" />`
              + `<select class="lsel" style="width:9rem" data-thkind="${i}">`
              + `<option value="degree"${t.kind === 'degree' ? ' selected' : ''}>Degree</option>`
              + `<option value="procedure"${t.kind === 'procedure' ? ' selected' : ''}>Procedure</option></select>`
              + `<input class="lnum" style="width:4rem" type="number" min="0" max="10" step="1" data-thlevel="${i}" value="${t.level}" />`
              + `<label style="width:3.4rem;display:flex;justify-content:center">`
              + `<input type="checkbox" data-thfav="${i}"${t.favored ? ' checked' : ''} /></label>`
              + `<span class="xpc paid" style="width:2.6rem">${xp}</span>`
              + `<button type="button" class="rowx" data-del="thaum:${i}" title="Remove">×</button></div>`;
          }).join('')
        : '<div class="empty">No thaumaturgy yet.</div>');

    el('mutations').innerHTML = S.mutations.length
      ? S.mutations.map((m: any, i: number) => {
          const xp = calc.levelCost('mutation', m.level, false, sp) * (m.negative ? -1 : 1);
          return `<div class="lrow">`
            + `<input class="lname" data-mutname="${i}" value="${esc(m.name)}" placeholder="Mutation" />`
            + `<select class="lsel" style="width:5rem" data-mutlevel="${i}">`
            + RULES.mutationLevels.map((l: number) =>
                `<option value="${l}"${l === m.level ? ' selected' : ''}>${l}</option>`).join('')
            + `</select>`
            + `<label class="lbl" title="A defect refunds experience instead of costing it">`
            + `<input type="checkbox" data-mutneg="${i}"${m.negative ? ' checked' : ''} /> defect</label>`
            + `<span class="xpc paid" style="width:2.6rem">${xp}</span>`
            + `<button type="button" class="rowx" data-del="mutation:${i}" title="Remove">×</button></div>`;
        }).join('')
      : '<div class="empty">No mutations yet.</div>';

    el('meritsFlaws').innerHTML = S.meritsFlaws.length
      ? S.meritsFlaws.map((m: any, i: number) => {
          const xp = calc.levelCost('meritFlaw', m.points, false, sp) * (m.flaw ? -1 : 1);
          return `<div class="lrow">`
            + `<input class="lname" data-mfname="${i}" value="${esc(m.name)}" placeholder="Merit or Flaw" />`
            + `<span class="lbl">bp</span>`
            + `<input class="lnum" style="width:3.4rem" type="number" min="0" max="20" step="1" data-mfpoints="${i}" value="${m.points}" />`
            + `<label class="lbl" title="A Flaw refunds experience instead of costing it">`
            + `<input type="checkbox" data-mfflaw="${i}"${m.flaw ? ' checked' : ''} /> flaw</label>`
            + `<span class="xpc paid" style="width:2.6rem">${xp}</span>`
            + `<button type="button" class="rowx" data-del="meritflaw:${i}" title="Remove">×</button></div>`;
        }).join('')
      : '<div class="empty">No merits or flaws yet.</div>';
  }

  function renderChecks() {
    const checks = calc.creationChecks(S, splat(), DATA);
    const bad = checks.filter((c: any) => !c.ok).length;
    el('checks').innerHTML =
      `<div class="checks-h">Starting-sheet rules · ${bad ? `${bad} not met` : 'all met'} · advisory only</div>`
      + checks.map((c: any) =>
        `<div class="chk ${c.ok ? 'ok' : 'bad'}"><span class="mark">${c.ok ? '✓' : '!'}</span>`
        + `<span>${esc(c.text)}</span></div>`).join('');
    const btn = el('checks-toggle');
    btn.textContent = bad ? `Checks (${bad})` : 'Checks';
    btn.classList.toggle('primary', bad > 0);
  }

  function poolCtx() {
    const vs = calc.virtueStats(S.virtues);
    const breeding = S.backgrounds.find((b: any) => /breeding/i.test(b.name));
    return { essence: S.essence.v, willpower: S.willpower.v, breeding: breeding ? breeding.v : 0, ...vs };
  }

  function renderCommitments() {
    el('commitments').innerHTML = S.commitments.length
      ? S.commitments.map((c: any, i: number) => `<div class="lrow">`
          + `<input class="lname" data-cname="${i}" value="${esc(c.name)}" placeholder="Artifact, Charm…" />`
          + `<span class="lbl">motes</span><input class="lnum" type="number" step="1" min="0" data-cmotes="${i}" value="${c.motes}" />`
          + `<button type="button" class="rowx" data-del="commit:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">Nothing committed.</div>';
  }

  function renderPools() {
    const sp = splat();
    const ctx = poolCtx();
    const personal = calc.poolValue(sp.pools.personal, ctx);
    const peripheral = calc.poolValue(sp.pools.peripheral, ctx);
    const committed = S.commitments.reduce((a: number, c: any) => a + (c.motes || 0), 0);
    const total = personal.value + peripheral.value;
    const row = (l: string, v: any, f: string) =>
      `<div class="cmb"><b>${l}</b> <span class="val" data-calc="${esc(f)}">${v}</span></div>`;
    // Heroic mortals have no personal pool at all, so that row is dropped rather than shown as 0.
    const hasPersonal = Object.keys(sp.pools.personal || {}).length > 0;
    el('pools').innerHTML =
      (hasPersonal ? row('Personal', personal.value, personal.formula) : '')
      + row('Peripheral', peripheral.value, peripheral.formula)
      + (hasPersonal
        ? row('Total', total, `Personal ${personal.value} + Peripheral ${peripheral.value} = ${total}`)
        : '')
      + row('Committed', committed, S.commitments.length
          ? S.commitments.map((c: any) => `${c.name || 'unnamed'} ${c.motes}`).join(' + ') + ` = ${committed}`
          : 'Nothing committed')
      + row('Available', total - committed, `${total} − ${committed} = ${total - committed}`);
  }

  /** Keys of the charms taken from the published lists, as "setId:charmId". */
  function ownedCharms(): Set<string> {
    return new Set(S.charms.list.filter((c: any) => c.set && c.cid)
      .map((c: any) => `${c.set}:${c.cid}`));
  }

  const traitName = (id: string) =>
    DATA.abilities.find((a) => a.id === id)?.name
    || DATA.attributes.find((a) => a.id === id)?.name
    || id;

  /** What a listed charm's own set says the character is short of, if it is loaded. */
  function charmProblems(c: any): string {
    if (!c.set || !c.cid) return '';
    const set = charmData.cached(c.set);
    const charm = set?.charms.find((x: any) => x.id === c.cid);
    if (!set || !charm) return '';
    const problems = charmData.problemsFor(charm, set, { ...S, owned: ownedCharms() }, traitName);
    return problems.map((p: any) => p.text).join(' · ');
  }

  /**
   * Fetch the sets the sheet already refers to, so the rows can show what a
   * charm needs. Missing data is never fatal: the rows just lose their notes.
   */
  function warmCharmSets() {
    const ids = new Set<string>(S.charms.list.map((c: any) => c.set).filter(Boolean));
    for (const id of ids) {
      if (charmData.cached(id)) continue;
      charmData.warm(id).then(() => renderCharms()).catch(() => { /* offline */ });
    }
  }

  async function pickCharms() {
    const { openCharmPicker } = await import('./charm-picker');
    await openCharmPicker({
      splatId: S.splat,
      owned: ownedCharms,
      sheet: () => S,
      traitName,
      onToggle: (set, charm, add, category) => {
        const key = `${set.id}:${charm.id}`;
        if (!add) {
          S.charms.list = S.charms.list.filter((c: any) => `${c.set}:${c.cid}` !== key);
        } else {
          const tree = set.trees.find((t: any) => t.id === charm.t);
          S.charms.list.push({
            name: charm.n, favored: !!(tree?.trait && favOf(tree.traitKind || 'ability', tree.trait)),
            category, granted: false, note: '', set: set.id, cid: charm.id, tree: charm.t,
          });
        }
        renderCharms();
        recompute();
      },
    });
  }

  function renderCharms() {
    const sp = splat();
    el('charms').innerHTML =
      `<div class="lrow head"><span style="flex:1">Charm</span><span style="width:11rem">Type</span><span style="width:3.2rem;text-align:center">Fav</span><span style="width:3.6rem;text-align:center" title="Granted: it sits on the sheet and costs no XP">Free</span><span style="width:2.6rem;text-align:right">XP</span><span style="width:1.4rem"></span></div>`
      + (S.charms.list.length
        ? S.charms.list.map((c: any, i: number) => {
            const short = charmProblems(c);
            const set = c.set ? charmData.cached(c.set) : null;
            const tree = set?.trees.find((t: any) => t.id === c.tree);
            return `<div class="lrow${short ? ' short' : ''}">`
              + (c.cid
                ? `<span class="lname listed" title="${esc(set?.name || c.set)}">${esc(c.name)}`
                  + (tree ? `<small>${esc(tree.name)}</small>` : '') + `</span>`
                : `<input class="lname" data-chname="${i}" value="${esc(c.name)}" placeholder="Charm name" />`)
              + `<select class="lsel" style="width:11rem" data-chcat="${i}">`
              + calc.CHARM_CATEGORIES.map((cat: any) =>
                  `<option value="${cat.id}"${cat.id === c.category ? ' selected' : ''}>${esc(cat.name)}</option>`).join('')
              + `</select>`
              + `<label class="lbl" style="width:3.2rem;justify-content:center;display:flex">`
              + `<input type="checkbox" data-chfav="${i}"${c.favored ? ' checked' : ''} /></label>`
              + `<label class="lbl" style="width:3.6rem;justify-content:center;display:flex"`
              + ` title="Granted: it sits on the sheet and costs no XP">`
              + `<input type="checkbox" data-chgr="${i}"${c.granted ? ' checked' : ''} /></label>`
              + (c.granted
                ? `<span class="xpc granted" style="width:2.6rem"`
                  + ` title="Granted. It would have cost ${calc.charmCost(c.category, c.favored, sp)}.">0</span>`
                : `<span class="xpc paid" style="width:2.6rem">${calc.charmCost(c.category, c.favored, sp)}</span>`)
              + `<button type="button" class="rowx" data-del="charm:${i}" title="Remove">×</button>`
              + (short ? `<div class="rowwarn">needs ${esc(short)}</div>` : '')
              + `</div>`;
          }).join('')
        : '<div class="empty">No Charms yet.</div>');

    el('combos').innerHTML = S.combos.length
      ? S.combos.map((c: any, i: number) => `<div class="lrow">`
          + `<input class="lname" data-cbname="${i}" value="${esc(c.name)}" placeholder="Combo name" />`
          + `<span class="lbl">xp</span><input class="lnum" type="number" step="1" min="0" data-cbxp="${i}" value="${c.xp}" />`
          + `<button type="button" class="rowx" data-del="combo:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">No Combos yet.</div>';
  }

  function renderSorcery() {
    const sp = splat();
    const favOccult = favOf('ability', sp.sorcery.favoredAbility);
    const detail = calc.spellsXp(S.sorcery, sp, favOccult).detail;
    const byCircle = Object.fromEntries(detail.map((d: any) => [d.circle, d]));

    const charmCost = calc.flatCost('charm', favOccult, sp);
    el('circles').innerHTML = sp.sorcery.circles.map((c: any) => {
      const d = byCircle[c.id];
      const each = calc.spellCost(c.id, favOccult, sp);
      const bought = !!S.sorcery.circles[c.id];
      const spellXp = d ? d.xp : 0;
      return `<div class="lrow">`
        + `<label class="lname" style="display:flex;align-items:center;gap:.4rem">`
        + `<input type="checkbox" data-circle="${c.id}"${bought ? ' checked' : ''} />`
        + `<span>${esc(c.name)}</span></label>`
        + `<span class="lbl">${esc(c.kind)}</span>`
        + `<span class="xpc">${bought ? `Charm ${charmCost} · ` : ''}${d ? d.spells : 0} spell(s) × ${each} xp`
        + `${bought ? ' · first free' : ''}</span>`
        + `<span class="xpc paid" style="width:3rem">${(bought ? charmCost : 0) + spellXp}</span></div>`;
    }).join('');

    el('spells').innerHTML = S.sorcery.spells.length
      ? S.sorcery.spells.map((s: any, i: number) => `<div class="lrow">`
          + `<input class="lname" data-spname="${i}" value="${esc(s.name)}" placeholder="Spell name" />`
          + `<select class="lsel" data-spcircle="${i}">`
          + sp.sorcery.circles.map((c: any) =>
              `<option value="${c.id}"${c.id === s.circle ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
          + `</select>`
          + `<button type="button" class="rowx" data-del="spell:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">No spells yet.</div>';
  }

  function healthLevels() {
    return calc.healthLevels(RULES, S.health.extras);
  }

  function renderHealth() {
    const levels = healthLevels();
    while (S.health.marks.length < levels.length) S.health.marks.push('');
    S.health.marks.length = levels.length;

    const groups: any[] = [];
    for (const lvl of RULES.healthTrack) {
      groups.push({ id: lvl.id, label: lvl.label, idx: [] as number[] });
    }
    levels.forEach((l: any, i: number) => {
      const g = groups.find((x) => x.id === l.id);
      if (g) g.idx.push(i);
    });

    let h = '<div class="hl-track">';
    for (const g of groups) {
      h += `<div class="hl-grp"><span class="hl-lbl">${esc(g.label)}</span>`;
      for (const i of g.idx) {
        const m = S.health.marks[i] || '';
        h += `<button type="button" class="hl-box${m ? ' ' + m.toLowerCase() : ''}" data-hbox="${i}"
          title="Click to cycle: — → B → L → A">${esc(m)}</button>`;
      }
      h += '</div>';
    }
    h += '</div>';

    h += '<div class="hl-ox-row"><span class="ox-title">Extra levels (Ox-Body)</span>';
    for (const g of groups) {
      if (g.id === 'inc') continue;
      h += `<span class="hl-grp"><span class="hl-lbl">${esc(g.label)}</span>`
        + `<input class="hl-ox" type="number" min="0" max="20" step="1" data-ox="${g.id}"
             value="${S.health.extras[g.id] || 0}" title="Extra ${g.label} health levels" /></span>`;
    }
    h += '</div>';

    const taken = S.health.marks.filter(Boolean).length;
    const wp = calc.woundPenalty(levels, taken);
    h += `<div class="hl-foot">Damage taken <b>${taken}</b> of <b>${levels.length}</b>`
      + ` · Wound penalty <b>${wp.value}</b>${wp.incapacitated ? ' · <b>Incapacitated</b>' : ''}</div>`;
    el('health').innerHTML = h;
  }

  function armorStack() {
    const worn = S.armor.filter((a: any) => a.worn);
    return {
      soakB: worn.reduce((m: number, a: any) => Math.max(m, a.soakB), 0),
      soakL: worn.reduce((m: number, a: any) => Math.max(m, a.soakL), 0),
      soakA: worn.reduce((m: number, a: any) => Math.max(m, a.soakA), 0),
      hardness: worn.reduce((m: number, a: any) => Math.max(m, a.hardness), 0),
      mobility: worn.reduce((s: number, a: any) => s + Math.abs(a.mobility), 0),
      fatigue: worn.reduce((s: number, a: any) => s + Math.abs(a.fatigue), 0),
      count: worn.length,
    };
  }

  function renderWeapons() {
    el('weapons').innerHTML =
      `<div class="lrow head"><span style="flex:1">Weapon</span><span style="width:8rem">Ability</span>`
      + `<span style="width:3.6rem;text-align:center">Spd</span><span style="width:3.6rem;text-align:center">Acc</span>`
      + `<span style="width:3.6rem;text-align:center">Dmg</span><span style="width:3.6rem;text-align:center">Type</span>`
      + `<span style="width:3.6rem;text-align:center">Rate</span><span style="width:3.6rem;text-align:center">Def</span>`
      + `<span style="width:3rem;text-align:center">Main</span><span style="width:1.4rem"></span></div>`
      + (S.weapons.length
        ? S.weapons.map((w: any, i: number) => `<div class="lrow">`
            + `<input class="lname" data-wname="${i}" value="${esc(w.name)}" placeholder="Weapon" />`
            + `<select class="lsel" style="width:8rem" data-wabil="${i}">`
            + RULES.attackAbilities.map((a: any) =>
                `<option value="${a.id}"${a.id === w.ability ? ' selected' : ''}>${esc(a.name)}</option>`).join('')
            + `</select>`
            + ['speed', 'accuracy', 'damage'].map((k) =>
                `<input class="lnum" type="number" step="1" data-w="${k}:${i}" value="${w[k]}" />`).join('')
            + `<select class="lnum" data-w="damageType:${i}">`
            + RULES.damageTypes.map((d: any) =>
                `<option value="${d.id}"${d.id === w.damageType ? ' selected' : ''}>${d.id}</option>`).join('')
            + `</select>`
            + ['rate', 'defense'].map((k) =>
                `<input class="lnum" type="number" step="1" data-w="${k}:${i}" value="${w[k]}" />`).join('')
            + `<label style="width:3rem;display:flex;justify-content:center">`
            + `<input type="radio" name="wprimary" data-wprim="${i}"${w.primary ? ' checked' : ''} /></label>`
            + `<button type="button" class="rowx" data-del="weapon:${i}" title="Remove">×</button></div>`).join('')
        : '<div class="empty">No weapons yet.</div>');
  }

  function renderArmor() {
    el('armor').innerHTML =
      `<div class="lrow head"><span style="flex:1">Armour</span>`
      + `<span style="width:3.6rem;text-align:center">B</span><span style="width:3.6rem;text-align:center">L</span>`
      + `<span style="width:3.6rem;text-align:center">A</span><span style="width:3.6rem;text-align:center">Hard</span>`
      + `<span style="width:3.6rem;text-align:center">Mob</span><span style="width:3.6rem;text-align:center">Fat</span>`
      + `<span style="width:3rem;text-align:center">Worn</span><span style="width:1.4rem"></span></div>`
      + (S.armor.length
        ? S.armor.map((a: any, i: number) => `<div class="lrow">`
            + `<input class="lname" data-aname="${i}" value="${esc(a.name)}" placeholder="Armour" />`
            + ['soakB', 'soakL', 'soakA', 'hardness', 'mobility', 'fatigue'].map((k) =>
                `<input class="lnum" type="number" step="1" data-a="${k}:${i}" value="${a[k]}" />`).join('')
            + `<label style="width:3rem;display:flex;justify-content:center">`
            + `<input type="checkbox" data-aworn="${i}"${a.worn ? ' checked' : ''} /></label>`
            + `<button type="button" class="rowx" data-del="armor:${i}" title="Remove">×</button></div>`).join('')
        : '<div class="empty">No armour yet.</div>');
  }

  function renderCombat() {
    const arm = armorStack();
    const levels = healthLevels();
    const wound = calc.woundPenalty(levels, S.health.marks.filter(Boolean).length).value;
    const dex = S.attrs.dexterity.v;
    const str = S.attrs.strength.v;
    const jb = calc.joinBattle({ wits: S.attrs.wits.v, awareness: S.abils.awareness.v });
    let h = `<div class="cmb"><b>Join Battle</b> <span class="val" data-calc="${esc(jb.formula)}">${jb.value} dice</span></div>`;
    if (!S.weapons.length) {
      h += '<div class="empty">Add a weapon to see attack pools and Parry DV.</div>';
    }
    for (const w of S.weapons) {
      const abilRec = RULES.attackAbilities.find((a: any) => a.id === w.ability);
      const t = S.abils[w.ability] || { v: 0, specialties: [] };
      const spec = (t.specialties || []).reduce((m: number, s: any) => Math.max(m, s.v || 0), 0);
      const atk = calc.attackPool({
        attribute: dex, attributeName: 'Dexterity', ability: t.v, abilityName: abilRec?.name || w.ability,
        accuracy: w.accuracy, specialty: spec, wound, fatigue: arm.fatigue,
      });
      const dmg = calc.rawDamage({ strength: str, damage: w.damage, damageType: w.damageType });
      const pdv = calc.parryDV({
        dexterity: dex, ability: t.v, abilityName: abilRec?.name || w.ability,
        weaponDefense: w.defense, mobility: arm.mobility,
      });
      h += `<div class="cmb"><b>${esc(w.name || 'unnamed')}${w.primary ? ' ★' : ''}</b> `
        + `<span class="val" data-calc="${esc(atk.formula)}">${atk.value}d</span> attack · `
        + `<span class="val" data-calc="${esc(dmg.formula)}">${dmg.value}${w.damageType}</span> damage · `
        + `Parry DV <span class="val" data-calc="${esc(pdv.formula)}">${pdv.value}</span> · `
        + `Spd ${w.speed} · Rate ${w.rate}</div>`;
    }
    el('combat').innerHTML = h;
  }

  function renderNotes() {
    const f = (key: string, label: string) =>
      `<label>${label}<textarea data-note="${key}" placeholder="">${esc(S.notes[key])}</textarea></label>`;
    el('notes').innerHTML = f('intimacies', 'Intimacies') + f('backstory', 'Backstory') + f('gear', 'Gear &amp; possessions');
  }

  function renderDerived() {
    const sp = splat();
    const arm = armorStack();
    const levels = healthLevels();
    const wound = calc.woundPenalty(levels, S.health.marks.filter(Boolean).length);
    const ctx = poolCtx();

    const ddv = calc.dodgeDV({
      dexterity: S.attrs.dexterity.v, dodge: S.abils.dodge.v, essence: S.essence.v, mobility: arm.mobility,
    });
    const mdv = calc.mentalDV({
      willpower: S.willpower.v, integrity: S.abils.integrity.v, essence: S.essence.v,
    });
    const primary = S.weapons.find((w: any) => w.primary) || S.weapons[0];
    let pdv: any = null;
    if (primary) {
      const t = S.abils[primary.ability] || { v: 0 };
      const abilRec = RULES.attackAbilities.find((a: any) => a.id === primary.ability);
      pdv = calc.parryDV({
        dexterity: S.attrs.dexterity.v, ability: t.v, abilityName: abilRec?.name || primary.ability,
        weaponDefense: primary.defense, mobility: arm.mobility,
      });
    }
    const sk = calc.soak({
      stamina: S.attrs.stamina.v, armorB: arm.soakB, armorL: arm.soakL, armorA: arm.soakA,
    }, sp);
    const jb = calc.joinBattle({ wits: S.attrs.wits.v, awareness: S.abils.awareness.v });
    const mv = calc.movement({ dexterity: S.attrs.dexterity.v }, RULES);
    const personal = calc.poolValue(sp.pools.personal, ctx);
    const peripheral = calc.poolValue(sp.pools.peripheral, ctx);
    const committed = S.commitments.reduce((a: number, c: any) => a + (c.motes || 0), 0);

    const r = (l: string, v: any, f: string, extra = false) =>
      `<div class="derv${extra ? ' derv-extra' : ''}"><span class="dl">${l}</span>`
      + `<span class="dv" data-calc="${esc(f)}">${v}</span></div>`;

    el('derived').innerHTML =
      r('Dodge DV', ddv.value, ddv.formula)
      + (pdv ? r('Parry DV', pdv.value, pdv.formula) : r('Parry DV', '—', 'No weapon selected'))
      + r('Mental DV', mdv.value, mdv.formula)
      + r('Soak B / L / A', `${sk.bashing.value} / ${sk.lethal.value} / ${sk.aggravated.value}`,
          `${sk.bashing.formula} · ${sk.lethal.formula} · ${sk.aggravated.formula}`)
      + r('Hardness', arm.hardness, arm.count ? `Highest hardness among ${arm.count} worn piece(s) = ${arm.hardness}` : 'No armour worn')
      + (Object.keys(sp.pools.personal || {}).length
        ? r('Personal Essence', personal.value, personal.formula) : '')
      + r('Peripheral Essence', peripheral.value, peripheral.formula)
      + r('Essence available', personal.value + peripheral.value - committed,
          `Personal ${personal.value} + Peripheral ${peripheral.value} − committed ${committed} = ${personal.value + peripheral.value - committed}`)
      + r('Join Battle', `${jb.value}d`, jb.formula, true)
      + r('Wound penalty', wound.value + (wound.incapacitated ? ' · Incap' : ''),
          `${S.health.marks.filter(Boolean).length} of ${levels.length} health levels filled`, true)
      + r('Mobility penalty', `−${arm.mobility}`, arm.count ? `Sum of worn mobility penalties = −${arm.mobility}` : 'No armour worn', true)
      + r('Fatigue', arm.fatigue, arm.count ? `Sum of worn fatigue values = ${arm.fatigue}` : 'No armour worn', true)
      + r('Move / Dash', `${mv.move.value} / ${mv.dash.value} yd`, `${mv.move.formula} · ${mv.dash.formula}`, true);
  }

  /* ------------------------------------------------------- XP roll-up */
  function recompute() {
    const sp = splat();
    const { breakdown: b, total } = calc.totalXp(S, sp, DATA);
    el('xpSpent').textContent = String(total);
    const rem = (S.budget || 0) - total;
    const re = el('xpRem');
    re.textContent = String(rem);
    re.className = 'rem ' + (rem < 0 ? 'neg' : 'ok');

    const label: Record<string, string> = {
      attributes: 'Attributes', abilities: 'Abilities', specialties: 'Specialties', virtues: 'Virtues',
      willpower: 'Willpower', essence: 'Essence', backgrounds: 'Backgrounds', charms: 'Charms',
      spells: 'Spells', combos: 'Combos', colleges: 'Colleges', thaumaturgy: 'Thaumaturgy',
      mutations: 'Mutations', meritsFlaws: 'Merits & Flaws', adjustment: 'Adjustment',
    };
    el('xpBreak').textContent = Object.entries(b)
      .filter(([, v]) => v)
      .map(([k, v]) => `${label[k]} ${v}`)
      .join(' · ') || 'Nothing spent yet';

    renderPools();
    renderCombat();
    renderDerived();
    renderChecks();
    opts.onChange?.({ spent: total, budget: S.budget || 0, remaining: rem });
    save();
  }

  function renderAll() {
    renderIdentity();
    renderAttrs();
    renderAbils();
    renderPower();
    renderBackgrounds();
    renderColleges();
    renderCharms();
    renderSorcery();
    renderOther();
    renderHealth();
    renderWeapons();
    renderArmor();
    renderCommitments();
    renderNotes();
    (el('xpBudget') as HTMLInputElement).value = String(S.budget);
    recompute();
  }

  function save() {
    if (booting || ro()) return;
    try { opts.save(S); } catch { /* storage full or unavailable */ }
  }

  /* ------------------------------------------------------------ events */
  function onDotClick(dotsEl: HTMLElement, v: number) {
    const path = dotsEl.dataset.dots as string;
    const res = resolve(path);
    if (!res || !res.t) return;
    // The floor is where every character starts, so a rating can never go under it.
    const floor = (splat().floors as any)[res.kind] ?? 0;
    const next = res.t.v === v ? v - 1 : v;
    res.t.v = clamp(next, floor, +(dotsEl.dataset.max || 10));
    rerenderFor(path);
  }

  /** Re-render only the block that owns `path`, then recompute. */
  function rerenderFor(path: string) {
    const k = path.split(':')[0];
    if (k === 'attr') renderAttrs();
    else if (k === 'abil' || k === 'craft' || k === 'style') renderAbils();
    else if (k === 'virtue' || k === 'wp' || k === 'ess') renderPower();
    else if (k === 'bg') renderBackgrounds();
    else if (k === 'col') renderColleges();
    recompute();
  }

  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    if (!target || ro()) return;

    const dot = target.closest<HTMLElement>('.dot');
    if (dot) {
      const wrap = dot.closest<HTMLElement>('.dots');
      if (wrap) { onDotClick(wrap, +(dot.dataset.v || 0)); return; }
    }

    const fav = target.closest<HTMLElement>('[data-fav]');
    if (fav) {
      if (fav.classList.contains('locked')) return;
      const [kind, id] = (fav.dataset.fav as string).split(':');
      const arr: string[] = kind === 'ability' ? S.favored.abilities : S.favored.attributes;
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1); else arr.push(id);
      renderIdentity();
      if (kind === 'ability') renderAbils(); else renderAttrs();
      recompute();
      return;
    }

    const spec = target.closest<HTMLElement>('[data-spec]');
    if (spec) { openSpecPop(spec); return; }

    const limit = target.closest<HTMLElement>('[data-limit]');
    if (limit) {
      const v = +(limit.dataset.limit as string);
      S.limit = S.limit === v ? v - 1 : v;
      renderPower(); recompute(); return;
    }

    const wpt = target.closest<HTMLElement>('[data-wptemp]');
    if (wpt) {
      const v = +(wpt.dataset.wptemp as string);
      S.willpowerTemp = S.willpowerTemp === v ? v - 1 : v;
      renderPower(); recompute(); return;
    }

    const hbox = target.closest<HTMLElement>('[data-hbox]');
    if (hbox) {
      const i = +(hbox.dataset.hbox as string);
      const order = ['', 'B', 'L', 'A'];
      S.health.marks[i] = order[(order.indexOf(S.health.marks[i] || '') + 1) % order.length];
      renderHealth(); recompute(); return;
    }

    const colfav = target.closest<HTMLElement>('[data-colfav]');
    if (colfav) {
      const c = S.colleges[+(colfav.dataset.colfav as string)];
      if (c) { c.favored = !c.favored; renderColleges(); recompute(); }
      return;
    }

    const del = target.closest<HTMLElement>('[data-del]');
    if (del) { removeItem(del.dataset.del as string); return; }

    const sq = target.closest<HTMLElement>('.sq');
    if (sq) {
      const pop = sq.closest<HTMLElement>('.specpop');
      if (pop) {
        const row = +(sq.dataset.row as string);
        const v = +(sq.dataset.v as string);
        const res = resolve(pop.dataset.path as string);
        if (res?.t?.specialties?.[row]) {
          const s = res.t.specialties[row];
          s.v = s.v === v ? v - 1 : v;
          drawSpecPop(pop);
          rerenderFor(pop.dataset.path as string);
        }
      }
      return;
    }

    if (target.closest('.specpop')) return;
    closeSpecPop();
  });

  /* section collapse (works even in read-only) */
  document.addEventListener('click', (ev) => {
    const head = (ev.target as HTMLElement).closest<HTMLElement>('h2.barh-tog');
    if (!head) return;
    const body = el('sec-' + head.dataset.sec);
    if (!body) return;
    const hidden = body.classList.toggle('sec-hidden');
    const caret = head.querySelector('.sec-caret');
    if (caret) caret.textContent = hidden ? '▸' : '▾';
  });

  /* keyboard on dot groups */
  document.addEventListener('keydown', (ev) => {
    if (ro()) return;
    const wrap = (ev.target as HTMLElement)?.closest?.<HTMLElement>('.dots');
    if (!wrap) return;
    const cur = +(wrap.getAttribute('aria-valuenow') || 0);
    const max = +(wrap.dataset.max || 10);
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { ev.preventDefault(); onDotClick(wrap, clamp(cur + 1, 0, max)); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { ev.preventDefault(); onDotClick(wrap, clamp(cur, 0, max)); }
  });

  /* text / number / select / checkbox input */

  /**
   * Re-rendering a block with innerHTML destroys the node the user is typing into.
   * Capture which field had focus (by its data-* attribute) and its caret, then put
   * both back on the replacement node.
   */
  function preserveFocus(fn: () => void) {
    const a = document.activeElement as HTMLInputElement | null;
    let key: [string, string] | null = null;
    let start: number | null = null;
    let end: number | null = null;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      for (const attr of Array.from(a.attributes)) {
        if (attr.name.startsWith('data-')) { key = [attr.name, attr.value]; break; }
      }
      // selectionStart throws on number/checkbox inputs in some browsers.
      try { start = a.selectionStart; end = a.selectionEnd; } catch { start = end = null; }
    }
    fn();
    if (!key || document.activeElement === a) return;
    const next = document.querySelector<HTMLInputElement>(
      `[${key[0]}="${key[1].replace(/["\\]/g, '\\$&')}"]`);
    if (!next) return;
    next.focus();
    if (start != null) {
      try { next.setSelectionRange(start, end ?? start); } catch { /* unsupported input type */ }
    }
  }

  function bindInput(ev: Event) {
    if (ro()) return;
    preserveFocus(() => applyInput(ev));
  }

  function applyInput(ev: Event) {
    const t = ev.target as HTMLInputElement & { dataset: any };
    if (!t || !t.dataset) return;
    const d = t.dataset;
    const iv = () => num(t.value, 0);

    if (d.id !== undefined && t.classList.contains('txt')) { S.id[d.id] = t.value; save(); return; }
    if (d.grant !== undefined) {
      const res = resolve(d.grant);
      if (res?.t) { res.t.granted = clamp(iv(), 0, 20); rerenderFor(d.grant); }
      return;
    }
    if (d.vf !== undefined) { S.virtueFlaw = t.value; save(); return; }
    if (d.adj !== undefined) { S.adjustment = iv(); recompute(); return; }
    if (d.subname !== undefined) {
      const res = resolve(d.subname);
      if (res?.t) { res.t.name = t.value; save(); }
      return;
    }
    if (d.bgname !== undefined) {
      const bg = S.backgrounds[+d.bgname];
      const wasAuto = bg.mystic === isMysticName(bg.name);
      bg.name = t.value;
      // Keep following the list while the player has not overridden the flag by hand.
      if (wasAuto) bg.mystic = isMysticName(t.value);
      renderBackgrounds(); recompute(); return;
    }
    if (d.bgmystic !== undefined) { S.backgrounds[+d.bgmystic].mystic = t.checked; renderBackgrounds(); recompute(); return; }
    if (d.colname !== undefined) { S.colleges[+d.colname].name = t.value; recompute(); return; }
    if (d.thname !== undefined) { S.thaumaturgy[+d.thname].name = t.value; save(); return; }
    if (d.thkind !== undefined) { S.thaumaturgy[+d.thkind].kind = t.value; renderOther(); recompute(); return; }
    if (d.thlevel !== undefined) { S.thaumaturgy[+d.thlevel].level = clamp(iv(), 0, 10); renderOther(); recompute(); return; }
    if (d.thfav !== undefined) { S.thaumaturgy[+d.thfav].favored = t.checked; renderOther(); recompute(); return; }
    if (d.mutname !== undefined) { S.mutations[+d.mutname].name = t.value; save(); return; }
    if (d.mutlevel !== undefined) { S.mutations[+d.mutlevel].level = iv(); renderOther(); recompute(); return; }
    if (d.mutneg !== undefined) { S.mutations[+d.mutneg].negative = t.checked; renderOther(); recompute(); return; }
    if (d.mfname !== undefined) { S.meritsFlaws[+d.mfname].name = t.value; save(); return; }
    if (d.mfpoints !== undefined) { S.meritsFlaws[+d.mfpoints].points = clamp(iv(), 0, 20); renderOther(); recompute(); return; }
    if (d.mfflaw !== undefined) { S.meritsFlaws[+d.mfflaw].flaw = t.checked; renderOther(); recompute(); return; }
    if (d.chcat !== undefined) { S.charms.list[+d.chcat].category = t.value; renderCharms(); recompute(); return; }
    if (d.cname !== undefined) { S.commitments[+d.cname].name = t.value; recompute(); return; }
    if (d.cmotes !== undefined) { S.commitments[+d.cmotes].motes = iv(); recompute(); return; }
    if (d.chname !== undefined) { S.charms.list[+d.chname].name = t.value; save(); return; }
    if (d.chfav !== undefined) { S.charms.list[+d.chfav].favored = t.checked; renderCharms(); recompute(); return; }
    if (d.chgr !== undefined) { S.charms.list[+d.chgr].granted = t.checked; renderCharms(); recompute(); return; }
    if (d.cbname !== undefined) { S.combos[+d.cbname].name = t.value; save(); return; }
    if (d.cbxp !== undefined) { S.combos[+d.cbxp].xp = iv(); recompute(); return; }
    if (d.circle !== undefined) { S.sorcery.circles[d.circle] = t.checked; renderSorcery(); recompute(); return; }
    if (d.spname !== undefined) { S.sorcery.spells[+d.spname].name = t.value; save(); return; }
    if (d.spcircle !== undefined) { S.sorcery.spells[+d.spcircle].circle = t.value; renderSorcery(); recompute(); return; }
    if (d.ox !== undefined) { S.health.extras[d.ox] = clamp(iv(), 0, 20); renderHealth(); recompute(); return; }
    if (d.wname !== undefined) { S.weapons[+d.wname].name = t.value; recompute(); return; }
    if (d.wabil !== undefined) { S.weapons[+d.wabil].ability = t.value; recompute(); return; }
    if (d.w !== undefined) {
      const [key, i] = d.w.split(':');
      S.weapons[+i][key] = key === 'damageType' ? t.value : iv();
      recompute(); return;
    }
    if (d.wprim !== undefined) {
      S.weapons.forEach((w: any, i: number) => (w.primary = i === +d.wprim));
      recompute(); return;
    }
    if (d.aname !== undefined) { S.armor[+d.aname].name = t.value; save(); return; }
    if (d.a !== undefined) {
      const [key, i] = d.a.split(':');
      S.armor[+i][key] = iv();
      recompute(); return;
    }
    if (d.aworn !== undefined) { S.armor[+d.aworn].worn = t.checked; recompute(); return; }
    if (d.note !== undefined) { S.notes[d.note] = t.value; save(); return; }
    if (d.specname !== undefined) {
      const pop = t.closest<HTMLElement>('.specpop');
      const res = resolve(pop?.dataset.path as string);
      if (res?.t?.specialties?.[+d.specname]) { res.t.specialties[+d.specname].name = t.value; save(); }
      return;
    }
  }
  document.addEventListener('input', bindInput);
  document.addEventListener('change', bindInput);

  function removeItem(path: string) {
    const [k, i] = path.split(':');
    const idx = +i;
    switch (k) {
      case 'craft': S.crafts.splice(idx, 1); renderAbils(); break;
      case 'bg': S.backgrounds.splice(idx, 1); renderBackgrounds(); break;
      case 'college': S.colleges.splice(idx, 1); renderColleges(); break;
      case 'thaum': S.thaumaturgy.splice(idx, 1); renderOther(); break;
      case 'mutation': S.mutations.splice(idx, 1); renderOther(); break;
      case 'meritflaw': S.meritsFlaws.splice(idx, 1); renderOther(); break;
      case 'commit': S.commitments.splice(idx, 1); renderCommitments(); break;
      case 'charm': S.charms.list.splice(idx, 1); renderCharms(); break;
      case 'combo': S.combos.splice(idx, 1); renderCharms(); break;
      case 'spell': S.sorcery.spells.splice(idx, 1); renderSorcery(); break;
      case 'weapon': S.weapons.splice(idx, 1); renderWeapons(); break;
      case 'armor': S.armor.splice(idx, 1); renderArmor(); break;
      default: return;
    }
    recompute();
  }

  /* ------------------------------------------------------ specialties */
  let specPop: HTMLElement | null = null;

  function closeSpecPop() {
    if (specPop) { specPop.remove(); specPop = null; }
  }

  function drawSpecPop(pop: HTMLElement) {
    const res = resolve(pop.dataset.path as string);
    if (!res?.t) return;
    const sp = splat();
    const fav = favOf('ability', res.id);
    const each = calc.flatCost('specialty', fav, sp);
    const list = res.t.specialties || (res.t.specialties = []);
    const name = res.t.name || abilityById(res.id)?.name || res.id;
    let h = `<div class="specpop-h">${esc(name)} specialties <small>· ${each} xp per dot</small></div>`;
    list.forEach((s: any, i: number) => {
      h += `<div class="specpop-row"><input data-specname="${i}" value="${esc(s.name)}" placeholder="Specialty" />`
        + '<span class="sqs">';
      for (let v = 1; v <= RULES.maxRating.specialty; v++) {
        h += `<button type="button" class="sq${v <= s.v ? ' on' : ''}" data-row="${i}" data-v="${v}" aria-label="${v}"></button>`;
      }
      h += `</span><button type="button" class="rowx" data-specdel="${i}" title="Remove">×</button></div>`;
    });
    h += '<button type="button" class="spec-add">+ specialty</button>'
      + '<div class="specpop-f"><button type="button" class="btn spec-close">Close</button></div>';
    pop.innerHTML = h;
  }

  function openSpecPop(btn: HTMLElement) {
    closeSpecPop();
    const path = btn.dataset.spec as string;
    const pop = document.createElement('div');
    pop.className = 'specpop';
    pop.dataset.path = path;
    document.body.appendChild(pop);
    specPop = pop;
    drawSpecPop(pop);

    const rect = btn.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 6;
    const left = Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 296);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(window.scrollX + 8, left)}px`;

    pop.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const res = resolve(path);
      if (t.classList.contains('spec-add')) {
        res?.t.specialties.push({ name: '', v: 1 });
        drawSpecPop(pop); rerenderFor(path);
      } else if (t.dataset.specdel !== undefined) {
        res?.t.specialties.splice(+(t.dataset.specdel as string), 1);
        drawSpecPop(pop); rerenderFor(path);
      } else if (t.classList.contains('spec-close')) {
        closeSpecPop();
      }
    });
  }

  /* ------------------------------------------------------- add buttons */
  const adders: Record<string, () => void> = {
    'craft-add': () => {
      S.crafts.push({ name: '', v: splat().floors.ability, granted: 0, specialties: [] });
      renderAbils();
    },
    'bg-add': () => { S.backgrounds.push({ name: '', mystic: false, v: 1, granted: 0 }); renderBackgrounds(); },
    'college-add': () => { S.colleges.push({ name: '', favored: false, v: 1, granted: 0 }); renderColleges(); },
    'thaum-add': () => { S.thaumaturgy.push({ name: '', kind: 'degree', level: 1, favored: false }); renderOther(); },
    'mut-add': () => { S.mutations.push({ name: '', level: RULES.mutationLevels[0], negative: false }); renderOther(); },
    'mf-add': () => { S.meritsFlaws.push({ name: '', points: 1, flaw: false }); renderOther(); },
    'commit-add': () => { S.commitments.push({ name: '', motes: 0 }); renderCommitments(); },
    'charm-add': () => { S.charms.list.push({ name: '', favored: false, granted: false, note: '' }); renderCharms(); },
    'charm-pick': () => { void pickCharms(); },
    'combo-add': () => { S.combos.push({ name: '', xp: 0 }); renderCharms(); },
    'spell-add': () => {
      const first = splat().sorcery.circles[0];
      S.sorcery.spells.push({ name: '', circle: first ? first.id : '' });
      renderSorcery();
    },
    'weapon-add': () => {
      const wd = RULES.weaponDefaults;
      S.weapons.push({ name: '', ability: 'melee', ...wd, tags: '', primary: !S.weapons.length });
      renderWeapons();
    },
    'armor-add': () => { S.armor.push({ name: '', ...RULES.armorDefaults, worn: true }); renderArmor(); },
  };
  for (const [id, fn] of Object.entries(adders)) {
    el(id)?.addEventListener('click', () => { if (ro()) return; fn(); recompute(); });
  }

  /* ------------------------------------------------- splat / caste swap */
  el('splat-sel').addEventListener('change', (ev) => {
    if (ro()) return;
    const next = (ev.target as HTMLSelectElement).value;
    S.splat = next;
    const sp = SPLAT_BY_ID[next];
    S.caste = sp.castes[0]?.id || '';
    S.favored = { abilities: [], attributes: [] };
    // Re-clamp anything that sits below the new splat's floors.
    for (const a of DATA.attributes) S.attrs[a.id].v = Math.max(S.attrs[a.id].v, sp.floors.attribute);
    for (const v of DATA.virtues) S.virtues[v.id].v = Math.max(S.virtues[v.id].v, sp.floors.virtue);
    S.willpower.v = Math.max(S.willpower.v, sp.floors.willpower);
    S.essence.v = Math.max(S.essence.v, sp.floors.essence);
    S = normalize(S);
    renderAll();
  });

  el('caste-sel').addEventListener('change', (ev) => {
    if (ro()) return;
    S.caste = (ev.target as HTMLSelectElement).value;
    renderIdentity();
    renderAttrs();
    renderAbils();
    recompute();
  });

  (el('xpBudget') as HTMLInputElement).addEventListener('input', (ev) => {
    if (ro()) return;
    S.budget = num((ev.target as HTMLInputElement).value, 0);
    recompute();
  });

  /* --------------------------------------------------- derived tooltip */
  let calcPop: HTMLElement | null = null;
  document.addEventListener('mouseover', (ev) => {
    const t = (ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-calc]');
    if (!t) return;
    if (calcPop) calcPop.remove();
    const pop = document.createElement('div');
    pop.className = 'calcpop';
    pop.textContent = t.dataset.calc as string;
    document.body.appendChild(pop);
    calcPop = pop;
    const rect = t.getBoundingClientRect();
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(
      rect.left + window.scrollX,
      window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 12))}px`;
  });
  document.addEventListener('mouseout', (ev) => {
    const t = (ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-calc]');
    if (t && calcPop) { calcPop.remove(); calcPop = null; }
  });

  /* ---------------------------------------------- export / import / etc */
  el('f-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.id.name ? S.id.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'exalted-sheet') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  el('f-import').addEventListener('click', () => (el('f-file') as HTMLInputElement).click());
  (el('f-file') as HTMLInputElement).addEventListener('change', (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        S = normalize(JSON.parse(String(fr.result)));
        renderAll();
        save();
      } catch {
        alert('That file is not a valid sheet export.');
      }
    };
    fr.readAsText(file);
    (ev.target as HTMLInputElement).value = '';
  });

  el('f-print').addEventListener('click', () => window.print());

  el('f-link').addEventListener('click', () => {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(S))));
    const url = location.origin + location.pathname + '#c=' + b64;
    navigator.clipboard?.writeText(url);
    const b = el('f-link');
    const old = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = old), 1200);
  });

  el('f-reset').addEventListener('click', () => {
    if (!confirm('Discard this character and start a blank sheet?')) return;
    S = fresh();
    opts.onReset?.();
    renderAll();
    save();
  });

  el('checks-toggle').addEventListener('click', () => {
    el('checks').classList.toggle('hidden');
  });

  /* ---------------------------------------------------- derived toggle */
  el('deriv-toggle').addEventListener('click', () => {
    const d = el('derived');
    const collapsed = d.classList.toggle('collapsed');
    el('deriv-toggle').textContent = collapsed ? 'Expand' : 'Collapse';
  });

  /* ----------------------------------------------------- portrait & gallery */

  const FRAME_W = 172, FRAME_H = 208;

  async function mountMedia(media: MediaAdapter) {
    el('media').hidden = false;
    const frame = el('pt-frame');
    const img = el('pt-img') as HTMLImageElement;
    const empty = el('pt-empty');
    const zoom = el('pt-zoom') as HTMLInputElement;
    const lightbox = el('pt-lightbox');
    const lbImg = el('pt-lb-img') as HTMLImageElement;

    let pos: PortraitPos = { x: 50, y: 50, z: 1 };
    let hasImage = false;

    const applyPos = () => {
      img.style.objectPosition = `${pos.x}% ${pos.y}%`;
      img.style.transformOrigin = `${pos.x}% ${pos.y}%`;
      img.style.transform = `scale(${pos.z})`;
      zoom.value = String(pos.z);
    };

    const paint = () => {
      frame.hidden = !hasImage;
      empty.hidden = hasImage;
      el('pt-pick').hidden = !media.canEdit;
      el('pt-del').hidden = !(media.canEdit && hasImage);
      el('pt-adjust').hidden = !(media.canEdit && hasImage);
      if (!(media.canEdit && hasImage)) zoom.hidden = true;
      const txt = el('pt-pick-txt');
      if (txt) txt.textContent = hasImage ? 'Replace' : 'Upload';
      el('gal-pick').hidden = !media.canEdit;
      el('gal-link').hidden = !media.canEdit;
    };

    const show = (url: string) => { img.src = url; lbImg.src = url; hasImage = true; paint(); applyPos(); };

    const existing = await media.getPortrait();
    if (existing) { pos = existing.pos; show(existing.url); } else paint();

    if (media.canEdit) {
      (el('pt-file') as HTMLInputElement).addEventListener('change', async (ev) => {
        const file = (ev.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const next = await media.setPortrait(file);
        if (next) { pos = { x: 50, y: 50, z: 1 }; show(next.url); media.savePortraitPos(pos); }
        (ev.target as HTMLInputElement).value = '';
      });

      el('pt-del').addEventListener('click', async () => {
        if (!confirm('Remove the portrait?')) return;
        await media.clearPortrait();
        img.src = ''; lbImg.src = ''; hasImage = false;
        frame.classList.remove('adjusting'); zoom.hidden = true;
        paint();
      });

      // Adjust mode: drag to pan, slider to zoom. Only the card is reframed;
      // the lightbox always shows the whole image.
      let adjusting = false, dragging = false, lastX = 0, lastY = 0;
      const adjustBtn = el('pt-adjust');
      adjustBtn.addEventListener('click', () => {
        adjusting = !adjusting;
        frame.classList.toggle('adjusting', adjusting);
        zoom.hidden = !adjusting;
        adjustBtn.textContent = adjusting ? 'Done' : 'Adjust';
      });
      frame.addEventListener('pointerdown', (ev) => {
        if (!adjusting) return;
        const pe = ev as PointerEvent;
        dragging = true; lastX = pe.clientX; lastY = pe.clientY;
        frame.setPointerCapture?.(pe.pointerId);
      });
      frame.addEventListener('pointermove', (ev) => {
        if (!adjusting || !dragging) return;
        const pe = ev as PointerEvent;
        const dx = pe.clientX - lastX, dy = pe.clientY - lastY;
        lastX = pe.clientX; lastY = pe.clientY;
        pos.x = clamp(pos.x - (dx / (FRAME_W * pos.z)) * 100, 0, 100);
        pos.y = clamp(pos.y - (dy / (FRAME_H * pos.z)) * 100, 0, 100);
        applyPos();
      });
      const drop = () => { if (dragging) { dragging = false; media.savePortraitPos(pos); } };
      frame.addEventListener('pointerup', drop);
      frame.addEventListener('pointercancel', drop);
      zoom.addEventListener('input', () => {
        pos.z = parseFloat(zoom.value) || 1;
        applyPos();
        media.savePortraitPos(pos);
      });

      (el('gal-file') as HTMLInputElement).addEventListener('change', async (ev) => {
        const file = (ev.target as HTMLInputElement).files?.[0];
        if (file) { await media.addFile(file); await refreshGallery(); }
        (ev.target as HTMLInputElement).value = '';
      });
      el('gal-link').addEventListener('click', async () => { await media.addLink(); await refreshGallery(); });
    }

    frame.addEventListener('click', () => {
      if (frame.classList.contains('adjusting') || !hasImage) return;
      lightbox.hidden = false;
      document.body.style.overflow = 'hidden';
    });
    const closeLightbox = () => { lightbox.hidden = true; document.body.style.overflow = ''; };
    lightbox.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !lightbox.hidden) closeLightbox(); });

    async function refreshGallery() {
      const items = await media.listItems();
      const list = el('gal-list');
      list.innerHTML = items.length
        ? items.map((it) => `<div class="gal-row" data-item="${esc(it.id)}">`
            + `<a href="#" data-open>${esc(it.name)}</a>`
            + `<span class="gal-kind">${it.kind}</span>`
            + (media.canEdit ? '<button type="button" class="rowx" data-remove title="Remove">×</button>' : '')
            + '</div>').join('')
        : '<div class="empty">Nothing here yet.</div>';
      for (const row of Array.from(list.querySelectorAll<HTMLElement>('[data-item]'))) {
        const item = items.find((i) => i.id === row.dataset.item)!;
        row.querySelector('[data-open]')!.addEventListener('click', (ev) => { ev.preventDefault(); item.open(); });
        row.querySelector('[data-remove]')?.addEventListener('click', async () => {
          if (!confirm(`Remove "${item.name}"?`)) return;
          await media.removeItem(item.id);
          await refreshGallery();
        });
      }
    }
    await refreshGallery();
  }

  /* ------------------------------------------------------------- boot */
  (async () => {
    let raw: any = null;
    try { raw = await opts.load(); } catch { raw = null; }
    S = normalize(raw);
    if (opts.budgetValue != null) S.budget = opts.budgetValue;
    const budgetInput = el('xpBudget') as HTMLInputElement;
    if (opts.budgetLocked) budgetInput.disabled = true;
    if (ro()) {
      for (const n of Array.from(document.querySelectorAll<HTMLInputElement>('input, select, textarea'))) n.disabled = true;
    }
    renderAll();
    booting = false;
    save();
    warmCharmSets();
    if (opts.media) {
      try { await mountMedia(opts.media); } catch { /* storage down: the sheet still works */ }
    }
  })();
}
