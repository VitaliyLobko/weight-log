// Як минув день за раціоном: позначка (за планом / трохи не так / зрив), причина зриву, з'їдене поза планом.
// Запис дня — налаштування day:<дата>; його ж пише бот кнопками вечірнього питання, перемагає новіший.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import * as bot from './bot.js';
import { h, fmt, sheet, toast, btn, toolBtn, box, parseNum } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon, hop } from './icons.js';
import { planOf, tagLists, slipRule, plannedKcal, cutOf, cutText, portionText, dayKcal, balanceText, balanceGood, dayNorm, walkOf } from './nutrition.js';
import { resolveLocal, fromModel, fromPer100, per100Of, kcalMismatch, withoutStats } from './foods.js';
import { scanSheet, lookupBarcode, pickLabelPhoto, labelItem } from './scan.js';
import { oink } from './oink.js';

export const DAY_PREFIX = 'day:';
/** «Мої продукти»: що вже рахували — кнопки швидкого додавання і кеш, щоб не питати модель вдруге. */
export const FOODS_ID = 'nutrition-foods';
const FOODS_KEEP = 40;
const FOODS_SHOWN = 8;
const KCAL_PER_KG = 7700;
const MAX_TEXT = 300;
const NUMS = ['kcal', 'p', 'f', 'c'];

// Ключі збігаються з ботом (worker.js: DAY_STATUS, DAY_REASONS)
export const STATUS = { ok: 'За планом', off: 'Трохи не так', slip: 'Зрив' };
const REASONS = { hunger: 'Голод', stress: 'Стрес', boredom: 'Нудьга', event: 'Подія', tired: 'Втома' };

// Останній стан — для живих шторок (день з полоси тижня), що перебудовуються після запису
let current = null;
const use = (state) => { current = state; return state; };

// Налаштування за id: state приходить з db.loadAll() новими масивами, тож індекс на масив не застаріває
const byId = new WeakMap();
function settingsIndex(settings) {
  let map = byId.get(settings);
  if (!map) { map = new Map(settings.map((s) => [s.id, s])); byId.set(settings, map); }
  return map;
}

export const dayOf = (state, date) => settingsIndex(state.settings).get(`${DAY_PREFIX}${date}`) ?? null;
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
    action: t('Скасувати'),
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

/** Продукт плану не з'їли цього дня (чи все ж з'їли) — зі скасуванням. */
export async function toggleSkipped(date, item) {
  const list = dayOf(await db.loadAll(), date)?.skipped ?? [];
  const off = list.includes(item.id);
  const before = await saveDay(date, { skipped: off ? list.filter((x) => x !== item.id) : [...list, item.id] });
  undo(off ? t('«{name}» знову в підсумку дня', { name: item.name })
    : t('«{name}» не з\'їли: −{k}', { name: item.name, k: kcal(item.kcal) }), date, before);
}

/** Не вся порція продукту чи прийому (key — id чи `meal:<id>`); null — знову як у плані. Зі скасуванням. */
export async function setPortion(date, key, name, portion) {
  const cur = { ...(dayOf(await db.loadAll(), date)?.portions ?? {}) };
  if (portion === null) delete cur[key];
  else cur[key] = portion;
  const before = await saveDay(date, { portions: cur });
  undo(portion === null || portion === 1 ? t('«{name}» — уся порція', { name })
    : t('«{name}» — {p} порції', { name, p: portionText(portion) }), date, before);
}

/**
 * Порція всього прийому; unskip — прийом був пропущений: повернути його й поставити частку одним записом
 * (одне «Скасувати»). Продукти, що не з'їли окремо в непропущеному прийомі, так і лишаються «не з'їв».
 */
export async function setMealPortion(date, meal, portion, { unskip = false } = {}) {
  const rec = dayOf(await db.loadAll(), date);
  const ids = new Set(meal.items.filter((x) => !x.off).map((x) => x.id));
  const portions = { ...(rec?.portions ?? {}) };
  if (portion === null || portion === 1) delete portions[`meal:${meal.id}`];
  else portions[`meal:${meal.id}`] = portion;
  const before = await saveDay(date, { portions, ...(unskip ? { skipped: (rec?.skipped ?? []).filter((id) => !ids.has(id)) } : {}) });
  undo(portion === null || portion === 1 ? t('«{name}» — уся порція', { name: meal.name })
    : t('«{name}» — {p} порції', { name: meal.name, p: portionText(portion) }), date, before);
}

/** Увесь прийом: не з'їли нічого (усі продукти — у «не з'їв») або, якщо вже так, повернути всі. */
export async function toggleMealSkipped(date, meal) {
  // Тимчасово вимкнені й так поза підсумком — «не з'їв» їм не ставимо
  const items = meal.items.filter((x) => !x.off);
  const ids = items.map((x) => x.id);
  const list = dayOf(await db.loadAll(), date)?.skipped ?? [];
  const all = ids.every((id) => list.includes(id));
  const next = all ? list.filter((id) => !ids.includes(id)) : [...new Set([...list, ...ids])];
  const before = await saveDay(date, { skipped: next });
  const k = items.reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  undo(all ? t('«{name}» знову в підсумку дня', { name: meal.name }) : t('«{name}» не з\'їли: −{k}', { name: meal.name, k: kcal(k) }), date, before);
}

