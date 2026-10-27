// Як минув день за раціоном: позначка (за планом / трохи не так / зрив), причина зриву, з'їдене поза планом.
// Запис дня — налаштування day:<дата>; його ж пише бот кнопками вечірнього питання, перемагає новіший.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import * as bot from './bot.js';
import { h, fmt, sheet, toast, btn, toolBtn, box, parseNum } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon } from './icons.js';

export const DAY_PREFIX = 'day:';
/** «Мої продукти»: що вже рахували — кнопки швидкого додавання і кеш, щоб не питати модель вдруге. */
export const FOODS_ID = 'nutrition-foods';
const FOODS_KEEP = 40;
const FOODS_SHOWN = 8;
const KCAL_PER_KG = 7700;
const MAX_TEXT = 300;
const NUMS = ['kcal', 'p', 'f', 'c'];

// Ключі збігаються з ботом (worker.js: DAY_STATUS, DAY_REASONS)
export const STATUS = { ok: 'За планом', off: 'Немного не так', slip: 'Срыв' };
const REASONS = { hunger: 'Голод', stress: 'Стресс', boredom: 'Скука', event: 'Событие', tired: 'Усталость' };

// Останній стан — для живих шторок (день з полоси тижня), що перебудовуються після запису
let current = null;
const use = (state) => { current = state; return state; };

export const dayOf = (state, date) => state.settings.find((s) => s.id === `${DAY_PREFIX}${date}`) ?? null;
const extrasOf = (state, date) => dayOf(state, date)?.extras ?? [];
const foodsOf = (state) => state.settings.find((s) => s.id === FOODS_ID)?.items ?? [];

/** Сума поза планом за день: { kcal, p, f, c }. */
export function extrasSum(state, date) {
  const out = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const it of extrasOf(state, date)) for (const k of NUMS) out[k] += Number(it[k]) || 0;
  return out;
}

