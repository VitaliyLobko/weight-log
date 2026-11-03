// Раціон: план харчування на день — прийоми їжі, продукт дня, вікно їжі, паузи, довідка й мітки до нотатки.
// Сам план — запис налаштувань (у репозиторії його нема), тут лише показ і правка.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import { h, fmt, sheet, toast, form, btn, toolBtn, box, confirmSheet, remember, recall, unfold, swipeLeft, segmented, isoToDmy } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { dietMemo } from './diet.js';
import { dayCard, monthBox, extrasSum, dayOf, STATUS, toggleSkipped, toggleMealSkipped, calendarPanel } from './daylog.js';

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

/** Період, коли продукт тимчасово не додається: offs — [{ from, to }], to порожнє — до повернення. */
export const offAt = (item, date) => (item.offs ?? []).find((p) => p.from <= date && (!p.to || date <= p.to)) ?? null;

/**
 * Продукт дня: вибраний на цю дату, а як ні — пропозиція: група, якої за попередні 6 днів
 * найбільше бракує до її разів на тиждень; учорашню групу — в останню чергу. Тимчасово вимкнені — поза вибором.
 */
export function dayChoice(plan, picks, date) {
  const list = (plan.day?.items ?? []).filter((p) => !offAt(p, date));
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
  return hh ? t('{h} год {m} хв', { h: hh, m: mm }) : t('{m} хв', { m: mm });
}

/** Вікно їжі зараз: ще не відкрилось, відкрите (скільки лишилось) чи закрите. */
export function windowText(plan, now = new Date()) {
  const w = plan.window;
  const from = minutesOf(w?.from);
  const to = minutesOf(w?.to);
  if (from === null || to === null) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < from) return { state: 'before', text: t('Вікно їжі з {from} до {to}', { from: clock(w.from), to: clock(w.to) }) };
  if (cur < to) return { state: 'open', text: t('Вікно їжі до {to} · лишилось {left}', { to: clock(w.to), left: leftText(to - cur) }) };
  return {
    state: 'closed',
    text: t('Вікно закрите до завтра {from}', { from: clock(w.from) }),
    sub: w.lateNote && minutesOf(w.late) > cur ? t('Якщо голодно — {note}, не пізніше {late}', { note: w.lateNote, late: clock(w.late) }) : null,
  };
}

const macros = (s) => t('Б {p} · Ж {f} · В {c}', { p: fmt.int(s.p), f: fmt.int(s.f), c: fmt.int(s.c) });
const kcal = (v) => t('{n} ккал', { n: fmt.int(v) });

// settings після кожного запису — новий масив (як у settingsIndex), тож підсумок дня кешуємо на масив і дату:
// енергія за 28 днів, середнє за тиждень, головна й «Раціон» інакше перераховують ті самі дні по кілька разів
const dayCache = new WeakMap();

/** Усе, що їсться сьогодні: прийоми, продукт дня в своєму прийомі, добавка в паузу. */
function today(state, date = M.today()) {
  let byDate = dayCache.get(state.settings);
  if (!byDate) { byDate = new Map(); dayCache.set(state.settings, byDate); }
  if (!byDate.has(date)) byDate.set(date, buildDay(state, date));
  return byDate.get(date);
}

function buildDay(state, date) {
  const plan = planOf(state);
  if (!plan) return null;
  const choice = dayChoice(plan, picksOf(state), date);
  const pause = pauseState(plan, date);
  // Продукти плану, які цього дня не з'їли або тимчасово не додаються, — у підсумок не йдуть; вимкнені — в кінці прийому
  const skipped = new Set(dayOf(state, date)?.skipped ?? []);
  const mark = (x) => {
    const off = offAt(x, date);
    return off ? { ...x, off } : skipped.has(x.id) ? { ...x, skipped: true } : x;
  };
  const order = (list) => [...list.filter((x) => !x.off), ...list.filter((x) => x.off)];
  const meals = (plan.meals ?? []).map((m) => ({
    ...m,
    items: order([...(m.items ?? []), ...(choice && plan.day?.meal === m.id ? [{ ...choice.item, isDay: true }] : [])].map(mark)),
  }));
  if (pause.now && plan.pauseItems?.length) meals.push({ id: 'pause', name: t('Добавка в паузу'), items: order(plan.pauseItems.map(mark)), isPause: true });
  const planned = totals(meals.flatMap((m) => m.items).filter((x) => !x.skipped && !x.off));
  const extra = extrasSum(state, date);
  // Підсумок дня — план плюс з'їдене поза планом
  return { plan, choice, pause, meals, planned, extra, sum: totals([planned, extra]) };
}