// ---------- прогулянка ----------

export const WALKS = [30, 45, 60, 90];
// Від чого рахувати ккал прогулянки й чи йдуть вони до норми: ставить app.js після кожного перерахунку
let walkBase = { kg: null, adds: false };
export const setWalkBase = (kg, adds) => { walkBase = { kg, adds }; };

const setWalk = (state, date, min) => saveDay(date, { walk: walkOf(state, date) === min ? null : min });

function walkRow(state, date) {
  const cur = walkOf(state, date);
  const k = M.walkKcal(cur, walkBase.kg);
  return h('div', { class: 'chips day-walk', role: 'group', 'aria-label': t('Прогулянка') },
    h('span', { class: 'muted small' }, withIcon('walk', t('Прогулянка, хв:'))),
    WALKS.map((m) => h('button', {
      type: 'button', class: cur === m ? 'on' : '', 'aria-pressed': String(cur === m), 'aria-label': t('{n} хв', { n: m }), onclick: () => setWalk(state, date, m),
    }, String(m))),
    k ? h('span', { class: 'muted small day-walk-kcal' }, walkBase.adds
      ? t('≈{k} — додано до норми дня', { k: kcal(Math.round(k / 10) * 10) })
      : t('≈{k} — уже в реальній витраті', { k: kcal(Math.round(k / 10) * 10) })) : null);
}

// ---------- «що з'їли?» ----------

/** «Трохи не так» чи зрив, а поза планом нічого не записано — день рахується як за планом. */
const unrecordedDay = (rec) => ['off', 'slip'].includes(rec?.status) && !rec.extras?.length && !rec.noExtras;

/** Дні за останні days (без сьогодні — він ще триває), де «не так», а що з'їли — не записано. */
export function unrecorded(state, days = 14) {
  use(state);
  return Array.from({ length: days }, (_, i) => M.addDays(M.today(), -(days - i))).filter((d) => unrecordedDay(dayOf(state, d)));
}

const toggleTag = (state, date, tag) => {
  const list = dayOf(state, date)?.tags ?? [];
  return saveDay(date, { tags: list.includes(tag) ? list.filter((x) => x !== tag) : [...list, tag] });
};

// ---------- «Мої продукти» ----------

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// Той самий продукт: штрихкод, або назва — а з вагою на 100 г порція вже не важлива (інакше дві порції — дві кнопки)
const sameFood = (a, b) => (a.barcode && a.barcode === b.barcode)
  || (norm(a.name) === norm(b.name) && (a.per100 || b.per100 || norm(a.qty) === norm(b.qty)));

/** Запам'ятати пораховане: частіші й свіжіші — першими на кнопках. */
async function rememberFoods(items) {
  const list = [...foodsOf(await db.loadAll())];
  const now = Date.now();
  for (const it of items) {
    const i = list.findIndex((x) => sameFood(x, it));
    const { id, at, src, ...food } = it;
    if (i >= 0) list[i] = { ...list[i], ...food, used: (list[i].used ?? 0) + 1, last: now };
    else list.push({ ...food, used: 1, last: now });
  }
  list.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  await db.write({ settings: { put: [{ id: FOODS_ID, items: list.slice(0, FOODS_KEEP) }] } });
}

const topFoods = (state) => [...foodsOf(state)]
  .sort((a, b) => ((b.used ?? 0) - (a.used ?? 0)) || ((b.last ?? 0) - (a.last ?? 0))).slice(0, FOODS_SHOWN);

async function addExtras(date, items) {
  const stamped = items.map((x) => ({ ...x, id: newId(), at: Date.now() }));
  const before = await saveDay(date, { extras: [...(dayOf(await db.loadAll(), date)?.extras ?? []), ...stamped] });
  await rememberFoods(items);
  return before;
}

// ---------- шторки ----------

const AI_ERRORS = {
  'no-bot': 'Підрахунок працює через Telegram-бота — підключіть його в «Даних». Поки — вручну.',
  offline: 'Нема мережі — введіть вручну.',
  limit: 'Ліміт підрахунків на сьогодні вичерпано — введіть вручну.',
  'no-ai': 'Бот не може порахувати — введіть вручну.',
};

// Звідки значення — підпис над продуктами в редакторі
const SOURCE_NOTE = {
  table: 'За довідником — значення приблизні, перевірте грами.',
  my: 'З «Моїх продуктів».',
  off: 'З бази Open Food Facts за штрихкодом — значення з упаковки.',
  label: 'З фото етикетки — звірте з упаковкою.',
};
const sourceNote = (items) => {
  const srcs = new Set(items.map((x) => x.src).filter(Boolean));
  return srcs.size === 1 ? t(SOURCE_NOTE[[...srcs][0]] ?? '') || null : srcs.size ? t('Частина — за довідником, частина — з «Моїх продуктів».') : null;
};
const errorText = (err) => t(AI_ERRORS[err?.message] ?? 'Не вдалося порахувати — введіть вручну.');

