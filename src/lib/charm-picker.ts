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
import { detailHtml, depths, esc, statLine } from './charm-detail';

/**
 * How the list is laid out. A Charm tree is not really a list, and reading one as a
 * list is what this exists to fix.
 *
 *   rows   the original: one line each, open one to read it
 *   cards  a grid, every card already showing cost, type and duration
 *   table  dense columns, for comparing many Charms at once
 *
 * Cards and table order each tree by prerequisite depth, so entry points come first
 * and nothing appears before the Charm that opens it.
 */
type View = 'rows' | 'cards' | 'table';
const VIEWS: { id: View; name: string; hint: string }[] = [
  { id: 'rows',  name: 'List',  hint: 'One line per Charm; open one to read it' },
  { id: 'cards', name: 'Cards', hint: 'A grid, with cost and duration always showing' },
  { id: 'table', name: 'Table', hint: 'Dense columns, for comparing many at once' },
];
const VIEW_KEY = 'exalted:charm-view';
const readView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    return VIEWS.some((x) => x.id === v) ? v! : 'rows';
  } catch { return 'rows'; }
};

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
    + `<span class="cp-views" role="group" aria-label="Layout">`
    + VIEWS.map((v) => `<button type="button" class="cp-view" data-view="${v.id}"`
        + ` title="${esc(v.hint)}" aria-pressed="false">${esc(v.name)}</button>`).join('')
    + `</span>`
    + `<span class="cp-count"></span>`
    + `</div>`
    + `<div class="cp-body"><p class="cp-note">Loading…</p></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  let info: SetInfo[] = [];
  let current: CharmSet | null = null;
  let query = '';
  let onlyAvailable = false;
  let view: View = readView();
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

  dlg.querySelector('.cp-views')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (!b) return;
    view = b.dataset.view as View;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private window */ }
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

    for (const b of Array.from(dlg.querySelectorAll<HTMLElement>('[data-view]'))) {
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    }

    const depthOf = new Map<string, number>();
    for (const tree of set.trees) for (const [id, d] of depths(set, tree.id)) depthOf.set(id, d);

    /** Sorted the way this view reads best: by prerequisite depth, then by name. */
    const ordered = (rows: typeof shown) =>
      view === 'rows' ? rows
        : [...rows].sort((a, b) =>
            (depthOf.get(a.charm.id) ?? 0) - (depthOf.get(b.charm.id) ?? 0)
            || a.charm.n.localeCompare(b.charm.n));

    const tick = (charm: Charm, has: boolean) =>
      `<span class="cp-tick">${has ? '✓' : '+'}</span>`;
    const moreBtn = (charm: Charm, isOpen: boolean) =>
      `<button type="button" class="cp-more" data-more="${esc(charm.id)}"`
      + ` aria-expanded="${isOpen}" title="Show the rules">${isOpen ? '▾' : '▸'}</button>`;
    const warnOf = (problems: { text: string }[]) =>
      problems.length
        ? `<div class="cp-warn">needs ${problems.map((p) => esc(p.text)).join(' · ')}</div>` : '';
    const detail = (charm: Charm) =>
      detailHtml(charm, set, { traitName: opts.traitName, prose: text?.[charm.id], category });

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

      if (view === 'rows') {
        for (const { charm, problems } of rows) {
          const has = owned.has(`${set.id}:${charm.id}`);
          const mins = minsLabel(charm, opts.traitName);
          const isOpen = open.has(charm.id);
          html += `<div class="cp-row${has ? ' has' : ''}${problems.length ? ' warn' : ''}">`
            + `<button type="button" class="cp-take" data-charm="${esc(charm.id)}"`
            + ` aria-pressed="${has}" title="${has ? 'Remove from the sheet' : 'Add to the sheet'}">`
            + tick(charm, has)
            + `<span class="cp-name">${esc(charm.n)}</span>`
            + (mins ? `<span class="cp-mins">${esc(mins)}</span>` : '')
            + `</button>`
            + moreBtn(charm, isOpen)
            + warnOf(problems)
            + (isOpen ? detail(charm) : '')
            + `</div>`;
        }
      } else if (view === 'cards') {
        html += `<div class="cp-cards">`;
        for (const { charm, problems } of ordered(rows)) {
          const has = owned.has(`${set.id}:${charm.id}`);
          const isOpen = open.has(charm.id);
          const d = depthOf.get(charm.id) ?? 0;
          html += `<article class="cp-card${has ? ' has' : ''}${problems.length ? ' warn' : ''}">`
            + `<button type="button" class="cp-take" data-charm="${esc(charm.id)}"`
            + ` aria-pressed="${has}" title="${has ? 'Remove from the sheet' : 'Add to the sheet'}">`
            + tick(charm, has)
            + `<span class="cp-name">${esc(charm.n)}</span>`
            + `<span class="cp-depth" title="${d ? `Opens after ${d} Charm${d > 1 ? 's' : ''} in this tree` : 'An entry point into this tree'}">${d ? `tier ${d + 1}` : 'entry'}</span>`
            + `</button>`
            + `<p class="cp-stat">${statLine(charm, opts.traitName)}</p>`
            + warnOf(problems)
            + `<div class="cp-cardfoot">${moreBtn(charm, isOpen)}</div>`
            + (isOpen ? detail(charm) : '')
            + `</article>`;
        }
        html += `</div>`;
      } else {
        html += `<div class="cp-tablewrap"><table class="cp-table">`
          + `<thead><tr><th></th><th>Charm</th><th>Mins</th><th>Cost</th><th>Type</th>`
          + `<th>Duration</th><th></th></tr></thead><tbody>`;
        for (const { charm, problems } of ordered(rows)) {
          const has = owned.has(`${set.id}:${charm.id}`);
          const isOpen = open.has(charm.id);
          html += `<tr class="cp-trow${has ? ' has' : ''}${problems.length ? ' warn' : ''}"`
            + ` data-charm="${esc(charm.id)}" title="${has ? 'Remove from the sheet' : 'Add to the sheet'}">`
            + `<td class="cp-tcell-tick">${tick(charm, has)}</td>`
            + `<td class="cp-tname">${esc(charm.n)}`
            + (problems.length
              ? `<small>needs ${problems.map((p) => esc(p.text)).join(' · ')}</small>` : '')
            + `</td>`
            + `<td>${esc(minsLabel(charm, opts.traitName))}</td>`
            + `<td>${esc(charm.cost || '')}</td>`
            + `<td>${esc(charm.type || '')}</td>`
            + `<td>${esc(charm.dur || '')}</td>`
            + `<td class="cp-tcell-more">${moreBtn(charm, isOpen)}</td>`
            + `</tr>`;
          if (isOpen) {
            html += `<tr class="cp-tdetail"><td colspan="7">${detail(charm)}</td></tr>`;
          }
        }
        html += `</tbody></table></div>`;
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