/** Калорії плану на дату: прийоми, продукт дня, добавка в паузу (без поза планом). */
export const plannedKcal = (state, date) => today(state, date)?.planned.kcal ?? null;

const KCAL_PER_KG = 7700;
const ENERGY_DAYS = 28;
const ENERGY_MIN = 14;

/**
 * Реальна витрата за останні 4 тижні: що з'їдено в позначені дні (план + поза планом) плюс
 * те, що показує тренд середньої ваги (кг × 7700). Позначених днів замало — null.
 */
export function energy(state, rows) {
  const withAvg = rows.filter((r) => r.avg !== null);
  const cur = withAvg.at(-1);
  if (!cur || !planOf(state)) return null;
  const from = M.addDays(cur.date, -ENERGY_DAYS);
  const then = withAvg.find((r) => r.date >= from);
  const days = then ? M.daysBetween(then.date, cur.date) : 0;
  if (days < ENERGY_MIN) return null;
  const eaten = [];
  for (let d = then.date; d <= cur.date; d = M.addDays(d, 1)) {
    if (!dayOf(state, d)?.status) continue;
    eaten.push((plannedKcal(state, d) ?? 0) + extrasSum(state, d).kcal);
  }
  if (eaten.length < ENERGY_MIN) return null;
  const intake = eaten.reduce((a, v) => a + v, 0) / eaten.length;
  const burn = intake + ((then.avg - cur.avg) * KCAL_PER_KG) / days;
  return { burn, intake, deficit: burn - intake, marked: eaten.length, days };
}

/** Калорії дня: план (без «не з'їв» і вимкнених) плюс поза планом. */
export const dayKcal = (state, date) => today(state, date)?.sum.kcal ?? null;

/** Скільки їсте в день за останні 7 днів: план дня (продукт дня, пауза, «не з'їв») плюс поза планом. */
export function intakeWeek(state, date = M.today()) {
  if (!planOf(state)) return null;
  const days = Array.from({ length: 7 }, (_, i) => dayKcal(state, M.addDays(date, -i)));
  return days.reduce((a, v) => a + v, 0) / days.length;
}

/**
 * Норма й баланс калорій: { burn, intake, balance, source, en, f }. Норма — з ваших даних (energy),
 * а поки позначених днів замало — за формулою; що їсте — з тих самих даних або з плану за тиждень.
 */
export function calories(state, rows, goal, kg) {
  const en = energy(state, rows);
  const f = M.formulaBurn(goal, kg, M.today());
  if (!en && !f) return null;
  const burn = en?.burn ?? f.burn;
  const intake = en?.intake ?? intakeWeek(state);
  return { burn, intake, balance: intake !== null ? intake - burn : null, source: en ? 'real' : 'formula', en, f, todayKcal: dayKcal(state, M.today()) };
}

// Мітки: до нотатки ваги — про тіло (TRX, недосип), до дня — про їжу й події (брынза, застілля).
// Паузу й зрив застосунок знає сам — такі мітки не показуємо.
const SELF_KNOWN = new Set(['пауза', 'срыв', 'зрив']);
const DAY_TAGS_DEFAULT = new Set(['брынза', 'бринза', 'застолье', 'застілля']);
const known = (tag) => SELF_KNOWN.has(tag.toLowerCase());

/** { note, day } — мітки до ваги й до дня; поки plan.dayTags нема, харчові відділяються зі старого переліку. */
export function tagLists(plan) {
  const all = (plan?.tags ?? []).filter((x) => !known(x));
  if (Array.isArray(plan?.dayTags)) return { note: all, day: plan.dayTags.filter((x) => !known(x)) };
  return { note: all.filter((x) => !DAY_TAGS_DEFAULT.has(x.toLowerCase())), day: all.filter((x) => DAY_TAGS_DEFAULT.has(x.toLowerCase())) };
}

function tagsForm(plan) {
  const lists = tagLists(plan);
  const area = (list) => {
    const el = h('textarea', { rows: 4, autocomplete: 'off', placeholder: t('Одна мітка — один рядок') });
    el.value = list.join('\n');
    return el;
  };
  const note = area(lists.note);
  const day = area(lists.day);
  const read = (el) => [...new Set(el.value.split('\n').map((x) => x.trim()).filter(Boolean))];
  const save = async () => {
    close();
    await savePlan((p) => { p.tags = read(note); p.dayTags = read(day); });
    toast(t('Збережено'));
  };
  const close = sheet(t('Мітки'), h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('До ваги — про тіло')), note,
      h('small', { class: 'muted' }, t('Під нотаткою до зважування: тренування, сон, хвороба.'))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('До дня — їжа й події')), day,
      h('small', { class: 'muted' }, t('У картці «Як день?»: солоне, застілля. Звідси ж підказка, чому зросла вага.')))), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