/**
 * «З'їв поза планом»: текст → спершу «Мої продукти» й довідник без мережі, решта — модель через бота;
 * штрихкод і фото етикетки — точні значення з упаковки. Усе потім перевірити в редакторі.
 */
export function foodSheet(date = M.today()) {
  const state = current;
  const text = h('textarea', {
    rows: 3, maxlength: MAX_TEXT, autocomplete: 'off',
    placeholder: t('Наприклад: 2 шматки піци й кола 0,5'),
  });
  const connected = Boolean(bot.botConfig().from);
  const foods = state ? topFoods(state) : [];
  const mine = state ? foodsOf(state) : [];
  const quick = async (f) => {
    close();
    const item = withoutStats(f);
    const before = await addExtras(date, [item]);
    undo(t('Додано: {name} · {k}', { name: f.name, k: kcal(f.kcal) }), date, before);
  };
  const count = async () => {
    const q = text.value.trim();
    if (!q) { text.focus(); toast(t('Напишіть, що з\'їли')); return; }
    const local = resolveLocal(q, mine);
    if (local.items.length && !local.missing.length) {
      close();
      editor(date, local.items, { note: sourceNote(local.items), source: 'local' });
      return;
    }
    // Без бота — що впізнали, плюс порожні рядки для решти
    if (!connected) {
      close();
      editor(date, [...local.items, ...local.missing.map((name) => ({ name }))], {
        note: t(local.items.length
          ? 'Не все знайшлося в довіднику — допишіть калорії. ШІ-підрахунок працює через Telegram-бот.'
          : 'У довіднику не знайшлося — введіть калорії. ШІ-підрахунок працює через Telegram-бот.'),
      });
      return;
    }
    go.disabled = true;
    go.textContent = t('Рахую…');
    try {
      const r = await bot.askFood(q);
      close();
      if (!r.items?.length) editor(date, [{ name: q }], { note: r.note || t('Не схоже на їжу — введіть вручну.') });
      else editor(date, r.items.map(fromModel), { note: r.note, source: r.source });
    } catch (err) {
      close();
      // Модель недоступна — хоча б те, що знайшлось у довіднику
      editor(date, [...local.items, ...local.missing.map((name) => ({ name }))], { note: errorText(err), error: true });
    }
  };
  const scan = () => {
    close();
    scanSheet(async (code) => {
      const known = mine.find((x) => x.barcode === code);
      if (known) { editor(date, [withoutStats(known)], { note: t(SOURCE_NOTE.my) }); return; }
      toast(t('Шукаю штрихкод {code}…', { code }));
      try {
        const it = await lookupBarcode(code);
        if (!it) {
          editor(date, [{ name: '', barcode: code }], {
            note: t('Штрихкоду {code} немає в Open Food Facts — сфотографуйте таблицю на упаковці або введіть вручну.', { code }), error: true,
          });
          return;
        }
        editor(date, [{ ...it, qty: '', ...fromPer100(it.per100, it.grams), src: 'off' }], { note: t(SOURCE_NOTE.off), source: 'off' });
      } catch (err) {
        editor(date, [{ name: '', barcode: code }], { note: errorText(err), error: true });
      }
    });
  };
  const photo = async () => {
    if (!connected) { toast(t('Фото етикетки читає Telegram-бот — підключіть його в «Даних».')); return; }
    const image = await pickLabelPhoto();
    if (!image) return;
    close();
    toast(t('Читаю етикетку…'), { timeout: 20000 });
    try {
      const r = await bot.askLabel(image);
      const it = labelItem(r);
      document.querySelector('.toast')?.remove();
      if (!it) { editor(date, [{ name: r.name ?? '' }], { note: r.note || t('Таблицю не вдалося прочитати — введіть вручну.'), error: true }); return; }
      editor(date, [{ ...it, qty: '', ...fromPer100(it.per100, it.grams), src: 'label' }], {
        note: [t(SOURCE_NOTE.label), r.note].filter(Boolean).join(' '), source: 'label',
      });
    } catch (err) {
      document.querySelector('.toast')?.remove();
      editor(date, [{ name: '' }], { note: errorText(err), error: true });
    }
  };
  const manual = () => { close(); editor(date, [{ name: text.value.trim() }], {}); };
  const go = btn(withIcon('spark', t('Порахувати')), count, 'primary');
  const body = h('div', { class: 'food-ask' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Що з\'їли')), text,
      h('small', { class: 'muted' }, connected
        ? t('Можна кілька продуктів із грамами чи штуками. Спершу — «Мої продукти» й довідник, решту порахує ШІ.')
        : t('Можна кілька продуктів із грамами чи штуками — порахую за довідником. Для решти підключіть Telegram-бот у «Даних».'))),
    h('div', { class: 'food-src-btns' },
      btn(withIcon('barcode', t('Штрихкод')), scan),
      btn(withIcon('camera', t('Фото етикетки')), photo)),
    foods.length ? [h('h4', { class: 'food-sub' }, t('Мої продукти')),
      h('div', { class: 'chips food-quick' }, foods.map((f) => h('button', { type: 'button', onclick: () => quick(f) },
        h('span', {}, f.name), h('span', { class: 'muted' }, fmt.int(f.kcal)))))] : null);
  const close = sheet(dateTitle(t('Поза планом'), date), body, {
    actions: [btn(t('Вручну'), manual), go],
  });
  setTimeout(() => text.focus(), 250);
}

