// Раціон: план харчування на день — прийоми їжі, продукт дня, вікно їжі, паузи, довідка й мітки до нотатки.
// Сам план — запис налаштувань (у репозиторії його нема), тут лише показ і правка.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import { h, fmt, sheet, toast, form, btn, toolBtn, box, confirmSheet, remember, recall, unfold } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { dietMemo } from './diet.js';
import { dayCard, monthBox, extrasSum, dayOf, STATUS } from './daylog.js';

export const PLAN_ID = 'nutrition';
/** Вибір продукту дня — окремим записом: тап на телефоні не перетирає правку плану з іншого пристрою. */
export const PICKS_ID = 'nutrition-picks';
const PICKS_KEEP = 21;
const KEYS = ['kcal', 'p', 'f', 'c'];

export const planOf = (state) => state.settings.find((s) => s.id === PLAN_ID) ?? null;
const picksOf = (state) => state.settings.find((s) => s.id === PICKS_ID)?.days ?? {};

/** Сума ккал і БЖВ за переліком продуктів. */
export function totals(items) {
  const out = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const it of items) for (const k of KEYS) out[k] += Number(it[k]) || 0;
  return out;
}

const groupOf = (p) => p.group || p.id;

/**
 * Продукт дня: вибраний на цю дату, а як ні — пропозиція: група, якої за попередні 6 днів
 * найбільше бракує до її разів на тиждень; учорашню групу — в останню чергу.
 */
export function dayChoice(plan, picks, date) {
  const list = plan.day?.items ?? [];
  if (!list.length) return null;
  const chosen = list.find((p) => p.id === picks[date]);
  if (chosen) return { item: chosen, picked: true };
  const byId = new Map(list.map((p) => [p.id, p]));
  const count = new Map();
  for (let i = 1; i <= 6; i++) {
    const p = byId.get(picks[M.addDays(date, -i)]);
    if (p) count.set(groupOf(p), (count.get(groupOf(p)) ?? 0) + 1);
  }
  const yesterday = byId.get(picks[M.addDays(date, -1)]);
  const groups = [...new Set(list.map(groupOf))].map((g) => {
    const members = list.filter((p) => groupOf(p) === g);
    const perWeek = Math.max(...members.map((p) => Number(p.perWeek) || 0));
    return { g, members, need: perWeek - (count.get(g) ?? 0), last: yesterday && groupOf(yesterday) === g };
  });
  groups.sort((a, b) => (b.need - a.need) || (a.last - b.last));
  const best = groups[0];
  // Усередині групи — той, що брали востаннє (риба: хто взяв скумбрію, тому й далі скумбрія)
  for (let i = 1; i <= PICKS_KEEP; i++) {
    const p = byId.get(picks[M.addDays(date, -i)]);
    if (p && groupOf(p) === best.g) return { item: p, picked: false };
  }
  return { item: best.members[0], picked: false };
}

/** Пауза на підтриманні, що охоплює дату, і найближча наступна. */
export function pauseState(plan, date) {
  const list = [...(plan.pauses ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1));
  return {
    now: list.find((p) => p.from <= date && date <= p.to) ?? null,
    next: list.find((p) => p.from > date) ?? null,
  };
}

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const clock = (hhmm) => String(hhmm ?? '').replace(/^0(\d)/, '$1');

function leftText(min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return hh ? t('{h} ч {m} мин', { h: hh, m: mm }) : t('{m} мин', { m: mm });
}

/** Вікно їжі зараз: ще не відкрилось, відкрите (скільки лишилось) чи закрите. */
export function windowText(plan, now = new Date()) {
  const w = plan.window;
  const from = minutesOf(w?.from);
  const to = minutesOf(w?.to);
  if (from === null || to === null) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < from) return { state: 'before', text: t('Окно еды с {from} до {to}', { from: clock(w.from), to: clock(w.to) }) };
  if (cur < to) return { state: 'open', text: t('Окно еды до {to} · осталось {left}', { to: clock(w.to), left: leftText(to - cur) }) };
  return {
    state: 'closed',
    text: t('Окно закрыто до завтра {from}', { from: clock(w.from) }),
    sub: w.lateNote && minutesOf(w.late) > cur ? t('Если голодно — {note}, не позже {late}', { note: w.lateNote, late: clock(w.late) }) : null,
  };
}

