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
import { SPLATS, SPLAT_BY_ID, DATA, RULES, BACKGROUNDS, ATTRIBUTE_GROUPS, ABILITY_GROUPS } from './data';

export interface SheetOpts {
  load: () => any | null | Promise<any | null>;
  save: (state: any) => void;
  budgetLocked?: boolean;
  budgetValue?: number | null;
  onReset?: () => void;
  readOnly?: boolean;
}

const SCHEMA = 1;
const DOT_MAX = RULES.maxRating;

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

  /* ------------------------------------------------------ default state */
  function fresh() {
    const sp = SPLAT_BY_ID[RULES.defaultSplat] || SPLATS[0];
    const st: any = {
      meta: { schema: SCHEMA },
      id: { name: '', player: '', concept: '', motivation: '', anima: '', sobriquet: '' },
      splat: sp.id,
      caste: sp.castes[0].id,
      favored: { abilities: [], attributes: [] },
      attrs: {},
      abils: {},
      crafts: [],
      styles: [],
      virtues: {},
      virtueFlaw: '',
      limit: 0,
      willpower: { v: sp.floors.willpower, granted: 0 },
      willpowerTemp: sp.floors.willpower,
      essence: { v: sp.floors.essence, granted: 0 },
      backgrounds: [],
      charms: { list: [] },
      combos: [],
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
    st.caste = sp.castes.some((c: any) => c.id === raw.caste) ? raw.caste : sp.castes[0].id;

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
          .map((s: any) => ({ name: String(s?.name ?? ''), v: clamp(num(s?.v, 1), 0, DOT_MAX.specialty) }));
      }
      return t;
    };

    for (const a of DATA.attributes) st.attrs[a.id] = trait(raw.attrs?.[a.id], sp.floors.attribute);
    for (const a of DATA.abilities) {
      if (a.sub) continue;
      st.abils[a.id] = trait(raw.abils?.[a.id], sp.floors.ability, true);
    }
    for (const v of DATA.virtues) st.virtues[v.id] = trait(raw.virtues?.[v.id], sp.floors.virtue);

    const subList = (arr: any) => (Array.isArray(arr) ? arr : []).map((c: any) => ({
      name: String(c?.name ?? ''), ...trait(c, sp.floors.ability, true),
    }));
    st.crafts = subList(raw.crafts);
    st.styles = subList(raw.styles);

    st.virtueFlaw = String(raw.virtueFlaw ?? '');
    st.limit = clamp(num(raw.limit, 0), 0, sp.limit.boxes);
    st.willpower = trait(raw.willpower, sp.floors.willpower);
    st.essence = trait(raw.essence, sp.floors.essence);
    st.willpowerTemp = clamp(num(raw.willpowerTemp, st.willpower.v), 0, 20);

    st.backgrounds = (Array.isArray(raw.backgrounds) ? raw.backgrounds : []).map((b: any) => ({
      name: String(b?.name ?? ''), ...trait(b, sp.floors.background),
    }));

    st.charms = {
      list: (Array.isArray(raw.charms?.list) ? raw.charms.list : []).map((c: any) => ({
        name: String(c?.name ?? ''), favored: !!c?.favored, note: String(c?.note ?? ''),
      })),
    };
    st.combos = (Array.isArray(raw.combos) ? raw.combos : []).map((c: any) => ({
      name: String(c?.name ?? ''), xp: num(c?.xp, 0),
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
      case 'abil': return { t: S.abils[key], kind: 'ability', id: key };
      case 'craft': return { t: S.crafts[+key], kind: 'ability', id: 'craft' };
      case 'style': return { t: S.styles[+key], kind: 'ability', id: 'martial-arts' };
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
    el('caste-label-wrap').childNodes[0].nodeValue = sp.casteLabel;
    (el('caste-sel') as HTMLSelectElement).innerHTML =
      sp.castes.map((c: any) => `<option value="${c.id}"${c.id === S.caste ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    for (const inp of Array.from(document.querySelectorAll<HTMLInputElement>('.idrow .txt'))) {
      inp.value = S.id[inp.dataset.id as string] || '';
      inp.disabled = ro();
    }

    const kindLabel = sp.favoredKind === 'ability' ? 'Abilities' : 'Attributes';
    const caste = sp.castes.find((c: any) => c.id === S.caste);
    const names = (caste?.traits || []).map((t: string) => {
      const rec = sp.favoredKind === 'ability' ? abilityById(t) : DATA.attributes.find((a) => a.id === t);
      return rec ? rec.name : t;
    });
    const picks = sp.favoredKind === 'ability' ? S.favored.abilities : S.favored.attributes;
    let info = `<b>${esc(caste?.name || '')}</b> ${sp.casteLabel} ${kindLabel.toLowerCase()}: `
      + (names.length ? esc(names.join(', ')) : '<i>none defined</i>')
      + ` · Favored picks <b>${picks.length}/${sp.favoredPicks}</b>`
      + ` · Floors: Attribute ${sp.floors.attribute}, Ability ${sp.floors.ability}, Virtue ${sp.floors.virtue},`
      + ` Willpower ${sp.floors.willpower}, Essence ${sp.floors.essence}`;
    if (!sp.verified || sp._todo) {
      info += `<div class="warn-todo"><b>Unverified data.</b> ${esc(
        Array.isArray(sp._todo) ? sp._todo.join(' ') : sp._todo || 'This splat still carries placeholder numbers.')}</div>`;
    }
    el('caste-info').innerHTML = info;

    el('attr-hint').textContent = sp.favoredKind === 'attribute'
      ? `(floor ${sp.floors.attribute} · C = ${sp.casteLabel}, F = Favored)`
      : `(floor ${sp.floors.attribute})`;
    el('abil-hint').textContent = sp.favoredKind === 'ability'
      ? `(floor ${sp.floors.ability} · C = ${sp.casteLabel}, F = Favored · ✦ specialties)`
      : `(floor ${sp.floors.ability} · ✦ specialties)`;

    document.documentElement.style.setProperty('--accent', caste?.accent || sp.accent);
    document.documentElement.style.setProperty('--accent-soft', sp.accentSoft);
  }

  /** C / F tags. Only rendered live for the kind this splat favors. */
  function tags(kind: string, id: string) {
    const sp = splat();
    if (kind !== sp.favoredKind) return '<span class="tag ghost">C</span><span class="tag ghost">F</span>';
    const isCaste = calc.isCaste(id, kind, sp, S.caste);
    const picks = kind === 'ability' ? S.favored.abilities : S.favored.attributes;
    const isPick = picks.includes(id);
    return `<span class="tag${isCaste ? ' on locked' : ''}" title="${esc(sp.casteLabel)}">C</span>`
      + `<button type="button" class="tag${isPick ? ' on' : ''}${isCaste ? ' locked' : ''}"
           data-fav="${kind}:${id}" title="Favored">F</button>`;
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
          + dots(`attr:${a.id}`, t.v, free, DOT_MAX.attribute)
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
      ? `<input class="lname nm" data-subname="${path}" value="${esc(t.name || '')}" placeholder="name" />`
      : `<span class="nm${fav ? ' fav' : ''}">${esc(name)}</span>`;
    return `<div class="trow">${nameCell}`
      + tags('ability', id)
      + dots(path, t.v, free, DOT_MAX.ability)
      + `<button type="button" class="specbtn${specCount ? ' has' : ''}" data-spec="${path}"
           title="Specialties">◆</button>`
      + grantInput(path, t.granted)
      + xpChip(traitXpOf('ability', id, t) + specCount * calc.flatCost('specialty', fav, sp))
      + (editableName ? `<button type="button" class="rowx" data-del="${path}" title="Remove">×</button>` : '')
      + `</div>`;
  }

  function renderAbils() {
    let h = '';
    for (const g of ABILITY_GROUPS) {
      const list = DATA.abilities.filter((x) => x.group === g.id && !x.sub);
      if (!list.length) continue;
      h += `<div><h3 class="grph">${g.name}</h3>`;
      for (const a of list) h += abilityRow(`abil:${a.id}`, a.name, a.id, S.abils[a.id]);
      h += '</div>';
    }
    el('abils').innerHTML = h;

    const sub = (key: 'crafts' | 'styles', id: string, target: string, empty: string) => {
      const arr = S[key];
      el(target).innerHTML = arr.length
        ? arr.map((t: any, i: number) => abilityRow(`${key === 'crafts' ? 'craft' : 'style'}:${i}`, '', id, t, true)).join('')
        : `<div class="empty">${empty}</div>`;
    };
    sub('crafts', 'craft', 'crafts', 'No Craft types yet.');
    sub('styles', 'martial-arts', 'styles', 'No Martial Arts styles yet.');
  }

  function renderPower() {
    const sp = splat();
    let h = '<h3 class="grph">Virtues</h3>';
    for (const v of DATA.virtues) {
      const t = S.virtues[v.id];
      h += `<div class="trow"><span class="nm">${esc(v.name)}</span>`
        + '<span class="tag ghost">C</span><span class="tag ghost">F</span>'
        + dots(`virtue:${v.id}`, t.v, Math.max(sp.floors.virtue, t.granted), DOT_MAX.virtue)
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
      + dots('wp:x', wp.v, Math.max(sp.floors.willpower, wp.granted), DOT_MAX.willpower)
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
      + dots('ess:x', ess.v, Math.max(sp.floors.essence, ess.granted), DOT_MAX.essence)
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
          + `<input class="lname" list="bg-list" data-bgname="${i}" value="${esc(b.name)}" placeholder="Background" />`
          + dots(`bg:${i}`, b.v, Math.max(sp.floors.background, b.granted), DOT_MAX.background)
          + grantInput(`bg:${i}`, b.granted)
          + xpChip(calc.traitXp('background', b.v, b.granted, false, sp))
          + `<button type="button" class="rowx" data-del="bg:${i}" title="Remove">×</button></div>`).join('')
      : '<div class="empty">No backgrounds yet.</div>';
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
    el('pools').innerHTML =
      row('Personal', personal.value, personal.formula)
      + row('Peripheral', peripheral.value, peripheral.formula)
      + row('Total', total, `Personal ${personal.value} + Peripheral ${peripheral.value} = ${total}`)
      + row('Committed', committed, S.commitments.length
          ? S.commitments.map((c: any) => `${c.name || 'unnamed'} ${c.motes}`).join(' + ') + ` = ${committed}`
          : 'Nothing committed')
      + row('Available', total - committed, `${total} − ${committed} = ${total - committed}`);
  }

  function renderCharms() {
    const sp = splat();
    el('charms').innerHTML =
      `<div class="lrow head"><span style="flex:1">Charm</span><span style="width:3.2rem;text-align:center">Fav</span><span style="width:2.6rem;text-align:right">XP</span><span style="width:1.4rem"></span></div>`
      + (S.charms.list.length
        ? S.charms.list.map((c: any, i: number) => `<div class="lrow">`
            + `<input class="lname" data-chname="${i}" value="${esc(c.name)}" placeholder="Charm name" />`
            + `<label class="lbl" style="width:3.2rem;justify-content:center;display:flex">`
            + `<input type="checkbox" data-chfav="${i}"${c.favored ? ' checked' : ''} /></label>`
            + `<span class="xpc paid" style="width:2.6rem">${calc.flatCost('charm', c.favored, sp)}</span>`
            + `<button type="button" class="rowx" data-del="charm:${i}" title="Remove">×</button></div>`).join('')
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
      + r('Personal Essence', personal.value, personal.formula)
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
      spells: 'Spells', combos: 'Combos', adjustment: 'Adjustment',
    };
    el('xpBreak').textContent = Object.entries(b)
      .filter(([, v]) => v)
      .map(([k, v]) => `${label[k]} ${v}`)
      .join(' · ') || 'Nothing spent yet';

    renderPools();
    renderCombat();
    renderDerived();
    save();
  }

  function renderAll() {
    renderIdentity();
    renderAttrs();
    renderAbils();
    renderPower();
    renderBackgrounds();
    renderCharms();
    renderSorcery();
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
    res.t.v = res.t.v === v ? v - 1 : v;
    res.t.v = clamp(res.t.v, 0, +(dotsEl.dataset.max || 10));
    rerenderFor(path);
  }

  /** Re-render only the block that owns `path`, then recompute. */
  function rerenderFor(path: string) {
    const k = path.split(':')[0];
    if (k === 'attr') renderAttrs();
    else if (k === 'abil' || k === 'craft' || k === 'style') renderAbils();
    else if (k === 'virtue' || k === 'wp' || k === 'ess') renderPower();
    else if (k === 'bg') renderBackgrounds();
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
    if (d.bgname !== undefined) { S.backgrounds[+d.bgname].name = t.value; recompute(); return; }
    if (d.cname !== undefined) { S.commitments[+d.cname].name = t.value; recompute(); return; }
    if (d.cmotes !== undefined) { S.commitments[+d.cmotes].motes = iv(); recompute(); return; }
    if (d.chname !== undefined) { S.charms.list[+d.chname].name = t.value; save(); return; }
    if (d.chfav !== undefined) { S.charms.list[+d.chfav].favored = t.checked; renderCharms(); recompute(); return; }
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
      case 'style': S.styles.splice(idx, 1); renderAbils(); break;
      case 'bg': S.backgrounds.splice(idx, 1); renderBackgrounds(); break;
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
      for (let v = 1; v <= DOT_MAX.specialty; v++) {
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
    'craft-add': () => { S.crafts.push({ name: '', v: 0, granted: 0, specialties: [] }); renderAbils(); },
    'style-add': () => { S.styles.push({ name: '', v: 0, granted: 0, specialties: [] }); renderAbils(); },
    'bg-add': () => { S.backgrounds.push({ name: '', v: 1, granted: 0 }); renderBackgrounds(); },
    'commit-add': () => { S.commitments.push({ name: '', motes: 0 }); renderCommitments(); },
    'charm-add': () => { S.charms.list.push({ name: '', favored: false, note: '' }); renderCharms(); },
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
    S.caste = sp.castes[0].id;
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

  /* ---------------------------------------------------- derived toggle */
  el('deriv-toggle').addEventListener('click', () => {
    const d = el('derived');
    const collapsed = d.classList.toggle('collapsed');
    el('deriv-toggle').textContent = collapsed ? 'Expand' : 'Collapse';
  });

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
  })();
}