/**
 * Один продукт у редакторі: назва, порція, грами, ккал і БЖВ.
 * Є значення на 100 г — зміна грамів перераховує решту; правка ккал чи БЖВ вручну від них відв'язує.
 */
function itemCard(item, onChange, onRemove) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? fmt.fix(Number(v), Number(v) % 1 ? 1 : 0) : '');
  let per100 = item.per100 ?? null;
  let lastGrams = Number(item.grams) || null;
  const field = (name, label, value, cls = '', onInput = onChange) => {
    const input = h('input', {
      name, value, autocomplete: 'off',
      ...(name === 'name' || name === 'qty' ? { type: 'text' } : { type: 'text', inputmode: 'decimal' }),
      oninput: onInput,
    });
    return { input, el: h('label', { class: `field ${cls}` }, h('span', { class: 'field-label' }, label), input) };
  };
  const nums = () => Object.fromEntries(NUMS.map((k) => [k, parseNum(f[k].input.value)]));
  const onGrams = () => {
    const g = parseNum(f.grams.input.value);
    if (Number.isFinite(g) && g > 0) {
      const base = per100 ?? per100Of({ ...nums(), grams: lastGrams });
      if (base) {
        per100 = base;
        const v = fromPer100(base, g);
        for (const k of NUMS) f[k].input.value = num(v[k]);
      }
      lastGrams = g;
    }
    onChange();
  };
  const onNum = () => { per100 = null; onChange(); };
  const f = {
    name: field('name', t('Назва'), item.name ?? ''),
    qty: field('qty', t('Порція'), item.qty ?? '', 'third'),
    grams: field('grams', t('Грами'), num(item.grams), 'third', onGrams),
    kcal: field('kcal', t('Ккал'), num(item.kcal), 'third', onNum),
    p: field('p', t('Б'), num(item.p), '', onNum),
    f: field('f', t('Ж'), num(item.f), '', onNum),
    c: field('c', t('В'), num(item.c), '', onNum),
  };
  const check = h('p', { class: 'small food-check', hidden: true }, icon('warning'),
    h('span', {}, t('Калорії не сходяться з БЖВ (4·Б + 9·Ж + 4·В) — перевірте цифри.')));
  const el = h('div', { class: 'food-card' },
    h('div', { class: 'food-card-head' }, f.name.el, onRemove ? toolBtn('delete', t('Видалити'), onRemove, 'danger') : null),
    h('div', { class: 'food-card-row' }, f.qty.el, f.grams.el, f.kcal.el),
    h('div', { class: 'food-card-macros' }, f.p.el, f.f.el, f.c.el),
    check);
  const read = () => {
    const g = parseNum(f.grams.input.value);
    const out = {
      name: f.name.input.value.trim(), qty: f.qty.input.value.trim(),
      ...(Number.isFinite(g) && g > 0 ? { grams: g } : {}),
      ...(per100 ? { per100 } : {}),
      ...(item.barcode ? { barcode: item.barcode } : {}),
      ...(item.src ? { src: item.src } : {}),
    };
    for (const k of NUMS) {
      const v = parseNum(f[k].input.value);
      out[k] = Number.isFinite(v) && v >= 0 ? v : (k === 'kcal' ? NaN : 0);
    }
    return out;
  };
  const paintCheck = () => { check.hidden = !kcalMismatch(read()); };
  el.addEventListener('input', paintCheck);
  paintCheck();
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
    total.replaceChildren(h('b', {}, kcal(s)), h('span', { class: 'muted' }, t('{n} {w}', { n: vals.length, w: plural(vals.length, [t('продукт'), t('продукти'), t('продуктів')]) })));
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
    if (bad) { toast(bad.name ? t('Вкажіть калорії: «{name}»', { name: bad.name }) : t('Вкажіть назву')); return; }
    close();
    if (index !== null) {
      const before = await saveDay(date, {
        extras: extrasOf(await db.loadAll(), date).map((x, i) => (i === index ? { ...x, ...vals[0] } : x)),
      });
      await rememberFoods(vals);
      undo(t('Збережено'), date, before);
      return;
    }
    const before = await addExtras(date, vals);
    undo(t('Додано: {k}', { k: kcal(vals.reduce((a, v) => a + v.kcal, 0)) }), date, before);
  };
  const remove = async () => {
    close();
    const before = await saveDay(date, { extras: extrasOf(await db.loadAll(), date).filter((_, i) => i !== index) });
    undo(t('«{name}» видалено', { name: items[0].name }), date, before);
  };
  const body = h('div', { class: 'food-edit' },
    note ? h('p', { class: `small food-ai-note ${error ? 'error-text' : 'muted'}` },
      source ? [icon('spark'), ' '] : null, note) : null,
    list,
    index === null ? h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Ще продукт')), () => { add({}).focus(); paint(); })) : null,
    total);
  const close = sheet(index === null ? t('Перевірте й збережіть') : items[0].name, body, {
    tools: index !== null ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
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
  const rule = slipRule(state);
  const dayTags = [...new Set([...tagLists(planOf(state)).day, ...(rec?.tags ?? [])])];
  const cut = cutOf(state, date);
  return h('div', { class: 'day-body' },
    h('div', { class: 'day-status', role: 'group', 'aria-label': t('Як минув день') },
      Object.entries(STATUS).map(([k, label]) => h('button', {
        type: 'button', class: `day-btn ${k} ${status === k ? 'on' : ''}`, 'aria-pressed': String(status === k),
        onclick: () => setStatus(state, date, k),
      }, h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), t(label)))),
    status === 'slip' ? h('div', { class: 'day-slip' },
      // Правило — з довідки плану («Правило зриву»), щоб правилось в одному місці
      rule.length ? h('ul', { class: 'food-alts day-rule' }, rule.map((line) => h('li', {},
        h('span', { class: 'diet-dot', 'aria-hidden': 'true' }), h('span', {}, line))))
        : h('p', { class: 'small' }, t('Один день не рахується: ≈0,2 кг результату, не більше. Завтра — звичайний сніданок, не менше.')),
      h('div', { class: 'chips day-reasons', role: 'group', 'aria-label': t('Причина') },
        h('span', { class: 'muted small' }, t('Причина:')),
        Object.entries(REASONS).map(([k, label]) => h('button', {
          type: 'button', class: rec?.reason === k ? 'on' : '', 'aria-pressed': String(rec?.reason === k),
          onclick: () => setReason(state, date, k),
        }, t(label))))) : null,
    dayTags.length ? h('div', { class: 'chips day-tags', role: 'group', 'aria-label': t('Що було') },
      h('span', { class: 'muted small' }, t('Що було:')),
      dayTags.map((tag) => {
        const on = Boolean(rec?.tags?.includes(tag));
        return h('button', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), onclick: () => toggleTag(state, date, tag) }, tag);
      })) : null,
    walkRow(state, date),
    cut.kcal > 0 ? h('p', { class: 'small day-skipped' }, t('{what} · −{k}', { what: cutText(cut, { first: true }), k: kcal(cut.kcal) })) : null,
    unrecordedDay(rec) && !cut.kcal ? h('div', { class: 'day-missing' },
      h('p', { class: 'small' }, t('Що саме з\'їли? Без запису день рахується як за планом — і «Їсте» на головній виходить менше, ніж насправді.')),
      h('button', { type: 'button', class: 'link-btn small', onclick: () => saveDay(date, { noExtras: true }) }, t('Нічого зайвого не їв'))) : null,
    extras.length ? h('div', { class: 'rows day-extras' }, extras.map((x, i) => h('button', {
      type: 'button', class: 'row food-row', onclick: () => editor(date, [x], { index: i }),
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.name), x.qty ? h('span', { class: 'muted small' }, x.qty) : null),
      h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(x.kcal)))))) : null,
    extras.length > 1 ? h('div', { class: 'food-sum' }, h('b', {}, t('Поза планом: {k}', { k: kcal(xs.kcal) })),
      h('span', { class: 'muted' }, t('Б {p} · Ж {f} · В {c}', { p: fmt.int(xs.p), f: fmt.int(xs.f), c: fmt.int(xs.c) }))) : null,
    h('div', { class: 'btn-row' }, btn(withIcon('pig', t('З\'їв поза планом'), 'ico-pig'), (e) => { oink(); hop(e.currentTarget.querySelector('.ico-pig')); foodSheet(date); })));
}

