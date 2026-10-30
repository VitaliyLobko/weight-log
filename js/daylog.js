// Як минув день за раціоном: позначка (за планом / трохи не так / зрив), причина зриву, з'їдене поза планом.
// Запис дня — налаштування day:<дата>; його ж пише бот кнопками вечірнього питання, перемагає новіший.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import * as bot from './bot.js';
import { h, fmt, sheet, toast, btn, toolBtn, box, parseNum } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon, hop } from './icons.js';
import { planOf, tagLists, slipRule, plannedKcal } from './nutrition.js';
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
export const STATUS = { ok: 'За планом', off: 'Немного не так', slip: 'Срыв' };
const REASONS = { hunger: 'Голод', stress: 'Стресс', boredom: 'Скука', event: 'Событие', tired: 'Усталость' };

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

/** Продукт плану не з'їли цього дня (чи все ж з'їли) — зі скасуванням. */
export async function toggleSkipped(date, item) {
  const list = dayOf(await db.loadAll(), date)?.skipped ?? [];
  const off = list.includes(item.id);
  const before = await saveDay(date, { skipped: off ? list.filter((x) => x !== item.id) : [...list, item.id] });
  undo(off ? t('«{name}» снова в итоге дня', { name: item.name })
    : t('«{name}» не съели: −{k}', { name: item.name, k: kcal(item.kcal) }), date, before);
}

/** Увесь прийом: не з'їли нічого (усі продукти — у «не з'їв») або, якщо вже так, повернути всі. */
export async function toggleMealSkipped(date, meal) {
  const ids = meal.items.map((x) => x.id);
  const list = dayOf(await db.loadAll(), date)?.skipped ?? [];
  const all = ids.every((id) => list.includes(id));
  const next = all ? list.filter((id) => !ids.includes(id)) : [...new Set([...list, ...ids])];
  const before = await saveDay(date, { skipped: next });
  const k = meal.items.reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  undo(all ? t('«{name}» снова в итоге дня', { name: meal.name }) : t('«{name}» не съели: −{k}', { name: meal.name, k: kcal(k) }), date, before);
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
  'no-bot': 'Подсчёт работает через Telegram-бот — подключите его в «Данных». Пока — вручную.',
  offline: 'Нет сети — введите вручную.',
  limit: 'Лимит подсчётов на сегодня исчерпан — введите вручную.',
  'no-ai': 'Бот не может посчитать — введите вручную.',
};

// Звідки значення — підпис над продуктами в редакторі
const SOURCE_NOTE = {
  table: 'По справочнику — значения примерные, проверьте граммы.',
  my: 'Из «Моих продуктов».',
  off: 'Из базы Open Food Facts по штрихкоду — значения с упаковки.',
  label: 'С фото этикетки — сверьте с упаковкой.',
};
const sourceNote = (items) => {
  const srcs = new Set(items.map((x) => x.src).filter(Boolean));
  return srcs.size === 1 ? t(SOURCE_NOTE[[...srcs][0]] ?? '') || null : srcs.size ? t('Часть — по справочнику, часть — из «Моих продуктов».') : null;
};
const errorText = (err) => t(AI_ERRORS[err?.message] ?? 'Не удалось посчитать — введите вручную.');

/**
 * «З'їв поза планом»: текст → спершу «Мої продукти» й довідник без мережі, решта — модель через бота;
 * штрихкод і фото етикетки — точні значення з упаковки. Усе потім перевірити в редакторі.
 */
