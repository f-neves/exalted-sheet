/**
 * Themed replacements for window.alert / confirm / prompt.
 *
 * Native dialogs cannot be styled and block the page; these are <dialog> elements
 * built on demand and removed on close. Enter submits, Escape and backdrop cancel.
 */

export interface Field {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'textarea';
  required?: boolean;
  hint?: string;
}

interface Config {
  title: string;
  message?: string;
  fields?: Field[];
  ok?: string;
  cancel?: string | null;
  danger?: boolean;
}

const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function build(cfg: Config): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ui-dlg' + (cfg.danger ? ' danger' : '');

    const fields = (cfg.fields || []).map((f) => {
      const id = `dlg-${f.name}`;
      const input = f.type === 'textarea'
        ? `<textarea id="${id}" name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" rows="4">${esc(f.value || '')}</textarea>`
        : `<input id="${id}" name="${esc(f.name)}" type="${f.type === 'number' ? 'number' : 'text'}"
             value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" />`;
      return `<label class="ui-dlg-field" for="${id}"><span>${esc(f.label)}</span>${input}`
        + (f.hint ? `<small>${esc(f.hint)}</small>` : '') + '</label>';
    }).join('');

    dlg.innerHTML =
      `<form method="dialog">`
      + `<h2>${esc(cfg.title)}</h2>`
      + (cfg.message ? `<p>${esc(cfg.message)}</p>` : '')
      + fields
      + `<div class="ui-dlg-actions">`
      + (cfg.cancel === null ? '' : `<button type="button" class="btn" data-cancel>${esc(cfg.cancel || 'Cancel')}</button>`)
      + `<button type="submit" class="btn primary">${esc(cfg.ok || 'OK')}</button>`
      + `</div></form>`;

    document.body.appendChild(dlg);
    let result: Record<string, string> | null = null;

    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => { result = null; dlg.close(); });

    dlg.querySelector('form')!.addEventListener('submit', (ev) => {
      const out: Record<string, string> = {};
      let bad: HTMLElement | null = null;
      for (const f of cfg.fields || []) {
        const node = dlg.querySelector<HTMLInputElement>(`[name="${f.name}"]`)!;
        const v = node.value.trim();
        if (f.required && !v) { node.classList.add('invalid'); bad = bad || node; }
        else node.classList.remove('invalid');
        out[f.name] = node.value;
      }
      if (bad) { ev.preventDefault(); bad.focus(); return; }
      result = out;
    });

    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    // Clicking the backdrop lands on the dialog element itself, not its form.
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) { result = null; dlg.close(); } });

    dlg.showModal();
    const first = dlg.querySelector<HTMLInputElement>('input, textarea');
    if (first) { first.focus(); first.select?.(); }
  });
}

export async function uiAlert(message: string, opts: { title?: string; ok?: string } = {}) {
  await build({ title: opts.title || 'Notice', message, ok: opts.ok || 'OK', cancel: null });
}

export async function uiError(message: string, opts: { title?: string } = {}) {
  await build({ title: opts.title || 'Something went wrong', message, ok: 'OK', cancel: null, danger: true });
}

export async function uiConfirm(
  message: string,
  opts: { title?: string; ok?: string; cancel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const r = await build({
    title: opts.title || 'Are you sure?', message,
    ok: opts.ok || 'Confirm', cancel: opts.cancel || 'Cancel', danger: opts.danger,
  });
  return r !== null;
}

export async function uiPrompt(
  label: string,
  value = '',
  opts: { title?: string; message?: string; ok?: string; placeholder?: string;
          hint?: string; long?: boolean; required?: boolean } = {},
): Promise<string | null> {
  const r = await build({
    title: opts.title || label, message: opts.message, ok: opts.ok || 'Save',
    fields: [{
      name: 'value', label, value, placeholder: opts.placeholder,
      hint: opts.hint, required: opts.required, type: opts.long ? 'textarea' : 'text',
    }],
  });
  return r ? r.value : null;
}

export async function uiForm(
  title: string,
  fields: Field[],
  opts: { message?: string; ok?: string } = {},
): Promise<Record<string, string> | null> {
  return build({ title, message: opts.message, fields, ok: opts.ok || 'Save' });
}