export function daySheet(date) {
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
    const label = `${fmt.weekday(d)} ${fmt.short(d)}: ${rec?.status ? t(STATUS[rec.status]) : t('не позначено')}`;
    return h('button', {
      type: 'button', class: `day-cell ${d === date ? 'today' : ''}`, 'aria-label': label, title: label,
      onclick: () => daySheet(d),
    },
      h('span', { class: 'day-wd' }, fmt.weekday(d)),
      h('span', { class: `day-dot ${s}`, 'aria-hidden': 'true' }),
      rec?.extras?.length ? h('span', { class: 'day-plus', 'aria-hidden': 'true' }, '+') : null);
  }));
}

// ---------- календар калорій ----------

/** Скільки поза планом понад план (мінус те, що з плану не з'їли), за якого день ще «трохи більше». */
const CAL_LITTLE = 300;
let calMonth = null;

/** День у календарі: що з'їли (план мінус «не з'їв» і недоїдені порції плюс поза планом) і клас кольору. */
function calDay(state, date) {
  const rec = dayOf(state, date);
  const extra = extrasSum(state, date).kcal;
  const cut = cutOf(state, date).kcal;
  if (!rec?.status && !extra && !cut) return { cls: 'none', eaten: null };
  const eaten = (plannedKcal(state, date) ?? 0) + extra;
  const over = extra - cut;
  const cls = rec?.status === 'slip' ? 'slip'
    : over > CAL_LITTLE ? 'much'
      : over > 0 || rec?.status === 'off' ? 'more'
        : 'ok';
  return { cls, eaten, over };
}