export function foodSheet(date = M.today()) {
  const state = current;
  const text = h('textarea', {
    rows: 3, maxlength: MAX_TEXT, autocomplete: 'off',
    placeholder: t('Например: 2 куска пиццы и кола 0,5'),
  });
  const connected = Boolean(bot.botConfig().from);
  const foods = state ? topFoods(state) : [];
  const mine = state ? foodsOf(state) : [];
  const quick = async (f) => {
    close();
    const item = withoutStats(f);
    const before = await addExtras(date, [item]);
    undo(t('Добавлено: {name} · {k}', { name: f.name, k: kcal(f.kcal) }), date, before);
  };
  const count = async () => {
    const q = text.value.trim();
    if (!q) { text.focus(); toast(t('Напишите, что съели')); return; }
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
          ? 'Не всё нашлось в справочнике — допишите калории. ИИ-подсчёт работает через Telegram-бот.'
          : 'В справочнике не нашлось — введите калории. ИИ-подсчёт работает через Telegram-бот.'),
      });
      return;
    }
    go.disabled = true;
    go.textContent = t('Считаю…');
    try {
      const r = await bot.askFood(q);
      close();
      if (!r.items?.length) editor(date, [{ name: q }], { note: r.note || t('Не похоже на еду — введите вручную.') });
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
      toast(t('Ищу штрихкод {code}…', { code }));
      try {
        const it = await lookupBarcode(code);
        if (!it) {
          editor(date, [{ name: '', barcode: code }], {
            note: t('Штрихкода {code} нет в Open Food Facts — сфотографируйте таблицу на упаковке или введите вручную.', { code }), error: true,
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
    if (!connected) { toast(t('Фото этикетки читает Telegram-бот — подключите его в «Данных».')); return; }
    const image = await pickLabelPhoto();
    if (!image) return;
    close();
    toast(t('Читаю этикетку…'), { timeout: 20000 });
    try {
      const r = await bot.askLabel(image);
      const it = labelItem(r);
      document.querySelector('.toast')?.remove();
      if (!it) { editor(date, [{ name: r.name ?? '' }], { note: r.note || t('Таблицу не удалось прочитать — введите вручную.'), error: true }); return; }
      editor(date, [{ ...it, qty: '', ...fromPer100(it.per100, it.grams), src: 'label' }], {
        note: [t(SOURCE_NOTE.label), r.note].filter(Boolean).join(' '), source: 'label',
      });
    } catch (err) {
      document.querySelector('.toast')?.remove();
      editor(date, [{ name: '' }], { note: errorText(err), error: true });
    }
  };
  const manual = () => { close(); editor(date, [{ name: text.value.trim() }], {}); };
  const go = btn(withIcon('spark', t('Посчитать')), count, 'primary');
  const body = h('div', { class: 'food-ask' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Что съели')), text,
      h('small', { class: 'muted' }, connected
        ? t('Можно несколько продуктов с граммами или штуками. Сначала — «Мои продукты» и справочник, остальное посчитает ИИ.')
        : t('Можно несколько продуктов с граммами или штуками — посчитаю по справочнику. Для остального подключите Telegram-бот в «Данных».'))),
    h('div', { class: 'food-src-btns' },
      btn(withIcon('barcode', t('Штрихкод')), scan),
      btn(withIcon('camera', t('Фото этикетки')), photo)),
    foods.length ? [h('h4', { class: 'food-sub' }, t('Мои продукты')),
      h('div', { class: 'chips food-quick' }, foods.map((f) => h('button', { type: 'button', onclick: () => quick(f) },
        h('span', {}, f.name), h('span', { class: 'muted' }, fmt.int(f.kcal)))))] : null);
  const close = sheet(dateTitle(t('Вне плана'), date), body, {
    actions: [btn(t('Вручную'), manual), go],
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
    name: field('name', t('Название'), item.name ?? ''),
    qty: field('qty', t('Порция'), item.qty ?? '', 'third'),
    grams: field('grams', t('Граммы'), num(item.grams), 'third', onGrams),
    kcal: field('kcal', t('Ккал'), num(item.kcal), 'third', onNum),
    p: field('p', t('Б'), num(item.p), '', onNum),
    f: field('f', t('Ж'), num(item.f), '', onNum),
    c: field('c', t('У'), num(item.c), '', onNum),
  };
  const check = h('p', { class: 'small food-check', hidden: true }, icon('warning'),
    h('span', {}, t('Калории не сходятся с БЖУ (4·Б + 9·Ж + 4·У) — проверьте цифры.')));
  const el = h('div', { class: 'food-card' },
    h('div', { class: 'food-card-head' }, f.name.el, onRemove ? toolBtn('delete', t('Удалить'), onRemove, 'danger') : null),
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
  const rule = slipRule(state);
  const dayTags = [...new Set([...tagLists(planOf(state)).day, ...(rec?.tags ?? [])])];
  const skipped = rec?.skipped?.length ? skippedItems(state, rec.skipped) : [];
  return h('div', { class: 'day-body' },
    h('div', { class: 'day-status', role: 'group', 'aria-label': t('Как прошёл день') },
      Object.entries(STATUS).map(([k, label]) => h('button', {
        type: 'button', class: `day-btn ${k} ${status === k ? 'on' : ''}`, 'aria-pressed': String(status === k),
        onclick: () => setStatus(state, date, k),
      }, h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), t(label)))),
    status === 'slip' ? h('div', { class: 'day-slip' },
      // Правило — з довідки плану («Правило зриву»), щоб правилось в одному місці
      rule.length ? h('ul', { class: 'food-alts day-rule' }, rule.map((line) => h('li', {},
        h('span', { class: 'diet-dot', 'aria-hidden': 'true' }), h('span', {}, line))))
        : h('p', { class: 'small' }, t('Один день не считается: ≈0,2 кг результата, не больше. Завтра — обычный завтрак, не меньше.')),
      h('div', { class: 'chips day-reasons', role: 'group', 'aria-label': t('Причина') },
        h('span', { class: 'muted small' }, t('Причина:')),
        Object.entries(REASONS).map(([k, label]) => h('button', {
          type: 'button', class: rec?.reason === k ? 'on' : '', 'aria-pressed': String(rec?.reason === k),
          onclick: () => setReason(state, date, k),
        }, t(label))))) : null,
    dayTags.length ? h('div', { class: 'chips day-tags', role: 'group', 'aria-label': t('Что было') },
      h('span', { class: 'muted small' }, t('Что было:')),
      dayTags.map((tag) => {
        const on = Boolean(rec?.tags?.includes(tag));
        return h('button', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), onclick: () => toggleTag(state, date, tag) }, tag);
      })) : null,
    skipped.length ? h('p', { class: 'small day-skipped' }, t('Не съел из плана: {list} · −{k}', {
      list: skippedNames(state, rec.skipped), k: kcal(skipped.reduce((a, x) => a + (Number(x.kcal) || 0), 0)),
    })) : null,
    extras.length ? h('div', { class: 'rows day-extras' }, extras.map((x, i) => h('button', {
      type: 'button', class: 'row food-row', onclick: () => editor(date, [x], { index: i }),
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.name), x.qty ? h('span', { class: 'muted small' }, x.qty) : null),
      h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(x.kcal)))))) : null,
    extras.length > 1 ? h('div', { class: 'food-sum' }, h('b', {}, t('Вне плана: {k}', { k: kcal(xs.kcal) })),
      h('span', { class: 'muted' }, t('Б {p} · Ж {f} · В {c}', { p: fmt.int(xs.p), f: fmt.int(xs.f), c: fmt.int(xs.c) }))) : null,
    h('div', { class: 'btn-row' }, btn(withIcon('pig', t('Съел вне плана'), 'ico-pig'), (e) => { oink(); hop(e.currentTarget.querySelector('.ico-pig')); foodSheet(date); })));
}