/** Текст «Правила зриву» з довідки плану (id slip): рядки без «- », без заголовків. */
export const slipRule = (state) => (planOf(state)?.refs?.find((r) => r.id === 'slip')?.text ?? '')
  .split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')).map((x) => x.replace(/^-\s*/, ''));

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
    action: t('Скасувати'),
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
  if (moved) toast(step < 0 ? t('Переміщено вище') : t('Переміщено нижче'));
  else toast(step < 0 ? t('Уже перший') : t('Уже останній'));
}

async function removeItem(item) {
  const before = await savePlan((plan) => {
    const at = locate(plan, item.id);
    if (at) at.list.splice(at.i, 1);
  });
  undoToast(t('«{name}» видалено', { name: item.name }), before);
}

/** Змінити періоди «не додаю» продукту в плані: change(offs) → нові offs. */
function changeOffs(item, change) {
  return savePlan((plan) => {
    const at = locate(plan, item.id);
    if (at) at.list[at.i] = { ...at.list[at.i], offs: change(at.list[at.i].offs ?? []) };
  });
}

/** Тимчасово не додавати з сьогодні: until — останній день без продукту, порожньо — поки не повернете. */
async function setOff(item, until) {
  const date = M.today();
  const before = await changeOffs(item, (offs) => [...offs.filter((p) => !offAt({ offs: [p] }, date)), { from: date, to: until || '' }]);
  undoToast(until ? t('«{name}» не додаємо до {date} включно', { name: item.name, date: fmt.date(until) })
    : t('«{name}» не додаємо, поки не повернете', { name: item.name }), before);
}

/** Повернути з сьогодні: поточний період закінчується вчора, а почався сьогодні — зникає зовсім. */
async function setOn(item) {
  const date = M.today();
  const before = await changeOffs(item, (offs) => offs.flatMap((p) => {
    if (!offAt({ offs: [p] }, date)) return [p];
    return p.from === date ? [] : [{ ...p, to: M.addDays(date, -1) }];
  }));
  undoToast(t('«{name}» знову в раціоні', { name: item.name }), before);
}

/** «Тимчасово не додаю»: забули купити, перестали додавати — до дати чи поки не повернете. */
function offForm(item) {
  const f = form([{ name: 'until', label: t('Не додавати до (включно)'), type: 'dmy', value: '', hint: t('Порожньо — поки не повернете самі.') }]);
  const preset = (days) => { f.inputs.until.value = days === null ? '' : isoToDmy(M.addDays(M.today(), days)); };
  const save = async () => {
    const bad = f.invalid();
    const { until } = f.values();
    if (bad || (until && until < M.today())) { toast(t('Перевірте дату')); return; }
    close();
    await setOff(item, until);
  };
  const close = sheet(t('Тимчасово не додаю'), h('div', {},
    h('p', { class: 'muted small' }, t('«{name}» лишиться в плані, але не піде в підсумок дня і не пропонуватиметься продуктом дня.', { name: item.name })),
    h('div', { class: 'chips' },
      [[0, t('Лише сьогодні')], [2, t('3 дні')], [6, t('Тиждень')], [null, t('Поки не поверну')]]
        .map(([d, label]) => h('button', { type: 'button', onclick: () => preset(d) }, label))),
    f.el), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Не додавати'), save, 'primary')],
  });
}

/** Підпис періоду: «до 10.11» чи «поки не повернете». */
const offText = (off) => (off.to ? t('не додаю до {date}', { date: fmt.short(off.to) }) : t('не додаю'));

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
    alts.length ? [h('h4', {}, t('Чим замінити')),
      h('ul', { class: 'food-alts' }, alts.map((a) => h('li', {}, h('span', { class: 'diet-dot', 'aria-hidden': 'true' }), h('span', {}, a))))] : null);
  // Сьогодні не з'їв — у підсумок дня не йде; план не змінюється. Тимчасово не додаю — на кілька днів чи довше
  if (item.off) {
    body.append(h('p', { class: 'small food-off-note' }, item.off.to
      ? t('Не додаєте з {from} до {to} включно.', { from: fmt.date(item.off.from), to: fmt.date(item.off.to) })
      : t('Не додаєте з {from}, поки не повернете.', { from: fmt.date(item.off.from) })),
    h('div', { class: 'btn-row' }, btn(withIcon('check', t('Повернути в раціон')), () => { close(); setOn(item); }, 'primary')));
  } else {
    body.append(h('div', { class: 'btn-row' },
      btn(item.skipped ? withIcon('check', t('Усе ж з\'їв')) : t('Сьогодні не з\'їв'), () => { close(); toggleSkipped(M.today(), item); }),
      btn(t('Тимчасово не додаю'), () => { close(); offForm(item); })));
  }
  // Продукт дня в обіді переставляється серед продуктів дня, а не серед страв обіду
  const close = sheet(item.name, body, {
    tools: [
      toolBtn('up', t('Вище'), () => moveItem(item.id, -1)),
      toolBtn('down', t('Нижче'), () => moveItem(item.id, 1)),
      toolBtn('edit', t('Змінити'), () => { close(); itemForm(item, item.isDay ? { day: true } : {}); }),
    ],
  });
}