/** Місяць сіткою пн–нд: колір — з'їдене відносно плану, тап — цей день. */
function calendarBody(state, norm) {
  const today = M.today();
  const ym = calMonth ?? today.slice(0, 7);
  const first = `${ym}-01`;
  const start = M.weekStart(first);
  const nextMonth = M.addDays(first, 32).slice(0, 7);
  const prevMonth = M.addDays(first, -1).slice(0, 7);
  const cells = [];
  const stats = { marked: 0, eaten: 0, extra: 0, norm: 0 };
  for (let d = start; d < `${nextMonth}-01` || cells.length % 7; d = M.addDays(d, 1)) {
    const inMonth = d.startsWith(ym);
    if (!inMonth || d > today) {
      cells.push(h('span', { class: `cal-cell ${inMonth ? 'future' : 'out'}`, 'aria-hidden': 'true' }, inMonth ? String(Number(d.slice(8))) : ''));
      continue;
    }
    const c = calDay(state, d);
    const dn = norm ? dayNorm(state, norm, d) : null;
    if (c.eaten !== null) { stats.marked += 1; stats.eaten += c.eaten; stats.extra += extrasSum(state, d).kcal; stats.norm += dn?.kcal ?? 0; }
    const label = `${fmt.weekday(d)} ${fmt.short(d)}: ${c.eaten !== null ? kcal(c.eaten) : t('не позначено')}${c.eaten !== null && dn ? ` · ${balanceText(c.eaten, dn)}` : ''}`;
    cells.push(h('button', {
      type: 'button', class: `cal-cell ${c.cls} ${d === today ? 'today' : ''}`, 'aria-label': label, title: label,
      onclick: () => daySheet(d),
    },
      h('span', { class: 'cal-num' }, String(Number(d.slice(8)))),
      c.eaten !== null ? h('span', { class: 'cal-kcal' }, String(Math.round(c.eaten))) : null));
  }
  const nav = (to) => () => { calMonth = to; rebuild(); };
  const wds = Array.from({ length: 7 }, (_, i) => fmt.weekday(M.addDays(start, i)));
  const el = h('div', { class: 'cal' },
    h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Попередній місяць'), onclick: nav(prevMonth) }, '‹'),
      h('b', {}, fmt.month(ym)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Наступний місяць'), disabled: ym >= today.slice(0, 7), onclick: nav(nextMonth) }, '›')),
    h('div', { class: 'cal-grid' }, wds.map((w) => h('span', { class: 'cal-wd' }, w)), cells),
    h('div', { class: 'cal-legend' }, [['ok', 'за планом'], ['more', 'трохи більше'], ['much', `+${CAL_LITTLE} и больше`], ['slip', 'зрив'], ['none', 'не позначено']]
      .map(([k, l]) => h('span', {}, h('i', { class: `cal-key ${k}`, 'aria-hidden': 'true' }), t(l)))),
    stats.marked ? h('p', { class: 'muted small' }, t('Позначено {n} дн. · у середньому {a} · поза планом {x}', {
      n: stats.marked, a: kcal(stats.eaten / stats.marked), x: kcal(stats.extra),
    })) : null,
    // Дефіцит місяця — від тієї ж норми, що на головній: середнє з'їдене за позначені дні проти норми
    // Норма в середньому — з прогулянками позначених днів (якщо норма за формулою)
    stats.marked && norm ? (() => {
      const avgNorm = { ...norm, kcal: stats.norm / stats.marked };
      return h('p', { class: 'cal-balance' }, t('У середньому за день: норма {n} · {r}', {
        n: fmt.int(Math.round(avgNorm.kcal / 10) * 10), r: balanceText(stats.eaten / stats.marked, avgNorm),
      }), norm.hold ? null : h('span', { class: 'muted' }, ` · ${t('{d} кг/тиж', { d: fmt.signed(((stats.eaten / stats.marked - avgNorm.kcal) * 7) / KCAL_PER_KG, 2) })}`));
    })() : null);
  const rebuild = () => el.replaceWith(calendarBody(current ?? state, norm));
  return el;
}

/** Календар калорій — окремий підрозділ «Раціону», тому без згортання. */
export function calendarPanel(state, norm = null) {
  use(state);
  return h('section', { class: 'panel cal-panel' }, h('h3', {}, t('Календар калорій')), calendarBody(state, norm));
}

/** Картка «Як день?» на «Раціоні»: сьогоднішня позначка, поза планом, тиждень і серія. */
export function dayCard(state) {
  use(state);
  const n = streak(state);
  return h('section', { class: 'panel day-card' },
    h('div', { class: 'day-head' },
      h('h3', {}, t('Як день?')),
      n >= 2 ? h('span', { class: 'day-streak' }, icon('trophy'), t('{n} {d} без зриву', { n, d: plural(n, [t('день'), t('дні'), t('днів')]) })) : null),
    dayBody(state, M.today()),
    weekStrip(state));
}

/** Підсумок за 30 днів: позначки, причини, день тижня зривів, поза планом ≈ кг, реальна витрата (en — energy()). */
export function monthBox(state, en = null) {
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
  return box(withIcon('chart', t('30 днів за раціоном')), h('div', { class: 'day-month' },
    h('div', { class: 'day-counts' }, Object.entries(STATUS).map(([k, label]) => h('span', { class: 'day-count' },
      h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), h('b', {}, fmt.int(by(k))), ' ', h('span', { class: 'muted' }, t(label))))),
    reasons.length ? h('p', { class: 'small' }, t('Причини зривів: {list}', { list: reasons.map(([l, n]) => `${t(l).toLowerCase()} ×${n}`).join(', ') })) : null,
    worst && worst[1] >= 2 ? h('p', { class: 'small' }, t('Найчастіше зриви: {wd} ({n})', { wd: worst[0], n: worst[1] })) : null,
    extraKcal ? h('p', { class: 'small' }, t('Поза планом: {k} ≈ {kg} кг', { k: kcal(extraKcal), kg: fmt.fix(extraKcal / KCAL_PER_KG, 2) })) : null,
    h('p', { class: 'muted small' }, t('Позначено {n} з 30 днів.', { n: marked.length })),
    energyLine(en)), { fold: 'day-month' });
}

