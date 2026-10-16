// Дрібні UI-примітиви без фреймворку: елементи, шторка, тост, форма, групи, що згортаються.
import { t, locale } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function remember(key, value) {
  try { localStorage.setItem(key, value ?? ''); } catch { /* приватний режим */ }
}

export function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

const formatters = new Map();

/** Форматер під поточну мову: створюється раз на мову й опції. */
function nf(options) {
  const key = `${locale()}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat(locale(), options));
  return formatters.get(key);
}

const fixed = (d) => ({ minimumFractionDigits: d, maximumFractionDigits: d });

export const fmt = {
  /** Число з рівно d знаками: 114,0 · 114,51. */
  fix: (n, d = 1) => nf(fixed(d)).format(Number(n) || 0),
  /** Зі знаком: +0,4 · −0,70; нуль — без знака. */
  signed: (n, d = 1) => {
    const v = Number(n) || 0;
    const text = nf(fixed(d)).format(Math.abs(v));
    if (Number(text.replace(',', '.').replace(/\s/g, '')) === 0) return text;
    return `${v > 0 ? '+' : '−'}${text}`;
  },
  int: (n) => nf({ maximumFractionDigits: 0 }).format(Number(n) || 0),
  date: (iso) => isoToDmy(iso),
  /** «16.10» — коротко, для осей і рядків поточного року. */
  short: (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : ''),
  weekday: (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { weekday: 'short' }),
  month: (ym) => {
    const text = new Date(`${ym}-15T12:00:00`).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    return text.charAt(0).toUpperCase() + text.slice(1);
  },
  time: (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
};

export function vibrate(ms = 12) {
  navigator.vibrate?.(ms);
}

// Відкриті «живі» шторки: картка під іншою шторкою має побачити, що там змінили чи видалили.
const liveSheets = new Set();

/** Перебудовує відкриті живі шторки за свіжим станом; live() поверне null — запису вже нема, шторка закривається. */
export function refreshSheets() {
  for (const s of [...liveSheets]) s();
}

/** Нижня шторка. Повертає close(). live — функція, що будує тіло заново після refreshSheets(). */
export function sheet(title, body, { actions = [], onClose, live, tools = [] } = {}) {
  const layer = document.getElementById('layer');
  const close = () => {
    liveSheets.delete(rebuild);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 180);
    window.removeEventListener('popstate', close);
    onClose?.();
  };
  const rebuild = () => {
    const next = live();
    if (!next) { close(); return; }
    const box = panel.querySelector('.sheet-body');
    const top = box.scrollTop;
    box.replaceChildren(next);
    box.scrollTop = top;
  };
  if (live) liveSheets.add(rebuild);
  const panel = h('section', { class: 'sheet', role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-grip' }),
    h('header', { class: 'sheet-head' },
      h('h2', {}, title),
      h('div', { class: 'sheet-tools' }, tools,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Закрыть'), onclick: close }, '✕'))),
    h('div', { class: 'sheet-body' }, body),
    actions.length ? h('footer', { class: 'sheet-actions' }, actions) : null);
  // Закривати лише якщо й натиск почався на фоні: інакше на сенсорному екрані «фантомний» клік
  // після тапу по рядку падає на щойно відкритий фон і одразу закриває шторку.
  let downOnBackdrop = false;
  const backdrop = h('div', {
    class: 'backdrop',
    onpointerdown: (e) => { downOnBackdrop = e.target === backdrop; },
    onclick: (e) => { if (e.target === backdrop && downOnBackdrop) close(); downOnBackdrop = false; },
  }, panel);
  layer.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  window.addEventListener('popstate', close, { once: true });
  return close;
}

let toastTimer;

export function toast(message, { action, onAction, timeout = action ? 8000 : 3500 } = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, message),
    action ? h('button', { type: 'button', onclick: () => { el.remove(); onAction(); } }, action) : null);
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), timeout);
}

export function btn(label, onclick, kind = '') {
  return h('button', { type: 'button', class: `btn ${kind}`, onclick }, label);
}

const TOOL_ICON = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  delete: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

/** Кнопка-іконка в шапці шторки. */
export function toolBtn(icon, label, onclick, cls = '') {
  const b = h('button', { type: 'button', class: `icon-btn tool ${cls}`, 'aria-label': label, title: label, onclick });
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOL_ICON[icon]}</svg>`;
  return b;
}

/**
 * Проста форма. fields: [{ name, label, type, value, options, required, step, min, max, hint, half, placeholder }]
 * half — поле на пів рядка: два такі поля поспіль стають в одну строку.
 * type: text | number | dmy | time | select | chips
 */
export function form(fields) {
  const inputs = {};
  const el = h('div', { class: 'form' });
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name },
        f.options.map(([value, label]) => h('option', { value, selected: String(value) === String(f.value ?? '') }, label)));
    } else if (f.type === 'chips') {
      input = chips(f.options, f.value, f.onPick);
    } else if (f.type === 'dmy') {
      input = dmyInput(f.value);
    } else {
      input = h('input', {
        name: f.name, type: f.type === 'number' ? 'text' : (f.type ?? 'text'),
        inputmode: f.type === 'number' ? 'decimal' : undefined,
        placeholder: f.placeholder, autocomplete: 'off', class: f.big ? 'big-input' : undefined,
      });
      input.value = f.value ?? '';
    }
    inputs[f.name] = input;
    el.append(h('label', { class: `field ${f.half ? 'half' : ''}` },
      f.label ? h('span', { class: 'field-label' }, f.label) : null, input,
      f.hint ? h('small', { class: 'muted' }, f.hint) : null));
  }
  const values = () => {
    const out = {};
    for (const f of fields) {
      let v = inputs[f.name].value;
      if (f.type === 'number') v = parseNum(v);
      if (f.type === 'dmy') v = dmyToIso(v) ?? (v.trim() ? NaN : '');
      out[f.name] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  };
  const invalid = () => fields.find((f) => {
    const v = values()[f.name];
    if (f.required && (v === '' || v === null)) return true;
    if (Number.isNaN(v)) return true;
    return f.type === 'number' && v !== null && ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max));
  });
  return { el, inputs, values, invalid };
}