const kcal = (v) => t('{n} ккал', { n: fmt.int(v) });
const newId = () => `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Злити зміну в запис дня (як бот: що не змінюємо — лишається); повертає запис до зміни. */
async function saveDay(date, patch) {
  const before = dayOf(await db.loadAll(), date);
  const next = { ...before, ...patch, id: `${DAY_PREFIX}${date}`, date };
  delete next.updated;
  sync.renewOnGesture();
  await db.write({ settings: { put: [next] } });
  return before;
}

function undo(message, date, before) {
  toast(message, {
    action: t('Отменить'),
    onAction: () => {
      const { updated, ...rec } = before ?? { id: `${DAY_PREFIX}${date}`, date, status: null, reason: null, extras: [] };
      db.write({ settings: { put: [rec] } });
    },
  });
}

async function setStatus(state, date, status) {
  const cur = dayOf(state, date)?.status ?? null;
  // Повторний тап знімає позначку
  const next = cur === status ? null : status;
  await saveDay(date, { status: next, ...(next === 'slip' ? {} : { reason: null }) });
}

const setReason = (state, date, reason) => saveDay(date, { reason: dayOf(state, date)?.reason === reason ? null : reason });

// ---------- «Мої продукти» ----------

const foodKey = (x) => `${String(x.name ?? '').trim().toLowerCase()}|${String(x.qty ?? '').trim().toLowerCase()}`;
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Запам'ятати пораховане: частіші й свіжіші — першими на кнопках. */
async function rememberFoods(items) {
  const list = [...foodsOf(await db.loadAll())];
  const now = Date.now();
  for (const it of items) {
    const i = list.findIndex((x) => foodKey(x) === foodKey(it));
    const { id, at, ...food } = it;
    if (i >= 0) list[i] = { ...list[i], ...food, used: (list[i].used ?? 0) + 1, last: now };
    else list.push({ ...food, used: 1, last: now });
  }
  list.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  await db.write({ settings: { put: [{ id: FOODS_ID, items: list.slice(0, FOODS_KEEP) }] } });
}

const topFoods = (state) => [...foodsOf(state)]
  .sort((a, b) => ((b.used ?? 0) - (a.used ?? 0)) || ((b.last ?? 0) - (a.last ?? 0))).slice(0, FOODS_SHOWN);

/** Той самий текст уже рахували — назва чи «назва порція» з «Моїх продуктів». */
function cached(state, text) {
  const q = norm(text);
  return foodsOf(state).find((x) => norm(x.name) === q || norm(`${x.name} ${x.qty}`) === q) ?? null;
}

async function addExtras(date, items) {
  const stamped = items.map((x) => ({ ...x, id: newId(), at: Date.now() }));
  const before = await saveDay(date, { extras: [...(dayOf(await db.loadAll(), date)?.extras ?? []), ...stamped] });
  await rememberFoods(items);
  return before;
}

// ---------- шторки ----------

const AI_ERRORS = {
  'no-bot': 'Подсчёт работает через Telegram-бот — подключите его в «Данных». Пока — вручную.',
  offline: 'Нет сети — введите вручную.',
  limit: 'Лимит подсчётов на сегодня исчерпан — введите вручную.',
  'no-ai': 'Бот не может посчитать — введите вручную.',
};

/** «З'їв поза планом»: текст → модель рахує → перевірити; «Мої продукти» — одним тапом. */
export function foodSheet(date = M.today()) {
  const state = current;
  const text = h('textarea', {
    rows: 3, maxlength: MAX_TEXT, autocomplete: 'off',
    placeholder: t('Например: 2 куска пиццы и кола 0,5'),
  });
  const connected = Boolean(bot.botConfig().from);
  const foods = state ? topFoods(state) : [];
  const quick = async (f) => {
    close();
    const { used, last, ...item } = f;
    const before = await addExtras(date, [item]);
    undo(t('Добавлено: {name} · {k}', { name: f.name, k: kcal(f.kcal) }), date, before);
  };
  const count = async () => {
    const q = text.value.trim();
    if (!q) { text.focus(); toast(t('Напишите, что съели')); return; }
    const hit = state && cached(state, q);
    if (hit) {
      close();
      const { used, last, ...item } = hit;
      editor(date, [item], { note: t('Из «Моих продуктов»') });
      return;
    }
    go.disabled = true;
    go.textContent = t('Считаю…');
    try {
      const r = await bot.askFood(q);
      close();
      if (!r.items?.length) editor(date, [{ name: q }], { note: r.note || t('Не похоже на еду — введите вручную.') });
      else editor(date, r.items, { note: r.note, source: r.source });
    } catch (err) {
      close();
      const msg = AI_ERRORS[err.message] ?? t('Не удалось посчитать — введите вручную.');
      editor(date, [{ name: q }], { note: t(msg), error: true });
    }
  };
  const manual = () => { close(); editor(date, [{ name: text.value.trim() }], {}); };
  const go = btn(withIcon('spark', connected ? t('Посчитать') : t('Дальше')), () => (connected ? count() : manual()), 'primary');
  const body = h('div', { class: 'food-ask' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Что съели')), text,
      h('small', { class: 'muted' }, connected
        ? t('Можно несколько продуктов сразу. ИИ посчитает калории и БЖУ — потом проверите.')
        : t('ИИ-подсчёт работает через Telegram-бот — его можно подключить в «Данных». Пока — вручную.'))),
    foods.length ? [h('h4', { class: 'food-sub' }, t('Мои продукты')),
      h('div', { class: 'chips food-quick' }, foods.map((f) => h('button', { type: 'button', onclick: () => quick(f) },
        h('span', {}, f.name), h('span', { class: 'muted' }, fmt.int(f.kcal)))))] : null);
  const close = sheet(dateTitle(t('Вне плана'), date), body, {
    actions: [btn(t('Вручную'), manual), go],
  });
  setTimeout(() => text.focus(), 250);
}

/** Один продукт у редакторі: назва, порція, ккал і БЖВ. */
function itemCard(item, onChange, onRemove) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? fmt.fix(Number(v), Number(v) % 1 ? 1 : 0) : '');
  const field = (name, label, value, cls = '') => {
    const input = h('input', {
      name, value, autocomplete: 'off',
      ...(name === 'name' || name === 'qty' ? { type: 'text' } : { type: 'text', inputmode: 'decimal' }),
      oninput: onChange,
    });
    return { input, el: h('label', { class: `field ${cls}` }, h('span', { class: 'field-label' }, label), input) };
  };
  const f = {
    name: field('name', t('Название'), item.name ?? ''),
    qty: field('qty', t('Порция'), item.qty ?? '', 'half'),
    kcal: field('kcal', t('Ккал'), num(item.kcal), 'half'),
    p: field('p', t('Б'), num(item.p)),
    f: field('f', t('Ж'), num(item.f)),
    c: field('c', t('У'), num(item.c)),
  };
  const el = h('div', { class: 'food-card' },
    h('div', { class: 'food-card-head' }, f.name.el, onRemove ? toolBtn('delete', t('Удалить'), onRemove, 'danger') : null),
    h('div', { class: 'food-card-row' }, f.qty.el, f.kcal.el),
    h('div', { class: 'food-card-macros' }, f.p.el, f.f.el, f.c.el));
  const read = () => {
    const out = { name: f.name.input.value.trim(), qty: f.qty.input.value.trim(), ...(item.grams ? { grams: item.grams } : {}) };
    for (const k of NUMS) {
      const v = parseNum(f[k].input.value);
      out[k] = Number.isFinite(v) && v >= 0 ? v : (k === 'kcal' ? NaN : 0);
    }
    return out;
  };
  return { el, read, focus: () => f.name.input.focus() };
}

/**
 * Перевірити й записати: items — від моделі, з кешу чи порожній рядок.
 * index — правка вже записаного продукту (тоді один продукт і «Видалити»).
 */
function editor(date, items, { note, source, error, index = null } = {}) {
  const cards = [];
  const list = h('div', { class: 'food-cards' });
  const total = h('div', { class: 'food-sum' });
  const paint = () => {
    const vals = cards.map((c) => c.read());
    const s = vals.reduce((a, v) => a + (Number.isFinite(v.kcal) ? v.kcal : 0), 0);
    total.replaceChildren(h('b', {}, kcal(s)), h('span', { class: 'muted' }, t('{n} {w}', { n: vals.length, w: plural(vals.length, [t('продукт'), t('продукта'), t('продуктов')]) })));
  };
  const add = (item) => {
    const card = itemCard(item, paint, index === null ? () => {
      cards.splice(cards.indexOf(card), 1);
      card.el.remove();
      paint();
    } : null);
    cards.push(card);
    list.append(card.el);
    return card;
  };
  items.forEach(add);
  paint();
  const save = async () => {
    const vals = cards.map((c) => c.read()).filter((v) => v.name || Number.isFinite(v.kcal));
    if (!vals.length) { close(); return; }
    const bad = vals.find((v) => !v.name || !Number.isFinite(v.kcal));
    if (bad) { toast(bad.name ? t('Укажите калории: «{name}»', { name: bad.name }) : t('Укажите название')); return; }
    close();
    if (index !== null) {
      const before = await saveDay(date, {
        extras: extrasOf(await db.loadAll(), date).map((x, i) => (i === index ? { ...x, ...vals[0] } : x)),
      });
      await rememberFoods(vals);
      undo(t('Сохранено'), date, before);
      return;
    }
    const before = await addExtras(date, vals);
    undo(t('Добавлено: {k}', { k: kcal(vals.reduce((a, v) => a + v.kcal, 0)) }), date, before);
  };
  const remove = async () => {
    close();
    const before = await saveDay(date, { extras: extrasOf(await db.loadAll(), date).filter((_, i) => i !== index) });
    undo(t('«{name}» удалено', { name: items[0].name }), date, before);
  };
  const body = h('div', { class: 'food-edit' },
    note ? h('p', { class: `small food-ai-note ${error ? 'error-text' : 'muted'}` },
      source ? [icon('spark'), ' '] : null, note) : null,
    list,
    index === null ? h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Ещё продукт')), () => { add({}).focus(); paint(); })) : null,
    total);
  const close = sheet(index === null ? t('Проверьте и сохраните') : items[0].name, body, {
    tools: index !== null ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
  if (!items[0]?.name) setTimeout(() => cards[0]?.focus(), 250);
}

const dateTitle = (title, date) => (date === M.today() ? title : `${title} · ${fmt.weekday(date)} ${fmt.short(date)}`);

// ---------- блоки екрана ----------

/** Позначка дня, причина зриву і з'їдене поза планом — для сьогодні на екрані й для будь-якого дня в шторці. */
function dayBody(state, date) {
  const rec = dayOf(state, date);
  const status = rec?.status ?? null;
  const extras = rec?.extras ?? [];
  const xs = extrasSum(state, date);
  return h('div', { class: 'day-body' },
    h('div', { class: 'day-status', role: 'group', 'aria-label': t('Как прошёл день') },
      Object.entries(STATUS).map(([k, label]) => h('button', {
        type: 'button', class: `day-btn ${k} ${status === k ? 'on' : ''}`, 'aria-pressed': String(status === k),
        onclick: () => setStatus(state, date, k),
      }, h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), t(label)))),
    status === 'slip' ? h('div', { class: 'day-slip' },
      h('p', { class: 'small' }, t('Один день не считается: ≈0,2 кг результата, не больше. Завтра — обычный завтрак, не меньше.')),
      h('div', { class: 'chips day-reasons', role: 'group', 'aria-label': t('Причина') },
        h('span', { class: 'muted small' }, t('Причина:')),
        Object.entries(REASONS).map(([k, label]) => h('button', {
          type: 'button', class: rec?.reason === k ? 'on' : '', 'aria-pressed': String(rec?.reason === k),
          onclick: () => setReason(state, date, k),
        }, t(label))))) : null,
    extras.length ? h('div', { class: 'rows day-extras' }, extras.map((x, i) => h('button', {
      type: 'button', class: 'row food-row', onclick: () => editor(date, [x], { index: i }),
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.name), x.qty ? h('span', { class: 'muted small' }, x.qty) : null),
      h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(x.kcal)))))) : null,
    extras.length > 1 ? h('div', { class: 'food-sum' }, h('b', {}, t('Вне плана: {k}', { k: kcal(xs.kcal) })),
      h('span', { class: 'muted' }, t('Б {p} · Ж {f} · В {c}', { p: fmt.int(xs.p), f: fmt.int(xs.f), c: fmt.int(xs.c) }))) : null,
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Съел вне плана')), () => foodSheet(date))));
}

function daySheet(date) {
  sheet(`${fmt.weekday(date)} ${fmt.date(date)}`, dayBody(current, date), { live: () => dayBody(current, date) });
}

/** Днів без зриву поспіль: від сьогодні (не позначено — від учора) назад. */
export function streak(state, date = M.today()) {
  let d = dayOf(state, date)?.status ? date : M.addDays(date, -1);
  let n = 0;
  for (;;) {
    const s = dayOf(state, d)?.status;
    if (s !== 'ok' && s !== 'off') return n;
    n += 1;
    d = M.addDays(d, -1);
  }
}

function weekStrip(state) {
  const date = M.today();
  const days = Array.from({ length: 7 }, (_, i) => M.addDays(date, i - 6));
  return h('div', { class: 'day-week' }, days.map((d) => {
    const rec = dayOf(state, d);
    const s = rec?.status ?? 'none';
    const label = `${fmt.weekday(d)} ${fmt.short(d)}: ${rec?.status ? t(STATUS[rec.status]) : t('не отмечен')}`;
    return h('button', {
      type: 'button', class: `day-cell ${d === date ? 'today' : ''}`, 'aria-label': label, title: label,
      onclick: () => daySheet(d),
    },
      h('span', { class: 'day-wd' }, fmt.weekday(d)),
      h('span', { class: `day-dot ${s}`, 'aria-hidden': 'true' }),
      rec?.extras?.length ? h('span', { class: 'day-plus', 'aria-hidden': 'true' }, '+') : null);
  }));
}

/** Картка «Як день?» на «Раціоні»: сьогоднішня позначка, поза планом, тиждень і серія. */
export function dayCard(state) {
  use(state);
  const n = streak(state);
  return h('section', { class: 'panel day-card' },
    h('div', { class: 'day-head' },
      h('h3', {}, t('Как день?')),
      n >= 2 ? h('span', { class: 'day-streak' }, icon('trophy'), t('{n} {d} без срыва', { n, d: plural(n, [t('день'), t('дня'), t('дней')]) })) : null),
    dayBody(state, M.today()),
    weekStrip(state));
}

/** Підсумок за 30 днів: позначки, причини, день тижня зривів, поза планом ≈ кг. */
export function monthBox(state) {
  use(state);
  const date = M.today();
  const recs = Array.from({ length: 30 }, (_, i) => dayOf(state, M.addDays(date, -i))).filter(Boolean);
  const marked = recs.filter((r) => r.status);
  const extraKcal = recs.reduce((a, r) => a + (r.extras ?? []).reduce((b, x) => b + (Number(x.kcal) || 0), 0), 0);
  if (!marked.length && !extraKcal) return null;
  const by = (k) => marked.filter((r) => r.status === k).length;
  const reasons = Object.entries(REASONS).map(([k, label]) => [label, recs.filter((r) => r.status === 'slip' && r.reason === k).length])
    .filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const slips = recs.filter((r) => r.status === 'slip');
  const wd = new Map();
  for (const r of slips) wd.set(fmt.weekday(r.date), (wd.get(fmt.weekday(r.date)) ?? 0) + 1);
  const [worst] = [...wd].sort((a, b) => b[1] - a[1]);
  return box(withIcon('chart', t('30 дней по рациону')), h('div', { class: 'day-month' },
    h('div', { class: 'day-counts' }, Object.entries(STATUS).map(([k, label]) => h('span', { class: 'day-count' },
      h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), h('b', {}, fmt.int(by(k))), ' ', h('span', { class: 'muted' }, t(label))))),
    reasons.length ? h('p', { class: 'small' }, t('Причины срывов: {list}', { list: reasons.map(([l, n]) => `${t(l).toLowerCase()} ×${n}`).join(', ') })) : null,
    worst && worst[1] >= 2 ? h('p', { class: 'small' }, t('Чаще всего срывы: {wd} ({n})', { wd: worst[0], n: worst[1] })) : null,
    extraKcal ? h('p', { class: 'small' }, t('Вне плана: {k} ≈ {kg} кг', { k: kcal(extraKcal), kg: fmt.fix(extraKcal / KCAL_PER_KG, 2) })) : null,
    h('p', { class: 'muted small' }, t('Отмечено {n} из 30 дней.', { n: marked.length }))), { fold: 'day-month' });
}

/** Дати зважувань наступного ранку після зриву — окремі точки на графіку. */
export function afterSlip(state) {
  use(state);
  const out = new Set();
  for (const s of state.settings) {
    if (s.id.startsWith(DAY_PREFIX) && s.status === 'slip' && s.date) out.add(M.addDays(s.date, 1));
  }
  return out;
}

/** Рядок про вчорашній день у підказці графіка. */
export function yesterdayText(state, date) {
  const prev = dayOf(state, M.addDays(date, -1));
  if (!prev) return null;
  const xs = (prev.extras ?? []).reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  const parts = [prev.status ? t(STATUS[prev.status]) : null, xs ? t('вне плана {k}', { k: kcal(xs) }) : null].filter(Boolean);
  return parts.length ? t('Накануне: {s}', { s: parts.join(', ') }) : null;
}

/** На головній: вага зросла після зриву чи з'їденого поза планом — пояснити, що це переважно вода. */
export function weightHint(state, row) {
  use(state);
  if (!row || !(row.day >= 0.3)) return null;
  const prev = dayOf(state, M.addDays(row.date, -1));
  const xs = (prev?.extras ?? []).reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  if (!(prev?.status === 'slip' || prev?.status === 'off' || xs > 0)) return null;
  const why = prev?.status === 'slip' ? t('вчера был срыв') : prev?.status === 'off' ? t('вчера было немного не по плану') : t('вчера была еда вне плана');
  return h('details', { class: 'plateau day-hint' },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon('trend'), h('b', {}, t('Вес {d} — {why}', { d: fmt.signed(row.day), why }))),
      h('p', { class: 'small' }, xs ? t('Вне плана {k} — это ≈{kg} кг жира, остальное — вода и соль.', { k: kcal(xs), kg: fmt.fix(xs / KCAL_PER_KG, 2) })
        : t('Почти всё это — вода и соль, не жир.'))),
    h('p', { class: 'small' }, t('Солёное и углеводы держат воду 1–3 дня. Вернитесь к плану — без голодания и урезанного завтрака — и вес уйдёт сам.')));
}