const macros = (s) => t('Б {p} · Ж {f} · В {c}', { p: fmt.int(s.p), f: fmt.int(s.f), c: fmt.int(s.c) });
const kcal = (v) => t('{n} ккал', { n: fmt.int(v) });

/** Усе, що їсться сьогодні: прийоми, продукт дня в своєму прийомі, добавка в паузу. */
function today(state, date = M.today()) {
  const plan = planOf(state);
  if (!plan) return null;
  const choice = dayChoice(plan, picksOf(state), date);
  const pause = pauseState(plan, date);
  const meals = (plan.meals ?? []).map((m) => ({
    ...m,
    items: [...(m.items ?? []), ...(choice && plan.day?.meal === m.id ? [{ ...choice.item, isDay: true }] : [])],
  }));
  if (pause.now && plan.pauseItems?.length) meals.push({ id: 'pause', name: t('Добавка в паузу'), items: plan.pauseItems, isPause: true });
  const planned = totals(meals.flatMap((m) => m.items));
  const extra = extrasSum(state, date);
  // Підсумок дня — план плюс з'їдене поза планом
  return { plan, choice, pause, meals, planned, extra, sum: totals([planned, extra]) };
}

// ---------- запис ----------

/** Змінити план; повертає план до зміни — для «Скасувати». */
async function savePlan(change) {
  const before = planOf(await db.loadAll());
  if (!before) return null;
  const plan = structuredClone(before);
  change(plan);
  delete plan.updated;
  sync.renewOnGesture();
  await db.write({ settings: { put: [plan] } });
  return before;
}

function undoToast(message, before) {
  if (!before) return;
  toast(message, {
    action: t('Отменить'),
    onAction: () => {
      const { updated, ...plan } = before;
      db.write({ settings: { put: [plan] } });
    },
  });
}

/** Перелік, у якому лежить продукт: прийом, продукти дня чи добавка в паузу. */
function listOf(plan, where) {
  if (where.day) return (plan.day ??= { meal: plan.meals?.at(-1)?.id, items: [] }).items;
  if (where.pause) return (plan.pauseItems ??= []);
  const meal = plan.meals?.find((m) => m.id === where.meal);
  return meal ? (meal.items ??= []) : null;
}

const lists = (plan) => [...(plan.meals ?? []).map((m) => m.items ?? []), plan.day?.items ?? [], plan.pauseItems ?? []];

function locate(plan, id) {
  for (const list of lists(plan)) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) return { list, i };
  }
  return null;
}

const newId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function saveItem(item, where) {
  return savePlan((plan) => {
    const at = item.id && locate(plan, item.id);
    if (at) at.list[at.i] = { ...at.list[at.i], ...item };
    else listOf(plan, where)?.push({ ...item, id: newId() });
  });
}

/** Переставити на крок; відповідь — тостом, бо список змінюється під шторкою, де його не видно. */
async function moveItem(id, step) {
  let moved = false;
  await savePlan((plan) => {
    const at = locate(plan, id);
    const j = at ? at.i + step : -1;
    if (!at || j < 0 || j >= at.list.length) return;
    [at.list[at.i], at.list[j]] = [at.list[j], at.list[at.i]];
    moved = true;
  });
  if (moved) toast(step < 0 ? t('Перемещено выше') : t('Перемещено ниже'));
  else toast(step < 0 ? t('Уже первый') : t('Уже последний'));
}

async function removeItem(item) {
  const before = await savePlan((plan) => {
    const at = locate(plan, item.id);
    if (at) at.list.splice(at.i, 1);
  });
  undoToast(t('«{name}» удалено', { name: item.name }), before);
}

async function setPick(state, date, id) {
  const days = { ...picksOf(state), [date]: id };
  const keep = M.addDays(date, -PICKS_KEEP);
  for (const d of Object.keys(days)) if (d < keep) delete days[d];
  sync.renewOnGesture();
  await db.write({ settings: { put: [{ id: PICKS_ID, days }] } });
}

// ---------- шторки ----------