/** Реальна витрата за 4 тижні: з'їдене в позначені дні + тренд ваги. */
function energyLine(en) {
  if (!en) {
    return h('p', { class: 'muted small' }, t('Реальна витрата порахується, коли за 4 тижні буде хоча б 14 позначених днів.'));
  }
  return h('div', { class: 'day-energy' },
    h('h4', { class: 'food-sub' }, withIcon('speed', t('Реальна витрата'))),
    h('p', { class: 'small' }, h('b', {}, t('≈{k} на день', { k: kcal(Math.round(en.burn / 10) * 10) })), ' · ',
      t('їсте ≈{a}, дефіцит ≈{d}', { a: fmt.int(Math.round(en.intake / 10) * 10), d: fmt.int(Math.round(en.deficit / 10) * 10) })),
    h('p', { class: 'muted small' }, t('За трендом середньої ваги й {n} позначеними днями за {days} дн. Зрив без записаної їжі занижує витрату.', { n: en.marked, days: en.days })));
}

/** Тиждень за раціоном: { ok, off, slip, marked } за дні [from, to]. */
export function weekMarks(state, from, to) {
  const out = { ok: 0, off: 0, slip: 0, marked: 0 };
  for (let d = from; d <= to; d = M.addDays(d, 1)) {
    const s = dayOf(state, d)?.status;
    if (s) { out[s] += 1; out.marked += 1; }
  }
  return out;
}

/** Що було з раціоном за [from, to] — для плашки «Плато»: зриви, поза планом, скільки позначено. */
export function periodFood(state, from, to) {
  const m = weekMarks(state, from, to);
  let extra = 0;
  for (let d = from; d <= to; d = M.addDays(d, 1)) extra += extrasSum(state, d).kcal;
  return { ...m, extra, days: M.daysBetween(from, to) + 1 };
}

/** Серії без зриву 7, 14, 30… днів — рубежі для святкування (id із датою початку серії). */
const STREAKS = [7, 14, 30, 60, 100];
export function streakMilestones(state) {
  const days = state.settings.filter((s) => s.id.startsWith(DAY_PREFIX) && s.date && s.status).map((s) => s.date).sort();
  const out = [];
  let start = null;
  let prev = null;
  for (const d of days) {
    const good = ['ok', 'off'].includes(dayOf(state, d).status);
    if (!good) { start = null; prev = d; continue; }
    if (!start || prev !== M.addDays(d, -1)) start = d;
    const n = M.daysBetween(start, d) + 1;
    if (STREAKS.includes(n)) out.push({ id: `streak:${n}:${start}`, kind: 'streak', n, date: d, kg: 0 });
    prev = d;
  }
  return out;
}