/** Продукт: новий (item = null, where — куди додати) чи наявний. Продукт дня має ще коротку назву й рази на тиждень. */
function itemForm(item, where = {}) {
  const isDay = Boolean(where.day || item?.isDay);
  const num = (v) => (Number.isFinite(v) ? fmt.fix(v, v % 1 ? 1 : 0) : '');
  const f = form([
    { name: 'name', label: t('Назва'), value: item?.name ?? '', required: true },
    { name: 'qty', label: t('Скільки'), value: item?.qty ?? '', placeholder: t('175 г, 3 шт, 1 ч.л.') },
    { name: 'kcal', label: t('Ккал'), type: 'number', value: num(item?.kcal), required: true, min: 0, max: 5000, half: true },
    { name: 'p', label: t('Білки, г'), type: 'number', value: num(item?.p), min: 0, max: 500, half: true },
    { name: 'f', label: t('Жири, г'), type: 'number', value: num(item?.f), min: 0, max: 500, half: true },
    { name: 'c', label: t('Вуглеводи, г'), type: 'number', value: num(item?.c), min: 0, max: 500, half: true },
    ...(isDay ? [
      { name: 'short', label: t('Коротко, на кнопці'), value: item?.short ?? '', half: true },
      { name: 'perWeek', label: t('Разів на тиждень'), type: 'number', value: num(item?.perWeek), min: 0, max: 7, half: true },
      { name: 'group', label: t('Група'), value: item?.group ?? '', hint: t('Одна група — спільні рази на тиждень: наприклад, три види риби на 2 рази.') },
    ] : []),
    { name: 'note', label: t('Нотатка'), value: item?.note ?? '' },
  ]);
  const alts = h('textarea', { rows: 6, placeholder: t('Одна заміна — один рядок') });
  alts.value = (item?.alts ?? []).join('\n');
  f.el.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Чим замінити')), alts));
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await saveItem({
      ...(item ? { id: item.id } : {}),
      name: v.name, qty: v.qty, note: v.note,
      ...Object.fromEntries(KEYS.map((k) => [k, v[k] ?? 0])),
      ...(isDay ? { short: v.short, perWeek: v.perWeek ?? 0, group: v.group } : {}),
      alts: alts.value.split('\n').map((s) => s.trim()).filter(Boolean),
    }, where);
    toast(item ? t('Збережено') : t('Додано'));
  };
  const remove = () => { close(); removeItem(item); };
  const close = sheet(item ? item.name : t('Новий продукт'), f.el, {
    tools: item ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

/** Прийом їжі: назва, час, порада під ним; видалити — разом із продуктами. */
function mealForm(meal) {
  const f = form([
    { name: 'name', label: t('Назва'), value: meal?.name ?? '', required: true, half: true },
    { name: 'time', label: t('Час'), value: meal?.time ?? '', placeholder: '11:00–12:00', half: true },
    { name: 'note', label: t('Нотатка'), value: meal?.note ?? '' },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await savePlan((plan) => {
      plan.meals ??= [];
      const m = meal && plan.meals.find((x) => x.id === meal.id);
      if (m) Object.assign(m, v);
      else plan.meals.push({ id: newId(), ...v, items: [] });
    });
    toast(meal ? t('Збережено') : t('Додано'));
  };
  const remove = () => confirmSheet(t('Видалити «{name}»?', { name: meal.name }),
    t('Разом із продуктами: {n}.', { n: meal.items?.filter((x) => !x.isDay).length ?? 0 }), t('Видалити'), async () => {
      close();
      const before = await savePlan((plan) => { plan.meals = plan.meals.filter((x) => x.id !== meal.id); });
      undoToast(t('«{name}» видалено', { name: meal.name }), before);
    });
  const close = sheet(meal ? meal.name : t('Новий прийом їжі'), f.el, {
    tools: meal ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

/** Пауза: дати від і до; index — позиція в plan.pauses, null — нова. */
function pauseForm(pause, index) {
  const f = form([
    { name: 'from', label: t('З'), type: 'dmy', value: pause?.from ?? '', required: true, half: true },
    { name: 'to', label: t('По'), type: 'dmy', value: pause?.to ?? '', required: true, half: true },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    if (v.to < v.from) { toast(t('Кінець паузи раніше за початок')); return; }
    close();
    await savePlan((plan) => {
      plan.pauses ??= [];
      if (index === null) plan.pauses.push(v); else plan.pauses[index] = v;
    });
    toast(pause ? t('Збережено') : t('Додано'));
  };
  const remove = async () => {
    close();
    const before = await savePlan((plan) => { plan.pauses.splice(index, 1); });
    undoToast(t('Паузу видалено'), before);
  };
  const close = sheet(pause ? t('Пауза') : t('Нова пауза'), f.el, {
    tools: pause ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

function refForm(ref) {
  const input = h('textarea', { rows: 16, autocomplete: 'off' });
  input.value = ref.text ?? '';
  const save = async () => {
    close();
    const text = input.value.split('\n').map((s) => s.trimEnd()).join('\n').trim();
    await savePlan((plan) => { const r = plan.refs?.find((x) => x.id === ref.id); if (r) r.text = text; });
    toast(t('Збережено'));
  };
  const close = sheet(ref.title, h('div', { class: 'form' },
    h('label', { class: 'field' }, input, h('small', { class: 'muted' }, t('Рядок з # — заголовок, з «-» — пункт списку.')))), {
    actions: [btn(t('Зберегти'), save, 'primary')],
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
  return h('button', { type: 'button', class: `row food-row ${item.isDay ? 'day' : ''} ${zero ? 'zero' : ''} ${item.skipped ? 'skipped' : ''} ${item.off ? 'off' : ''}`, onclick: () => itemSheet(item) },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, item.name, item.isDay ? h('span', { class: 'food-tag' }, t('продукт дня')) : null,
        item.skipped && !item.inMissed ? h('span', { class: 'food-tag skip' }, t('не з\'їв')) : null,
        item.off ? h('span', { class: 'food-tag skip' }, offText(item.off)) : null),
      item.qty ? h('span', { class: 'muted small' }, item.qty) : null),
    h('div', { class: 'row-side' }, zero ? null : h('span', { class: 'food-kcal' }, fmt.int(item.kcal)),
      item.alts?.length ? h('span', { class: 'muted small' }, t('замін: {n}', { n: item.alts.length })) : null));
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

/** Перший свайп ще не робили — підказка під першим прийомом. */
const SWIPE_SEEN = 'weight-log:swipe-seen';
const swiped = () => { if (!recall(SWIPE_SEEN)) remember(SWIPE_SEEN, '1'); };

/** Продукт прийому: свайп уліво — «не з'їв» сьогодні (ще раз — повернути), тап — картка. */
function swipeRow(item) {
  // Тимчасово вимкнений — без свайпу: «не з'їв» йому ні до чого
  if (item.off) return foodRow(item);
  return swipeLeft(foodRow(item), {
    label: item.skipped ? t('Повернути') : t('Не з\'їв'),
    onSwipe: () => { swiped(); toggleSkipped(M.today(), item); },
  });
}

/** Іконка прийому: за назвою (сніданок, обід, вечеря, перекус), інакше — за годиною початку. */
function mealIcon(meal) {
  if (meal.isPause) return 'calendar';
  const name = meal.name.toLowerCase();
  if (/перекус|полдник|підвечір/.test(name)) return 'apple';
  if (/завтрак|сніданок/.test(name)) return 'cup';
  if (/ужин|вечер/.test(name)) return 'moon';
  if (/обед|обід/.test(name)) return 'plate';
  const hour = Number(/(\d{1,2}):\d{2}/.exec(meal.time ?? '')?.[1]);
  if (Number.isNaN(hour)) return 'plate';
  return hour < 11 ? 'cup' : hour < 16 ? 'plate' : 'moon';
}

function mealBox(meal, index) {
  // Тимчасово вимкнені не їдяться й не пропускаються — їх ніби немає в прийомі
  const active = meal.items.filter((x) => !x.off);
  const eaten = active.filter((x) => !x.skipped);
  const s = totals(eaten);
  // Увесь прийом пропущено — заголовок каже це, ккал у ньому немає
  const missed = active.length > 0 && !eaten.length;
  const title = [meal.name, meal.time ? ` · ${meal.time}` : ''].join('');
  const tools = meal.isPause ? [] : [
    toolBtn('plus', t('Додати продукт'), () => itemForm(null, { meal: meal.id })),
    toolBtn('edit', t('Змінити'), () => mealForm(meal)),
  ];
  const key = `meal:${meal.id}`;
  openFirstTime(key);
  const toggleMeal = () => toggleMealSkipped(M.today(), meal);
  const title2 = [withIcon(mealIcon(meal), title), missed ? h('span', { class: 'food-tag skip' }, t('пропущено')) : null];
  if (!meal.items.length) {
    return box(title2, h('p', { class: 'muted small' }, t('Порожньо — додайте продукт «+»')), { fold: key, tools });
  }
  let el;
  if (missed) {
    // Пропущений прийом — один рядок замість закреслених продуктів
    const all = totals(active);
    el = box(title2, h('div', { class: 'food-missed' },
      h('p', {}, h('b', {}, t('Не їли · −{k}', { k: kcal(all.kcal) })),
        h('span', { class: 'muted small' }, active.map((x) => x.name).join(', '))),
      h('button', { type: 'button', class: 'btn food-meal-btn', onclick: toggleMeal }, t('Повернути прийом'))), { fold: key, tools });
  } else {
    const hint = index === 0 && !recall(SWIPE_SEEN)
      ? h('p', { class: 'muted small food-swipe-hint' }, t('Свайп уліво по продукту — не з\'їв, по заголовку — весь прийом.')) : null;
    // Згорнутий прийом показує ккал у заголовку
    el = box(title2, h('div', {},
      h('div', { class: 'rows' }, meal.items.map(swipeRow)),
      h('div', { class: 'food-sum' }, h('b', {}, kcal(s.kcal)), h('span', { class: 'muted' }, macros(s))),
      meal.note ? h('p', { class: 'muted small food-note' }, meal.note) : null,
      hint), { fold: key, count: Math.round(s.kcal) ? kcal(s.kcal) : null, tools });
  }
  el.classList.add('food-meal');
  // Свайп по заголовку — увесь прийом; смуга на всю ширину блоку, заголовок великий
  return swipeLeft(el, {
    label: missed ? t('Повернути прийом') : t('Не їв'),
    canStart: (e) => e.clientY < el.querySelector('legend').getBoundingClientRect().bottom + 8
      && !e.target.closest('.rows, .food-missed'),
    onSwipe: () => { swiped(); toggleMeal(); },
  });
}

/** Скільки разів група була продуктом дня цього тижня (пн — сьогодні) і скільки треба. */
function weekCount(plan, picks, item, date) {
  const list = plan.day?.items ?? [];
  const g = groupOf(item);
  const members = list.filter((p) => groupOf(p) === g);
  let n = 0;
  for (let d = M.weekStart(date); d <= date; d = M.addDays(d, 1)) {
    const p = list.find((x) => x.id === picks[d]);
    if (p && groupOf(p) === g) n += 1;
  }
  return { n, of: Math.max(...members.map((p) => Number(p.perWeek) || 0)), shared: members.length > 1 };
}

/** Продукт дня одним рядком у картці; тап — шторка з вибором. */
function dayPicker(state, day) {
  const choice = day.choice;
  if (!choice) {
    return h('button', { type: 'button', class: 'food-pick empty', onclick: () => itemForm(null, { day: true }) },
      icon('plus'), h('span', {}, t('Додати продукт дня')));
  }
  return h('button', { type: 'button', class: 'food-pick', 'aria-haspopup': 'dialog', onclick: () => pickSheet(state) },
    h('span', { class: 'food-pick-main' },
      h('span', { class: 'food-pick-label' }, t('Продукт дня')),
      h('b', {}, `${choice.item.name} · ${kcal(choice.item.kcal)}`),
      choice.picked ? null : h('span', { class: 'food-pick-hint' }, t('пропозиція — натисніть, щоб вибрати'))),
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
}

/** Шторка вибору продукту дня: ккал, білок і скільки разів цього тижня з потрібних. */
function pickSheet(state) {
  const body = () => {
    const day = today(current ?? state);
    if (!day) return null;
    const date = M.today();
    const picks = picksOf(current ?? state);
    const all = day.plan.day?.items ?? [];
    const list = all.filter((p) => !offAt(p, date));
    const offs = all.filter((p) => offAt(p, date));
    const cur = day.choice?.item.id;
    // Тимчасово вимкнені — окремо внизу; тап — картка з «Повернути в раціон»
    const offRows = offs.length ? [h('h4', { class: 'food-sub' }, t('Тимчасово не додаю')), h('div', { class: 'rows' }, offs.map((p) => h('button', {
      type: 'button', class: 'row pick-row off', onclick: () => { closeIt(); itemSheet({ ...p, isDay: true, off: offAt(p, date) }); },
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, p.name, h('span', { class: 'food-tag skip' }, offText(offAt(p, date))))),
      h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(p.kcal))))))] : null;
    return h('div', { class: 'pick-list' },
      h('div', { class: 'rows', role: 'radiogroup', 'aria-label': t('Продукт дня') }, list.map((p) => {
        const w = weekCount(day.plan, picks, p, date);
        const on = p.id === cur;
        // Рядок — вибір; олівець поруч — правка чи видалення продукту зі списку продуктів дня
        return h('div', { class: 'pick-item' }, h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(on && day.choice.picked),
          class: `row pick-row ${on ? 'on' : ''} ${on && !day.choice.picked ? 'suggested' : ''}`,
          onclick: async () => { closeIt(); if (!(day.choice.picked && on)) await setPick(current ?? state, date, p.id); },
        },
          h('span', { class: 'pick-radio', 'aria-hidden': 'true' }),
          h('div', { class: 'row-main' },
            h('span', { class: 'row-title' }, p.name, on && !day.choice.picked ? h('span', { class: 'food-tag' }, t('пропозиція')) : null),
            h('span', { class: 'muted small' }, [p.qty, t('Б {p}', { p: fmt.int(p.p) })].filter(Boolean).join(' · '))),
          h('div', { class: 'row-side' },
            h('span', { class: 'food-kcal' }, fmt.int(p.kcal)),
            w.of ? h('span', { class: `small ${w.n >= w.of ? 'good' : 'muted'}` },
              t(w.shared ? 'разом {n} з {of} за тиж.' : '{n} з {of} за тиж.', { n: w.n, of: w.of })) : null)),
        toolBtn('edit', t('Змінити «{name}»', { name: p.name }), () => { closeIt(); itemForm(p, { day: true }); }));
      })),
      offRows,
      h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Продукт дня')), () => { closeIt(); itemForm(null, { day: true }); })));
  };
  const closeIt = sheet(t('Продукт дня'), body(), { live: body });
}

function pauseNote(pause) {
  const p = pause.now ?? pause.next;
  if (!p) return null;
  if (pause.now) {
    return h('div', { class: 'food-pause on' }, icon('calendar'),
      h('span', {}, h('b', {}, t('Пауза на підтриманні')), ' ', t('до {date} — їжі більше, вага не знижується', { date: fmt.date(p.to) })));
  }
  const days = M.daysBetween(M.today(), p.from);
  if (days > 30) return null;
  return h('div', { class: 'food-pause' }, icon('calendar'),
    h('span', {}, t('Пауза на підтриманні з {date} — через {n} {d}', { date: fmt.date(p.from), n: days, d: plural(days, [t('день'), t('дні'), t('днів')]) })));
}

/** Дати пауз і добавка до них — правляться тут, бо сама добавка видна лише під час паузи. */
function pausesBox(plan) {
  const date = M.today();
  const list = (plan.pauses ?? []).map((p, i) => ({ ...p, i })).sort((a, b) => (a.from < b.from ? -1 : 1));
  const extra = plan.pauseItems ?? [];
  return box(withIcon('calendar', t('Паузи: дати й добавка')), h('div', {},
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
// Останній стан — для живої шторки вибору продукту дня
let current = null;

// Підрозділи «Раціону»: день — щоденна робота, календар — історія, довідка — рідко
const RATION_SEGS = [['today', 'Сьогодні'], ['calendar', 'Календар'], ['refs', 'Довідка']];
const SEG_KEY = 'weight-log:ration-seg';
let rationSeg = RATION_SEGS.some(([k]) => k === recall(SEG_KEY)) ? recall(SEG_KEY) : 'today';

export function renderRation(state, { noPlan, render, burn }) {
  current = state;
  const day = today(state);
  if (!day) return h('div', {}, noPlan(), box(withIcon('leaf', t('Харчування при діабеті')), dietMemo(), { fold: 'diet' }));
  const seg = segmented(RATION_SEGS.map(([k, l]) => [k, t(l)]), rationSeg, (v) => {
    rationSeg = v;
    remember(SEG_KEY, v);
    render();
  });
  const body = { today: rationToday, calendar: rationCalendar, refs: rationRefs }[rationSeg];
  return h('div', {}, seg, body(state, day, burn));
}

/** «Норма 2 490 · дефіцит 760» під підсумком дня; на утриманні — баланс зі знаком. */
function burnLine(sum, burn) {
  const b = burn?.();
  if (!b?.kcal) return null;
  const r10 = (v) => Math.round(v / 10) * 10;
  // Дефіцит — від показаної (округленої) норми, щоб «норма − з'їдене» сходилося в голові
  const n = r10(b.kcal); const diff = r10(sum.kcal - n);
  const rest = b.hold ? t('баланс {d}', { d: fmt.signed(diff, 0) })
    : diff <= 0 ? t('дефіцит {d}', { d: fmt.int(-diff) }) : t('понад норму {d}', { d: fmt.int(diff) });
  return h('div', { class: 'hero-sub' }, t('Норма {n} · {r}', { n: fmt.int(n), r: rest }));
}

/** БЖУ дня — окремими плитками під калоріями, як «Норма · Сьогодні · Дефіцит» на головній. */
function macroTiles(sum) {
  const cell = (label, g) => h('div', { class: 'kcal-cell' },
    h('span', { class: 'muted small' }, label), h('b', {}, fmt.int(g), h('small', {}, t('г'))));
  return h('div', { class: 'kcal-grid food-macros' }, cell(t('Білки'), sum.p), cell(t('Жири'), sum.f), cell(t('Вуглеводи'), sum.c));
}

function rationToday(state, day, burn) {
  const { plan, pause, meals, planned, extra, sum } = day;
  const norm = plan.norm;
  return h('div', {},
    h('section', { class: 'hero accent food-hero' },
      h('div', { class: 'hero-label' }, t('Сьогодні')),
      h('div', { class: 'hero-value' }, fmt.int(sum.kcal), h('span', { class: 'hero-unit' }, t('ккал'))),
      extra.kcal ? h('div', { class: 'hero-sub food-split' },
        t('за планом {a} + поза планом {b}', { a: fmt.int(planned.kcal), b: fmt.int(extra.kcal) })) : null,
      burnLine(sum, burn),
      macroTiles(sum),
      dayPicker(state, day),
      windowEl(plan, Boolean(pause.now))),
    pauseNote(pause),
    dayCard(state),
    meals.map(mealBox),
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Прийом їжі')), () => mealForm(null))),
    norm ? h('p', { class: 'muted small food-norm' }, t('План у середньому за тиждень: {k} · {m}', { k: kcal(norm.kcal), m: macros(norm) })) : null);
}

function rationCalendar(state, { plan }) {
  return h('div', {},
    calendarPanel(state),
    monthBox(state, energy(state, M.series(state.weights))),
    pausesBox(plan));
}

function rationRefs(state, { plan }) {
  return h('div', {},
    (plan.refs ?? []).map((r) => box(withIcon('book', r.title), refText(r.text), {
      fold: `ref:${r.id}`, tools: [toolBtn('edit', t('Змінити'), () => refForm(r))],
    })),
    box(withIcon('leaf', t('Харчування при діабеті')), dietMemo(), { fold: 'diet' }),
    h('div', { class: 'btn-row' }, btn(withIcon('note', t('Мітки')), () => tagsForm(plan))));
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
export function homeLine(state, badge = null) {
  const day = today(state);
  if (!day) return null;
  const sub = h('span', { class: 'muted small' });
  const el = h('a', { href: '#ration', class: 'panel food-line' },
    icon('plate'),
    h('span', { class: 'food-line-main' },
      h('b', {}, day.choice ? `${day.choice.item.short || day.choice.item.name} · ${kcal(day.sum.kcal)}` : kcal(day.sum.kcal)),
      sub),
    badge,
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
  const status = dayOf(state, M.today())?.status;
  el.paint = () => {
    const win = windowText(day.plan);
    // Вікно закрите — час позначити день; позначений — показати як
    if (status) sub.replaceChildren(h('span', { class: `day-dot ${status}`, 'aria-hidden': 'true' }), t(STATUS[status]));
    else if (win?.state === 'closed') sub.textContent = t('Як день? Позначте в «Раціоні»');
    else sub.textContent = win?.text ?? '';
    sub.hidden = !status && !win;
  };
  el.paint();
  return el;
}

/** Мітки під нотаткою до ваги: тап додає слово в нотатку або прибирає його. */
export function noteTags(state, input) {
  const tags = tagLists(planOf(state)).note;
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
