/**
 * The Charm picker.
 *
 * An overlay over the sheet: pick a set, search it, and click charms on and off.
 * It never refuses a purchase. Anything the character is short of is spelled out
 * under the row, because at a table the Storyteller decides, not the sheet.
 */
import {
  loadIndex, loadSet, loadText, categoryFor, minsLabel, problemsFor, setsFor,
  type Charm, type CharmSet, type SetInfo,
} from './charms';

const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export interface PickerOpts {
  splatId: string;
  /** Keys already on the sheet, as "setId:charmId". */
  owned: () => Set<string>;
  /** Enough of the sheet to work out what is missing. */
  sheet: () => any;
  traitName: (id: string) => string;
  /** Called when a row is clicked. Returns once the sheet has been updated. */
  onToggle: (set: CharmSet, charm: Charm, add: boolean, category: string) => void;
}

export async function openCharmPicker(opts: PickerOpts) {
  const dlg = document.createElement('dialog');
  dlg.className = 'charm-picker';
  dlg.innerHTML =
    `<header>`
    + `<h2>Charms</h2>`
    + `<button type="button" class="btn tiny" data-close>Done</button>`
    + `</header>`
    + `<nav class="cp-sets"></nav>`
    + `<div class="cp-tools">`
    + `<input type="search" class="cp-search" placeholder="Search this list" />`
    + `<label class="cp-only"><input type="checkbox" class="cp-avail" /> only what I qualify for</label>`
    + `<span class="cp-count"></span>`
    + `</div>`
    + `<div class="cp-body"><p class="cp-note">Loading…</p></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  let info: SetInfo[] = [];
  let current: CharmSet | null = null;
  let query = '';
  let onlyAvailable = false;
  const open = new Set<string>();

  const body = dlg.querySelector('.cp-body') as HTMLElement;
  const search = dlg.querySelector('.cp-search') as HTMLInputElement;

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-close]')!.addEventListener('click', close);
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });

  try {
    info = setsFor(opts.splatId, await loadIndex());
  } catch {
    body.innerHTML = '<p class="cp-note">The Charm lists could not be loaded.</p>';
    return;
  }

  const nav = dlg.querySelector('.cp-sets') as HTMLElement;
  nav.innerHTML = info.map((s, i) =>
    `<button type="button" class="cp-chip${i ? '' : ' on'}" data-set="${esc(s.id)}">`
    + `${esc(s.name)}<small>${s.count}</small></button>`).join('');
  nav.addEventListener('click', (ev) => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>('[data-set]');
    if (!chip) return;
    nav.querySelectorAll('.cp-chip').forEach((c) => c.classList.toggle('on', c === chip));
    show(chip.dataset.set!);
  });

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  (dlg.querySelector('.cp-avail') as HTMLInputElement)
    .addEventListener('change', (ev) => {
      onlyAvailable = (ev.target as HTMLInputElement).checked;
      render();
    });

  body.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const more = target.closest<HTMLElement>('[data-more]');
    if (more) {
      const id = more.dataset.more!;
      if (open.has(id)) open.delete(id); else open.add(id);
      if (open.has(id) && current) await loadText(current.id).catch(() => ({}));
      render();
      return;
    }
    const row = target.closest<HTMLElement>('[data-charm]');
    if (!row || !current) return;
    const charm = current.charms.find((c) => c.id === row.dataset.charm);
    if (!charm) return;
    const key = `${current.id}:${charm.id}`;
    opts.onToggle(current, charm, !opts.owned().has(key), categoryFor(current, opts.splatId));
    render();
  });

  async function show(id: string) {
    body.innerHTML = '<p class="cp-note">Loading…</p>';
    try {
      current = await loadSet(id);
    } catch {
      body.innerHTML = '<p class="cp-note">That list could not be loaded.</p>';
      return;
    }
    query = '';
    search.value = '';
    open.clear();
    render();
  }

  function render() {
    if (!current) return;
    const set = current;
    const owned = opts.owned();
    const state = opts.sheet();
    const text = textCache(set.id);
    const category = categoryFor(set, opts.splatId);

    const withProblems = set.charms.map((c) => ({
      charm: c,
      problems: problemsFor(c, set, { ...state, owned }, opts.traitName),
    }));

    const shown = withProblems.filter(({ charm, problems }) => {
      if (onlyAvailable && problems.length) return false;
      if (!query) return true;
      const tree = set.trees.find((t) => t.id === charm.t);
      return (charm.n + ' ' + (tree?.name || '') + ' ' + (charm.kw || ''))
        .toLowerCase().includes(query);
    });

    (dlg.querySelector('.cp-count') as HTMLElement).textContent =
      `${shown.length} of ${set.charms.length}`;

    if (!shown.length) {
      body.innerHTML = '<p class="cp-note">Nothing matches.</p>';
      return;
    }

    const byTree = new Map<string, typeof shown>();
    for (const row of shown) {
      if (!byTree.has(row.charm.t)) byTree.set(row.charm.t, []);
      byTree.get(row.charm.t)!.push(row);
    }

    let html = '';
    let group: string | null = null;
    for (const tree of set.trees) {
      const rows = byTree.get(tree.id);
      if (!rows) continue;
      if ((tree.group || null) !== group) {
        group = tree.group || null;
        if (group) html += `<h3 class="cp-group">${esc(group)}</h3>`;
      }
      html += `<h4 class="cp-tree">${esc(tree.name)}`
        + (tree.sub ? ` <small>${esc(tree.sub)}</small>` : '')
        + `</h4>`;
      for (const { charm, problems } of rows) {
        const key = `${set.id}:${charm.id}`;
        const has = owned.has(key);
        const mins = minsLabel(charm, opts.traitName);
        const isOpen = open.has(charm.id);
        html += `<div class="cp-row${has ? ' has' : ''}${problems.length ? ' warn' : ''}">`
          + `<button type="button" class="cp-take" data-charm="${esc(charm.id)}"`
          + ` aria-pressed="${has}" title="${has ? 'Remove from the sheet' : 'Add to the sheet'}">`
          + `<span class="cp-tick">${has ? '✓' : '+'}</span>`
          + `<span class="cp-name">${esc(charm.n)}</span>`
          + (mins ? `<span class="cp-mins">${esc(mins)}</span>` : '')
          + `</button>`
          + `<button type="button" class="cp-more" data-more="${esc(charm.id)}"`
          + ` aria-expanded="${isOpen}" title="Show the rules">${isOpen ? '▾' : '▸'}</button>`;
        if (problems.length) {
          html += `<div class="cp-warn">needs ${problems.map((p) => esc(p.text)).join(' · ')}</div>`;
        }
        if (isOpen) {
          const stat = [
            charm.cost && `<b>Cost:</b> ${esc(charm.cost)}`,
            mins && `<b>Mins:</b> ${esc(mins)}`,
            charm.type && `<b>Type:</b> ${esc(charm.type)}`,
            charm.kw && `<b>Keywords:</b> ${esc(charm.kw)}`,
            charm.dur && `<b>Duration:</b> ${esc(charm.dur)}`,
            charm.pre && `<b>Prerequisites:</b> ${esc(charm.pre)}`,
          ].filter(Boolean).join(' · ');
          const prose = text?.[charm.id];
          html += `<div class="cp-detail"><p class="cp-stat">${stat}</p>`
            + `<p class="cp-prose">${prose ? esc(prose) : 'Loading the text…'}</p>`
            + `<p class="cp-src">${esc(charm.src || set.name)}${charm.p ? `, p. ${charm.p}` : ''}`
            + ` · costs the ${category === 'sidereal-ma' ? 'Sidereal Martial Arts'
              : category === 'other' ? 'out-of-type Charm' : 'Charm'} price</p></div>`;
        }
        html += `</div>`;
      }
    }
    body.innerHTML = html;
  }

  /** Prose already fetched for this set, if any. */
  const loaded: Record<string, Record<string, string>> = {};
  function textCache(id: string) {
    if (!(id in loaded)) {
      loaded[id] = {};
      loadText(id).then((t) => { loaded[id] = t; if (open.size) render(); }).catch(() => {});
    }
    return loaded[id];
  }

  await show(info[0].id);
}