/** «118,2» або «118.2» → 118.2; порожньо → null; не число → NaN. */
export function parseNum(text) {
  const s = String(text ?? '').trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  if (!s) return null;
  return /^[-+]?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}

/** «2026-11-03» → «03.11.2026». */
export function isoToDmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** «03.11.2026» або «3.11.26» → «2026-11-03»; null — не дата (31.02 теж). */
export function dmyToIso(text) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Дата цифрами замість календаря: на роки вперед чи назад календар гортає місяць за місяцем.
 * Крапки ставляться самі: 03112026 → 03.11.2026; рік можна двома цифрами.
 */
function dmyInput(iso) {
  const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: t('ДД.ММ.ГГГГ'), maxlength: 10, autocomplete: 'off', class: 'dmy' });
  input.value = isoToDmy(iso);
  input.addEventListener('input', () => {
    // Частина перед роздільником завершена: «3.» — це день 03, а не початок «31»
    const parts = input.value.split(/\D+/);
    let d = '';
    parts.forEach((p, i) => { d += i < parts.length - 1 && p.length === 1 && d.length < 4 ? `0${p}` : p; });
    d = d.slice(0, 8);
    input.value = d.slice(0, 2) + (d.length > 2 ? `.${d.slice(2, 4)}` : '') + (d.length > 4 ? `.${d.slice(4)}` : '');
  });
  // Вийшли з поля — рік повністю: 14.10.23 → 14.10.2023
  input.addEventListener('blur', () => { const v = dmyToIso(input.value); if (v) input.value = isoToDmy(v); });
  return input;
}

/** Ряд кнопок-чипів; клік вставляє значення. Повертає контейнер з полем .value. */
export function chips(options, value, onPick) {
  const wrap = h('div', { class: 'chips' });
  wrap.value = value ?? '';
  const sync = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(wrap.value)));
  for (const opt of options) {
    const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
    wrap.append(h('button', {
      type: 'button', dataset: { value: val },
      onclick: () => { wrap.value = String(val); sync(); onPick?.(val); },
    }, label));
  }
  sync();
  return wrap;
}

export function segmented(options, value, onPick) {
  const row = chips(options, value, onPick);
  row.classList.add('segmented');
  return row;
}

export function confirmSheet(title, text, okLabel, onOk) {
  const close = sheet(title, h('p', {}, text), {
    actions: [
      btn(t('Отмена'), () => close()),
      btn(okLabel, () => { close(); onOk(); }, 'danger'),
    ],
  });
}

function storedSet(key) {
  try { return new Set(JSON.parse(recall(key)) ?? []); } catch { return new Set(); }
}

// Усі групи за замовчуванням згорнуті; тут — розгорнуті, між запусками.
const UNFOLDED = 'weight-log:unfolded';
const unfolded = storedSet(UNFOLDED);

function setUnfolded(key, open) {
  if (open) unfolded.add(key); else unfolded.delete(key);
  remember(UNFOLDED, JSON.stringify([...unfolded]));
}

/** Група, що згортається: за замовчуванням згорнута, розгорнуту запам'ятовує. */
export function fold(key, head, body) {
  const el = h('details', { class: 'fold', open: unfolded.has(key), dataset: { key } },
    h('summary', { class: 'fold-head' }, h('span', { class: 'chevron', 'aria-hidden': 'true' }), head),
    h('div', { class: 'fold-body' }, body));
  el.addEventListener('toggle', () => setUnfolded(key, el.open));
  return el;
}

/** Блок із заголовком на лінії рамки (як в 1С); fold — ключ згортання, count — кількість у заголовку. */
export function box(title, content, { fold: foldKey, count, tools } = {}) {
  const legendTools = tools ? h('span', { class: 'box-tools' }, tools) : null;
  if (!foldKey) return h('fieldset', { class: 'box' }, h('legend', {}, title, legendTools), content);
  const key = `box:${foldKey}`;
  const el = h('fieldset', { class: `box foldable ${unfolded.has(key) ? '' : 'closed'}` });
  const toggle = h('button', {
    type: 'button', class: 'box-toggle', 'aria-expanded': String(unfolded.has(key)),
    onclick: () => {
      const open = el.classList.toggle('closed') === false;
      setUnfolded(key, open);
      toggle.setAttribute('aria-expanded', String(open));
    },
  }, h('span', { class: 'box-chevron', 'aria-hidden': 'true' }, '›'), title, count ? h('span', { class: 'box-count' }, fmt.int(count)) : null);
  el.append(h('legend', {}, toggle, legendTools), h('div', { class: 'box-body' }, content));
  return el;
}

/** Зберегти файл: «Поділитися» на телефоні (share = true), інакше — завантаження. */
export async function saveFile(file, share = false) {
  if (share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