/** Перший день, позначений у «Як день?», — звідси рахується темп «з раціону». */
export function rationStart(state) {
  let first = null;
  for (const s of state.settings) {
    if (s.id.startsWith(DAY_PREFIX) && s.status && s.date && (!first || s.date < first)) first = s.date;
  }
  return first;
}

/** Дати з записом дня (позначка, поза планом чи «не з'їв») — щоб у «Журналі» були й дні без зважування. */
export function dayDates(state) {
  return state.settings
    .filter((s) => s.id.startsWith(DAY_PREFIX) && s.date && (s.status || s.extras?.length || s.skipped?.length || s.walk))
    .map((s) => s.date);
}

/**
 * Смужка дня під вагою в «Журналі»: позначка, поза планом і «не з'їв» з назвами, мітки дня.
 * Тап — шторка дня. Плану немає чи день ще не настав — нічого.
 */
export function journalDay(state, date, norm = null) {
  use(state);
  if (!planOf(state) || date > M.today()) return null;
  const rec = dayOf(state, date);
  const extras = rec?.extras ?? [];
  const xs = extrasSum(state, date).kcal;
  const cut = cutOf(state, date);
  const missedKcal = cut.kcal;
  const empty = !rec?.status && !extras.length && !missedKcal;
  const eaten = empty ? null : dayKcal(state, date);
  const dn = norm ? dayNorm(state, norm, date) : null;
  const walk = walkOf(state, date);
  const names = [
    extras.length ? t('поза планом: {list}', { list: extras.map((x) => x.name).join(', ') }) : null,
    missedKcal ? cutText(cut) : null,
    rec?.tags?.length ? rec.tags.join(', ') : null,
  ].filter(Boolean);
  return h('button', { type: 'button', class: `log-food ${empty ? 'none' : ''}`, onclick: () => daySheet(date) },
    h('span', { class: 'log-food-head' },
      h('span', { class: `day-dot ${rec?.status ?? 'none'}`, 'aria-hidden': 'true' }),
      h('span', {}, rec?.status ? t(STATUS[rec.status]) : t('День не позначено')),
      rec?.status === 'slip' && REASONS[rec.reason] ? h('span', { class: 'muted' }, `· ${t(REASONS[rec.reason]).toLowerCase()}`) : null,
      xs ? h('span', { class: 'log-chip plus' }, `+${fmt.int(xs)}`) : null,
      missedKcal ? h('span', { class: 'log-chip minus' }, `−${fmt.int(missedKcal)}`) : null,
      walk ? h('span', { class: 'log-chip walk', title: t('Прогулянка {n} хв', { n: walk }) }, icon('walk'), fmt.int(walk)) : null,
      unrecordedDay(rec) && !missedKcal ? h('span', { class: 'log-chip plus', title: t('Не записано, що з\'їли') }, '?') : null,
      h('span', { class: 'log-food-go', 'aria-hidden': 'true' }, '›')),
    eaten !== null ? h('span', { class: 'log-food-kcal' },
      h('span', {}, t("з'їдено {k}", { k: kcal(eaten) })),
      dn ? h('span', { class: `log-balance ${balanceGood(eaten, dn) ? 'good' : 'bad'}` }, balanceText(eaten, dn)) : null) : null,
    names.length ? h('span', { class: 'log-food-names' }, names.join(' · ')) : null);
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
  const parts = [prev.status ? t(STATUS[prev.status]) : null, xs ? t('поза планом {k}', { k: kcal(xs) }) : null, ...(prev.tags ?? [])].filter(Boolean);
  return parts.length ? t('Напередодні: {s}', { s: parts.join(', ') }) : null;
}

/** На головній: вага зросла після зриву чи з'їденого поза планом — пояснити, що це переважно вода. */
export function weightHint(state, row) {
  use(state);
  if (!row || !(row.day >= 0.3)) return null;
  const prev = dayOf(state, M.addDays(row.date, -1));
  const xs = (prev?.extras ?? []).reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  const tags = prev?.tags ?? [];
  if (!(prev?.status === 'slip' || prev?.status === 'off' || xs > 0 || tags.length)) return null;
  const why = prev?.status === 'slip' ? t('учора був зрив') : prev?.status === 'off' ? t('учора було трохи не за планом')
    : xs > 0 ? t('учора була їжа поза планом') : t('учора: {tags}', { tags: tags.join(', ') });
  return h('details', { class: 'plateau day-hint' },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon('trend'), h('b', {}, t('Вага {d} — {why}', { d: fmt.signed(row.day), why }))),
      h('p', { class: 'small' }, xs ? t('Поза планом {k} — це ≈{kg} кг жиру, решта — вода й сіль.', { k: kcal(xs), kg: fmt.fix(xs / KCAL_PER_KG, 2) })
        : t('Майже все це — вода й сіль, не жир.'))),
    h('p', { class: 'small' }, t('Солоне й вуглеводи тримають воду 1–3 дні. Поверніться до плану — без голодування й урізаного сніданку — і вага піде сама.')));
}