function itemSheet(item) {
  const alts = item.alts ?? [];
  const body = h('div', { class: 'food-sheet' },
    h('div', { class: 'food-figures' },
      item.qty ? h('b', {}, item.qty) : null,
      h('span', {}, kcal(item.kcal)),
      h('span', { class: 'muted' }, macros(totals([item])))),
    item.note ? h('p', { class: 'small' }, item.note) : null,
    alts.length ? [h('h4', {}, t('Чем заменить')),
      h('ul', { class: 'food-alts' }, alts.map((a) => h('li', {}, h('span', { class: 'diet-dot', 'aria-hidden': 'true' }), h('span', {}, a))))] : null);
  // Продукт дня в обіді переставляється серед продуктів дня, а не серед страв обіду
  const close = sheet(item.name, body, {
    tools: [
      toolBtn('up', t('Выше'), () => moveItem(item.id, -1)),
      toolBtn('down', t('Ниже'), () => moveItem(item.id, 1)),
      toolBtn('edit', t('Изменить'), () => { close(); itemForm(item, item.isDay ? { day: true } : {}); }),
    ],
  });
}

/** Продукт: новий (item = null, where — куди додати) чи наявний. Продукт дня має ще коротку назву й рази на тиждень. */
function itemForm(item, where = {}) {
  const isDay = Boolean(where.day || item?.isDay);
  const num = (v) => (Number.isFinite(v) ? fmt.fix(v, v % 1 ? 1 : 0) : '');
  const f = form([
    { name: 'name', label: t('Название'), value: item?.name ?? '', required: true },
    { name: 'qty', label: t('Сколько'), value: item?.qty ?? '', placeholder: t('175 г, 3 шт, 1 ч.л.') },
    { name: 'kcal', label: t('Ккал'), type: 'number', value: num(item?.kcal), required: true, min: 0, max: 5000, half: true },
    { name: 'p', label: t('Белки, г'), type: 'number', value: num(item?.p), min: 0, max: 500, half: true },
    { name: 'f', label: t('Жиры, г'), type: 'number', value: num(item?.f), min: 0, max: 500, half: true },
    { name: 'c', label: t('Углеводы, г'), type: 'number', value: num(item?.c), min: 0, max: 500, half: true },
    ...(isDay ? [
      { name: 'short', label: t('Коротко, на кнопке'), value: item?.short ?? '', half: true },
      { name: 'perWeek', label: t('Раз в неделю'), type: 'number', value: num(item?.perWeek), min: 0, max: 7, half: true },
      { name: 'group', label: t('Группа'), value: item?.group ?? '', hint: t('Одна группа — общие разы в неделю: например, три вида рыбы на 2 раза.') },
    ] : []),
    { name: 'note', label: t('Заметка'), value: item?.note ?? '' },
  ]);
  const alts = h('textarea', { rows: 6, placeholder: t('Одна замена — одна строка') });
  alts.value = (item?.alts ?? []).join('\n');
  f.el.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Чем заменить')), alts));
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await saveItem({
      ...(item ? { id: item.id } : {}),
      name: v.name, qty: v.qty, note: v.note,
      ...Object.fromEntries(KEYS.map((k) => [k, v[k] ?? 0])),
      ...(isDay ? { short: v.short, perWeek: v.perWeek ?? 0, group: v.group } : {}),
      alts: alts.value.split('\n').map((s) => s.trim()).filter(Boolean),
    }, where);
    toast(item ? t('Сохранено') : t('Добавлено'));
  };
  const remove = () => { close(); removeItem(item); };
  const close = sheet(item ? item.name : t('Новый продукт'), f.el, {
    tools: item ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
}

/** Прийом їжі: назва, час, порада під ним; видалити — разом із продуктами. */
function mealForm(meal) {
  const f = form([
    { name: 'name', label: t('Название'), value: meal?.name ?? '', required: true, half: true },
    { name: 'time', label: t('Время'), value: meal?.time ?? '', placeholder: '11:00–12:00', half: true },
    { name: 'note', label: t('Заметка'), value: meal?.note ?? '' },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await savePlan((plan) => {
      plan.meals ??= [];
      const m = meal && plan.meals.find((x) => x.id === meal.id);
      if (m) Object.assign(m, v);
      else plan.meals.push({ id: newId(), ...v, items: [] });
    });
    toast(meal ? t('Сохранено') : t('Добавлено'));
  };
  const remove = () => confirmSheet(t('Удалить «{name}»?', { name: meal.name }),
    t('Вместе с продуктами: {n}.', { n: meal.items?.filter((x) => !x.isDay).length ?? 0 }), t('Удалить'), async () => {
      close();
      const before = await savePlan((plan) => { plan.meals = plan.meals.filter((x) => x.id !== meal.id); });
      undoToast(t('«{name}» удалено', { name: meal.name }), before);
    });
  const close = sheet(meal ? meal.name : t('Новый приём еды'), f.el, {
    tools: meal ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
}

/** Пауза: дати від і до; index — позиція в plan.pauses, null — нова. */
function pauseForm(pause, index) {
  const f = form([
    { name: 'from', label: t('С'), type: 'dmy', value: pause?.from ?? '', required: true, half: true },
    { name: 'to', label: t('По'), type: 'dmy', value: pause?.to ?? '', required: true, half: true },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    if (v.to < v.from) { toast(t('Конец паузы раньше начала')); return; }
    close();
    await savePlan((plan) => {
      plan.pauses ??= [];
      if (index === null) plan.pauses.push(v); else plan.pauses[index] = v;
    });
    toast(pause ? t('Сохранено') : t('Добавлено'));
  };
  const remove = async () => {
    close();
    const before = await savePlan((plan) => { plan.pauses.splice(index, 1); });
    undoToast(t('Пауза удалена'), before);
  };
  const close = sheet(pause ? t('Пауза') : t('Новая пауза'), f.el, {
    tools: pause ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
}

function refForm(ref) {
  const input = h('textarea', { rows: 16, autocomplete: 'off' });
  input.value = ref.text ?? '';
  const save = async () => {
    close();
    const text = input.value.split('\n').map((s) => s.trimEnd()).join('\n').trim();
    await savePlan((plan) => { const r = plan.refs?.find((x) => x.id === ref.id); if (r) r.text = text; });
    toast(t('Сохранено'));
  };
  const close = sheet(ref.title, h('div', { class: 'form' },
    h('label', { class: 'field' }, input, h('small', { class: 'muted' }, t('Строка с # — заголовок, с «-» — пункт списка.')))), {
    actions: [btn(t('Сохранить'), save, 'primary')],
  });
}

/** Текст довідки: «# » — заголовок, «- » — пункт, порожній рядок — відступ, решта — абзац. */
function refText(text) {
  const out = [];
  let ul = null;
  for (const raw of String(text ?? '').split('\n')) {
    const s = raw.trim();
    if (s.startsWith('- ')) {
      if (!ul) { ul = h('ul', { class: 'food-alts' }); out.push(ul); }
      ul.append(h('li', {}, h('span', { class: 'diet-dot', 'aria-hidden': 'true' }), h('span', {}, s.slice(2))));
      continue;
    }
    ul = null;
    if (!s) out.push(h('div', { class: 'health-gap' }));
    else if (s.startsWith('#')) out.push(h('h4', {}, s.replace(/^#+\s*/, '')));
    else out.push(h('p', {}, s));
  }
  return h('div', { class: 'food-ref' }, out);
}

// ---------- екран ----------

function foodRow(item) {
  // Без калорій (кава без цукру) — тихий рядок без «0»: число там лише шумить
  const zero = !(Number(item.kcal) > 0);
  return h('button', { type: 'button', class: `row food-row ${item.isDay ? 'day' : ''} ${zero ? 'zero' : ''}`, onclick: () => itemSheet(item) },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, item.name, item.isDay ? h('span', { class: 'food-tag' }, t('продукт дня')) : null),
      item.qty ? h('span', { class: 'muted small' }, item.qty) : null),
    h('div', { class: 'row-side' }, zero ? null : h('span', { class: 'food-kcal' }, fmt.int(item.kcal)),
      item.alts?.length ? h('span', { class: 'muted small' }, t('замен: {n}', { n: item.alts.length })) : null));
}

/** Прийом їжі вперше на екрані — розгорнутий; далі пам'ятається, як його лишили. */
const MEALS_SEEN = 'weight-log:meals-seen';
function openFirstTime(key) {
  let seen;
  try { seen = new Set(JSON.parse(recall(MEALS_SEEN)) ?? []); } catch { seen = new Set(); }
  if (seen.has(key)) return;
  unfold(`box:${key}`);
  seen.add(key);
  remember(MEALS_SEEN, JSON.stringify([...seen]));
}

function mealBox(meal) {
  const s = totals(meal.items);
  const title = [meal.name, meal.time ? ` · ${meal.time}` : ''].join('');
  const tools = meal.isPause ? [] : [
    toolBtn('plus', t('Добавить продукт'), () => itemForm(null, { meal: meal.id })),
    toolBtn('edit', t('Изменить'), () => mealForm(meal)),
  ];
  const key = `meal:${meal.id}`;
  openFirstTime(key);
  // Згорнутий прийом показує ккал у заголовку
  return box(withIcon(meal.isPause ? 'calendar' : 'leaf', title), h('div', {},
    meal.items.length ? h('div', { class: 'rows' }, meal.items.map(foodRow)) : h('p', { class: 'muted small' }, t('Пусто — добавьте продукт «+»')),
    meal.items.length ? h('div', { class: 'food-sum' }, h('b', {}, kcal(s.kcal)), h('span', { class: 'muted' }, macros(s))) : null,
    meal.note ? h('p', { class: 'muted small food-note' }, meal.note) : null), { fold: key, count: meal.items.length ? Math.round(s.kcal) : null, tools });
}

function dayPicker(state, day) {
  const list = day.plan.day?.items ?? [];
  const cur = day.choice?.item.id;
  return h('div', { class: 'food-pick' },
    h('div', { class: 'chips' },
      list.length > 1 ? list.map((p) => h('button', {
        type: 'button', class: p.id === cur ? 'on' : '', 'aria-pressed': String(p.id === cur),
        onclick: () => { if (!(day.choice.picked && p.id === cur)) setPick(state, M.today(), p.id); },
      }, p.short || p.name)) : null,
      h('button', { type: 'button', class: 'chip-add', 'aria-label': t('Добавить продукт дня'), title: t('Добавить продукт дня'), onclick: () => itemForm(null, { day: true }) }, '+')),
    day.choice && !day.choice.picked && list.length > 1 ? h('p', { class: 'muted small' }, t('Предложение · нажмите, чтобы подтвердить')) : null);
}

function pauseNote(pause) {
  const p = pause.now ?? pause.next;
  if (!p) return null;
  if (pause.now) {
    return h('div', { class: 'food-pause on' }, icon('calendar'),
      h('span', {}, h('b', {}, t('Пауза на поддержании')), ' ', t('до {date} — еды больше, вес не снижается', { date: fmt.date(p.to) })));
  }
  const days = M.daysBetween(M.today(), p.from);
  if (days > 30) return null;
  return h('div', { class: 'food-pause' }, icon('calendar'),
    h('span', {}, t('Пауза на поддержании с {date} — через {n} {d}', { date: fmt.date(p.from), n: days, d: plural(days, [t('день'), t('дня'), t('дней')]) })));
}

/** Дати пауз і добавка до них — правляться тут, бо сама добавка видна лише під час паузи. */
function pausesBox(plan) {
  const date = M.today();
  const list = (plan.pauses ?? []).map((p, i) => ({ ...p, i })).sort((a, b) => (a.from < b.from ? -1 : 1));
  const extra = plan.pauseItems ?? [];
  return box(withIcon('calendar', t('Паузы: даты и добавка')), h('div', {},
    list.length ? h('div', { class: 'rows' }, list.map((p) => h('button', {
      type: 'button', class: `row ${p.to < date ? 'past' : ''}`, onclick: () => pauseForm(plan.pauses[p.i], p.i),
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, `${fmt.date(p.from)} — ${fmt.date(p.to)}`)),
      h('div', { class: 'row-side' }, h('span', { class: 'muted small' }, t('{n} дн.', { n: M.daysBetween(p.from, p.to) + 1 })))))) : null,
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Пауза')), () => pauseForm(null, null))),
    h('h4', { class: 'food-sub' }, t('Добавка в паузу'), extra.length ? h('span', { class: 'muted' }, ` · +${kcal(totals(extra).kcal)}`) : null),
    extra.length ? h('div', { class: 'rows' }, extra.map(foodRow)) : null,
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Продукт')), () => itemForm(null, { pause: true })))), { fold: 'pauses' });
}

/** Вкладка «Раціон». noPlan — порожній екран, коли плану ще нема. */
export function renderRation(state, { noPlan }) {
  const day = today(state);
  if (!day) return h('div', {}, noPlan(), box(withIcon('leaf', t('Питание при диабете')), dietMemo(), { fold: 'diet' }));
  const { plan, choice, pause, meals, planned, extra, sum } = day;
  const norm = plan.norm;
  return h('div', {},
    h('section', { class: 'hero accent food-hero' },
      h('div', { class: 'hero-label' }, choice ? t('Сегодня: {name}', { name: choice.item.short || choice.item.name }) : t('Сегодня')),
      h('div', { class: 'hero-value' }, fmt.int(sum.kcal), h('span', { class: 'hero-unit' }, t('ккал'))),
      h('div', { class: 'hero-sub' }, macros(sum)),
      extra.kcal ? h('div', { class: 'hero-sub food-split' },
        t('план {a} + вне плана {b}', { a: fmt.int(planned.kcal), b: fmt.int(extra.kcal) })) : null,
      dayPicker(state, day),
      windowEl(plan, Boolean(pause.now))),
    pauseNote(pause),
    dayCard(state),
    meals.map(mealBox),
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Приём еды')), () => mealForm(null))),
    norm ? h('p', { class: 'muted small food-norm' }, t('Норма в среднем за неделю: {k} · {m}', { k: kcal(norm.kcal), m: macros(norm) })) : null,
    pausesBox(plan),
    monthBox(state),
    h('h3', { class: 'food-section' }, icon('book'), t('Справка')),
    (plan.refs ?? []).map((r) => box(withIcon('book', r.title), refText(r.text), {
      fold: `ref:${r.id}`, tools: [toolBtn('edit', t('Изменить'), () => refForm(r))],
    })),
    box(withIcon('leaf', t('Питание при диабете')), dietMemo(), { fold: 'diet' }));
}

/**
 * Рядок вікна їжі одним рядком; порада «якщо голодно» — по тапу, щоб картка не росла.
 * Оновлюється щохвилини через tickWindow без перемальовування екрана.
 */
function windowEl(plan, inPause) {
  const el = h('button', { type: 'button', class: 'food-window', onclick: () => { if (el.dataset.more) el.classList.toggle('open'); } });
  const paint = () => {
    const win = windowText(plan);
    el.hidden = !win;
    if (!win) return;
    // У паузу є вечеря — порада про кефір зайва
    const sub = inPause ? null : win.sub;
    const open = el.classList.contains('open');
    el.className = `food-window ${win.state}${sub && open ? ' open' : ''}`;
    if (sub) el.dataset.more = '1'; else delete el.dataset.more;
    el.setAttribute('aria-expanded', String(Boolean(sub && open)));
    el.replaceChildren(icon('clock'), h('span', {}, h('span', { class: sub ? 'food-win-text' : '' }, win.text),
      sub ? h('span', { class: 'muted small food-more' }, sub) : null));
  };
  el.paint = paint;
  paint();
  return el;
}

/** Освіжити відлік вікна на видимому екрані: інтервал у app.js, щоб «лишилось 20 хв» не застигало. */
export function tickWindow() {
  document.querySelectorAll('.food-window, .food-line').forEach((el) => el.paint?.());
}

/** Рядок на головній: що сьогодні їсти й скільки лишилось вікна — тап веде у «Раціон». */
export function homeLine(state) {
  const day = today(state);
  if (!day) return null;
  const sub = h('span', { class: 'muted small' });
  const el = h('a', { href: '#ration', class: 'panel food-line' },
    icon('leaf'),
    h('span', { class: 'food-line-main' },
      h('b', {}, day.choice ? `${day.choice.item.short || day.choice.item.name} · ${kcal(day.sum.kcal)}` : kcal(day.sum.kcal)),
      sub),
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
  const status = dayOf(state, M.today())?.status;
  el.paint = () => {
    const win = windowText(day.plan);
    // Вікно закрите — час позначити день; позначений — показати як
    if (status) sub.replaceChildren(h('span', { class: `day-dot ${status}`, 'aria-hidden': 'true' }), t(STATUS[status]));
    else if (win?.state === 'closed') sub.textContent = t('Как день? Отметьте в «Рационе»');
    else sub.textContent = win?.text ?? '';
    sub.hidden = !status && !win;
  };
  el.paint();
  return el;
}

/** Мітки під нотаткою до ваги: тап додає слово в нотатку або прибирає його. */
export function noteTags(state, input) {
  const tags = planOf(state)?.tags ?? [];
  if (!tags.length) return null;
  const parts = () => input.value.split(',').map((s) => s.trim()).filter(Boolean);
  const has = (tag) => parts().some((p) => p.toLowerCase() === tag.toLowerCase());
  const wrap = h('div', { class: 'chips note-tags' });
  const paint = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', has(b.dataset.value)));
  for (const tag of tags) {
    wrap.append(h('button', {
      type: 'button', dataset: { value: tag },
      onclick: () => {
        const list = has(tag) ? parts().filter((p) => p.toLowerCase() !== tag.toLowerCase()) : [...parts(), tag];
        input.value = list.join(', ');
        paint();
      },
    }, tag));
  }
  input.addEventListener('input', paint);
  paint();
  return wrap;
}