/** Продукти плану за id: з прийомів, продуктів дня й добавки в паузу. */
function skippedItems(state, ids) {
  const plan = planOf(state);
  const all = [...(plan?.meals ?? []).flatMap((m) => m.items ?? []), ...(plan?.day?.items ?? []), ...(plan?.pauseItems ?? [])];
  return ids.map((id) => all.find((x) => x.id === id)).filter(Boolean);
}

/** Що не з'їли — назвами; прийом, пропущений цілком, — одним словом «Обід — цілком». */
function skippedNames(state, ids) {
  const set = new Set(ids);
  const out = [];
  const used = new Set();
  for (const m of planOf(state)?.meals ?? []) {
    const items = m.items ?? [];
    if (items.length > 1 && items.every((x) => set.has(x.id))) {
      out.push(t('{name} — целиком', { name: m.name }));
      for (const x of items) used.add(x.id);
    }
  }
  for (const x of skippedItems(state, ids)) if (!used.has(x.id)) out.push(x.name);
  return out.join(', ');
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

// ---------- календар калорій ----------

/** Скільки поза планом понад план (мінус те, що з плану не з'їли), за якого день ще «трохи більше». */
const CAL_LITTLE = 300;
let calMonth = null;

/** День у календарі: що з'їли (план мінус «не з'їв» плюс поза планом) і клас кольору. */
function calDay(state, date) {
  const rec = dayOf(state, date);
  const extra = extrasSum(state, date).kcal;
  if (!rec?.status && !extra && !rec?.skipped?.length) return { cls: 'none', eaten: null };
  const eaten = (plannedKcal(state, date) ?? 0) + extra;
  const skippedKcal = rec?.skipped?.length ? skippedItems(state, rec.skipped).reduce((a, x) => a + (Number(x.kcal) || 0), 0) : 0;
  const over = extra - skippedKcal;
  const cls = rec?.status === 'slip' ? 'slip'
    : over > CAL_LITTLE ? 'much'
      : over > 0 || rec?.status === 'off' ? 'more'
        : 'ok';
  return { cls, eaten, over };
}

/** Місяць сіткою пн–нд: колір — з'їдене відносно плану, тап — цей день. */
function calendarBody(state) {
  const today = M.today();
  const ym = calMonth ?? today.slice(0, 7);
  const first = `${ym}-01`;
  const start = M.weekStart(first);
  const nextMonth = M.addDays(first, 32).slice(0, 7);
  const prevMonth = M.addDays(first, -1).slice(0, 7);
  const cells = [];
  const stats = { marked: 0, eaten: 0, extra: 0 };
  for (let d = start; d < `${nextMonth}-01` || cells.length % 7; d = M.addDays(d, 1)) {
    const inMonth = d.startsWith(ym);
    if (!inMonth || d > today) {
      cells.push(h('span', { class: `cal-cell ${inMonth ? 'future' : 'out'}`, 'aria-hidden': 'true' }, inMonth ? String(Number(d.slice(8))) : ''));
      continue;
    }
    const c = calDay(state, d);
    if (c.eaten !== null) { stats.marked += 1; stats.eaten += c.eaten; stats.extra += extrasSum(state, d).kcal; }
    const label = `${fmt.weekday(d)} ${fmt.short(d)}: ${c.eaten !== null ? kcal(c.eaten) : t('не отмечен')}`;
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
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Предыдущий месяц'), onclick: nav(prevMonth) }, '‹'),
      h('b', {}, fmt.month(ym)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Следующий месяц'), disabled: ym >= today.slice(0, 7), onclick: nav(nextMonth) }, '›')),
    h('div', { class: 'cal-grid' }, wds.map((w) => h('span', { class: 'cal-wd' }, w)), cells),
    h('div', { class: 'cal-legend' }, [['ok', 'по плану'], ['more', 'немного больше'], ['much', `+${CAL_LITTLE} и больше`], ['slip', 'срыв'], ['none', 'не отмечен']]
      .map(([k, l]) => h('span', {}, h('i', { class: `cal-key ${k}`, 'aria-hidden': 'true' }), t(l)))),
    stats.marked ? h('p', { class: 'muted small' }, t('Отмечено {n} дн. · в среднем {a} · вне плана {x}', {
      n: stats.marked, a: kcal(stats.eaten / stats.marked), x: kcal(stats.extra),
    })) : null);
  const rebuild = () => el.replaceWith(calendarBody(current ?? state));
  return el;
}

/** Календар калорій — окремий підрозділ «Раціону», тому без згортання. */
export function calendarPanel(state) {
  use(state);
  return h('section', { class: 'panel cal-panel' }, h('h3', {}, t('Календарь калорий')), calendarBody(state));
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
  return box(withIcon('chart', t('30 дней по рациону')), h('div', { class: 'day-month' },
    h('div', { class: 'day-counts' }, Object.entries(STATUS).map(([k, label]) => h('span', { class: 'day-count' },
      h('span', { class: `day-dot ${k}`, 'aria-hidden': 'true' }), h('b', {}, fmt.int(by(k))), ' ', h('span', { class: 'muted' }, t(label))))),
    reasons.length ? h('p', { class: 'small' }, t('Причины срывов: {list}', { list: reasons.map(([l, n]) => `${t(l).toLowerCase()} ×${n}`).join(', ') })) : null,
    worst && worst[1] >= 2 ? h('p', { class: 'small' }, t('Чаще всего срывы: {wd} ({n})', { wd: worst[0], n: worst[1] })) : null,
    extraKcal ? h('p', { class: 'small' }, t('Вне плана: {k} ≈ {kg} кг', { k: kcal(extraKcal), kg: fmt.fix(extraKcal / KCAL_PER_KG, 2) })) : null,
    h('p', { class: 'muted small' }, t('Отмечено {n} из 30 дней.', { n: marked.length })),
    energyLine(en)), { fold: 'day-month' });
}

/** Реальна витрата за 4 тижні: з'їдене в позначені дні + тренд ваги. */
function energyLine(en) {
  if (!en) {
    return h('p', { class: 'muted small' }, t('Реальный расход посчитается, когда за 4 недели будет хотя бы 14 отмеченных дней.'));
  }
  return h('div', { class: 'day-energy' },
    h('h4', { class: 'food-sub' }, withIcon('speed', t('Реальный расход'))),
    h('p', { class: 'small' }, h('b', {}, t('≈{k} в день', { k: kcal(Math.round(en.burn / 10) * 10) })), ' · ',
      t('едите ≈{a}, дефицит ≈{d}', { a: fmt.int(Math.round(en.intake / 10) * 10), d: fmt.int(Math.round(en.deficit / 10) * 10) })),
    h('p', { class: 'muted small' }, t('По тренду среднего веса и {n} отмеченным дням за {days} дн. Срыв без записанной еды занижает расход.', { n: en.marked, days: en.days })));
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

/** Дати з записом дня (позначка, поза планом чи «не з'їв») — щоб у «Журналі» були й дні без зважування. */
export function dayDates(state) {
  return state.settings
    .filter((s) => s.id.startsWith(DAY_PREFIX) && s.date && (s.status || s.extras?.length || s.skipped?.length))
    .map((s) => s.date);
}

/**
 * Смужка дня під вагою в «Журналі»: позначка, поза планом і «не з'їв» з назвами, мітки дня.
 * Тап — шторка дня. Плану немає чи день ще не настав — нічого.
 */
export function journalDay(state, date) {
  use(state);
  if (!planOf(state) || date > M.today()) return null;
  const rec = dayOf(state, date);
  const extras = rec?.extras ?? [];
  const xs = extrasSum(state, date).kcal;
  const missed = skippedItems(state, rec?.skipped ?? []);
  const missedKcal = missed.reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  const empty = !rec?.status && !extras.length && !missed.length;
  const names = [
    extras.length ? t('вне плана: {list}', { list: extras.map((x) => x.name).join(', ') }) : null,
    missed.length ? t('не съел: {list}', { list: skippedNames(state, rec.skipped) }) : null,
    rec?.tags?.length ? rec.tags.join(', ') : null,
  ].filter(Boolean);
  return h('button', { type: 'button', class: `log-food ${empty ? 'none' : ''}`, onclick: () => daySheet(date) },
    h('span', { class: 'log-food-head' },
      h('span', { class: `day-dot ${rec?.status ?? 'none'}`, 'aria-hidden': 'true' }),
      h('span', {}, rec?.status ? t(STATUS[rec.status]) : t('День не отмечен')),
      rec?.status === 'slip' && REASONS[rec.reason] ? h('span', { class: 'muted' }, `· ${t(REASONS[rec.reason]).toLowerCase()}`) : null,
      xs ? h('span', { class: 'log-chip plus' }, `+${fmt.int(xs)}`) : null,
      missedKcal ? h('span', { class: 'log-chip minus' }, `−${fmt.int(missedKcal)}`) : null,
      h('span', { class: 'log-food-go', 'aria-hidden': 'true' }, '›')),
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
  const parts = [prev.status ? t(STATUS[prev.status]) : null, xs ? t('вне плана {k}', { k: kcal(xs) }) : null, ...(prev.tags ?? [])].filter(Boolean);
  return parts.length ? t('Накануне: {s}', { s: parts.join(', ') }) : null;
}

/** На головній: вага зросла після зриву чи з'їденого поза планом — пояснити, що це переважно вода. */
export function weightHint(state, row) {
  use(state);
  if (!row || !(row.day >= 0.3)) return null;
  const prev = dayOf(state, M.addDays(row.date, -1));
  const xs = (prev?.extras ?? []).reduce((a, x) => a + (Number(x.kcal) || 0), 0);
  const tags = prev?.tags ?? [];
  if (!(prev?.status === 'slip' || prev?.status === 'off' || xs > 0 || tags.length)) return null;
  const why = prev?.status === 'slip' ? t('вчера был срыв') : prev?.status === 'off' ? t('вчера было немного не по плану')
    : xs > 0 ? t('вчера была еда вне плана') : t('вчера: {tags}', { tags: tags.join(', ') });
  return h('details', { class: 'plateau day-hint' },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon('trend'), h('b', {}, t('Вес {d} — {why}', { d: fmt.signed(row.day), why }))),
      h('p', { class: 'small' }, xs ? t('Вне плана {k} — это ≈{kg} кг жира, остальное — вода и соль.', { k: kcal(xs), kg: fmt.fix(xs / KCAL_PER_KG, 2) })
        : t('Почти всё это — вода и соль, не жир.'))),
    h('p', { class: 'small' }, t('Солёное и углеводы держат воду 1–3 дня. Вернитесь к плану — без голодания и урезанного завтрака — и вес уйдёт сам.')));
}
