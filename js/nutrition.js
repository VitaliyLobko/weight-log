// Раціон: план харчування на день — прийоми їжі, продукт дня, вікно їжі, паузи, довідка й мітки до нотатки.
// Сам план — запис налаштувань (у репозиторії його нема), тут лише показ і правка.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import { h, fmt, sheet, toast, form, btn, toolBtn, box, confirmSheet, remember, recall, unfold, swipeLeft, segmented, isoToDmy } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { dietMemo } from './diet.js';
import { monthBox, extrasSum, dayOf, rationStart, STATUS, toggleSkipped, toggleMealSkipped, setPortion, setMealPortion, calendarPanel, myFoodsBox, dictBox, countFood, voiceControl } from './daylog.js';
import { parsePiece } from './foods.js';
import { aiRationSheet } from './ai-ration.js';
import { menuPicker, setProteinSource } from './menus.js';

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
 * Замінено раціоном з ШІ: такий період (replaced) ховає продукт зовсім, а не показує «не додаю».
 * Старі продукти — з дня заміни, нові — до дня заміни: минулі дні рахуються як були.
 */
const replacedAt = (item, date) => (item.offs ?? []).some((p) => p.replaced && p.from <= date && (!p.to || date <= p.to));
const REPLACED_FROM = '2000-01-01';
/** Перший день нового продукту з ШІ-раціону; звичайний — null. */
const startOf = (item) => {
  const p = (item.offs ?? []).find((x) => x.replaced && x.from === REPLACED_FROM && x.to);
  return p ? M.addDays(p.to, 1) : null;
};

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
  const rec = dayOf(state, date);
  const skipped = new Set(rec?.skipped ?? []);
  const portions = rec?.portions ?? {};
  const mark = (x, mealId) => {
    const off = offAt(x, date);
    if (off) return { ...x, off };
    if (skipped.has(x.id)) return { ...x, skipped: true };
    // Не вся порція: своя в продукту важить більше, ніж порція всього прийому; full — як у плані
    const own = portions[x.id];
    const portion = own ?? portions[`meal:${mealId}`];
    if (!(portion > 0 && portion < 1)) return x;
    return { ...x, ...Object.fromEntries(KEYS.map((k) => [k, (Number(x[k]) || 0) * portion])), portion, ownPortion: own !== undefined, full: x };
  };
  const order = (list) => [...list.filter((x) => !x.off), ...list.filter((x) => x.off)];
  // Меню на цей день — увесь день: страви плану не показуються в жодному прийомі; продукт дня й пауза лишаються
  const menu = Array.isArray(rec?.menu?.meals) ? rec.menu : null;
  const menuMeals = new Map((menu?.meals ?? []).map((m) => [m.id, m]));
  const own = (m) => (menu ? (menuMeals.get(m.id)?.items ?? []).map((x) => ({ ...x, fromMenu: true }))
    : (m.items ?? []).filter((x) => !replacedAt(x, date)));
  const planMeals = plan.meals ?? [];
  const meals = planMeals.map((m) => ({
    ...m,
    portion: portions[`meal:${m.id}`] ?? null,
    fromMenu: Boolean(menu),
    items: order([...own(m), ...(choice && plan.day?.meal === m.id ? [{ ...choice.item, isDay: true }] : [])].map((x) => mark(x, m.id))),
  }));
  // Прийом меню, якого в плані вже нема, не губиться — окремим блоком зі своєю назвою
  for (const mm of menu?.meals ?? []) {
    if (planMeals.some((m) => m.id === mm.id) || !mm.items?.length) continue;
    meals.push({
      id: mm.id, name: mm.name || t('Прийом'), time: mm.time ?? '', portion: portions[`meal:${mm.id}`] ?? null, fromMenu: true, orphan: true,
      items: order(mm.items.map((x) => mark({ ...x, fromMenu: true }, mm.id))),
    });
  }
  if (pause.now && plan.pauseItems?.length) {
    meals.push({ id: 'pause', name: t('Добавка в паузу'), portion: portions['meal:pause'] ?? null, items: order(plan.pauseItems.map((x) => mark(x, 'pause'))), isPause: true });
  }
  const planned = totals(meals.flatMap((m) => m.items).filter((x) => !x.skipped && !x.off));
  const extra = extrasSum(state, date);
  // Підсумок дня — план плюс з'їдене поза планом
  return { plan, choice, pause, meals, planned, extra, sum: totals([planned, extra]), cut: cutOfMeals(meals), menu };
}

/**
 * Прийоми на сьогодні для ШІ-раціону: [{ id, name, time, kcal, items }] — ккал за планом (повна порція,
 * без тимчасово вимкнених і продукту дня), щоб ціль ділилась у звичних вам пропорціях.
 */
export function mealsToday(state, date = M.today()) {
  const day = today(state, date);
  return (day?.meals ?? []).filter((m) => !m.isPause).map((m) => {
    const items = m.items.filter((x) => !x.off && !x.isDay).map((x) => x.full ?? x);
    return { id: m.id, name: m.name, time: m.time ?? '', kcal: totals(items).kcal, items };
  });
}

/**
 * Що сьогодні додається понад прийоми й заміною не чіпається: продукт дня (у своєму прийомі) і добавка в паузу.
 * → { day: { name, kcal, meal } | null, pause: ккал }.
 */
export function fixedToday(state) {
  const day = today(state);
  const pick = day?.meals.flatMap((m) => m.items.filter((x) => x.isDay && !x.off)
    .map((x) => ({ name: x.name, kcal: Number((x.full ?? x).kcal) || 0, p: Number((x.full ?? x).p) || 0, meal: m.id })))[0] ?? null;
  const inPause = totals((day?.meals.find((m) => m.isPause)?.items ?? []).filter((x) => !x.off).map((x) => x.full ?? x));
  return { day: pick, pause: inPause.kcal, pauseP: inPause.p };
}

/** Частка порції коротко: ½, ¾, ¼, інакше відсотки. */
export const portionText = (p) => ({ 0.25: '¼', 0.5: '½', 0.75: '¾' })[p] ?? `${Math.round(p * 100)} %`;

/**
 * Скільки з плану не з'їли: { kcal, names, parts }. names — не з'їв: прийом цілком — «Обід — цілком», далі продукти;
 * parts — з'їв частину: «Обід ½» (порція прийому), «Гречка ¾» (своя порція).
 */
function cutOfMeals(meals) {
  let kcalCut = 0;
  const names = [];
  const parts = [];
  for (const m of meals) {
    const active = m.items.filter((x) => !x.off);
    kcalCut += active.reduce((a, x) => a + (Number((x.full ?? x).kcal) || 0) - (x.skipped ? 0 : Number(x.kcal) || 0), 0);
    const whole = active.length > 1 && active.every((x) => x.skipped);
    if (whole) { names.push(t('{name} — цілком', { name: m.name })); continue; }
    if (m.portion > 0 && m.portion < 1 && active.some((x) => x.portion && !x.ownPortion)) parts.push(`${m.name} ${portionText(m.portion)}`);
    for (const x of active) {
      if (x.skipped) names.push(x.name);
      else if (x.ownPortion) parts.push(`${x.name} ${portionText(x.portion)}`);
    }
  }
  return { kcal: kcalCut, names, parts };
}

/** Що з плану цього дня не з'їли (не з'їв і не вся порція): { kcal, names, parts }. */
export const cutOf = (state, date) => today(state, date)?.cut ?? { kcal: 0, names: [], parts: [] };

/** «не з'їв: … · з'їв частину: …» — для шторки дня й журналу; first — з великої. */
export function cutText(cut, { first = false } = {}) {
  const out = [cut.names.length ? t('не з\'їв: {list}', { list: cut.names.join(', ') }) : null,
    cut.parts.length ? t('з\'їв частину: {list}', { list: cut.parts.join(', ') }) : null].filter(Boolean).join(' · ');
  return first ? out.replace(/^./, (c) => c.toUpperCase()) : out;
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
  const w = energyWindow(state, rows);
  if (!w || w.days < ENERGY_MIN || w.eaten.length < ENERGY_MIN) return null;
  const { then, cur, days, eaten } = w;
  const intake = eaten.reduce((a, v) => a + v, 0) / eaten.length;
  const burn = intake + ((then.avg - cur.avg) * KCAL_PER_KG) / days;
  return { burn, intake, deficit: burn - intake, marked: eaten.length, days };
}

/** Вікно реальної витрати: середні на краях 4 тижнів і з'їдене в позначені дні між ними. */
function energyWindow(state, rows) {
  const withAvg = rows.filter((r) => r.avg !== null);
  const cur = withAvg.at(-1);
  if (!cur || !planOf(state)) return null;
  const then = withAvg.find((r) => r.date >= M.addDays(cur.date, -ENERGY_DAYS));
  const eaten = [];
  const auto = autoFrom(state);
  for (let d = then.date; d <= cur.date; d = M.addDays(d, 1)) {
    if (!dayOf(state, d)?.status && !(auto && d >= auto && d < M.today())) continue;
    eaten.push((plannedKcal(state, d) ?? 0) + extrasSum(state, d).kcal);
  }
  return { then, cur, days: M.daysBetween(then.date, cur.date), eaten };
}

/**
 * «Невідмічені дні — як за планом» (goal.autoPlan): з якої дати минулий день без позначки рахується в нормі за вашими даними
 * як «за планом». Від першої позначки «Як день?» — дні до раціону не беремо. Вимкнено чи позначок нема — null.
 */
function autoFrom(state) {
  return state.settings.find((s) => s.id === M.GOAL_ID)?.autoPlan ? rationStart(state) : null;
}

/** Минулий день без позначки, який рахується як «за планом» (див. autoFrom). */
export function autoPlanDay(state, date) {
  if (dayOf(state, date)?.status || date >= M.today()) return false;
  const auto = autoFrom(state);
  return !!auto && date >= auto;
}

/** Скільки ще позначених днів «Як день?» до норми за вашими даними; 0 — уже за ними, null — без плану. */
export function energyLeft(state, rows) {
  const w = energyWindow(state, rows);
  return w ? Math.max(0, ENERGY_MIN - w.eaten.length) : null;
}

/** Хвилин прогулянки за день (з «Як день?»). */
export const walkOf = (state, date) => Number(dayOf(state, date)?.walk) || 0;

/**
 * Норма дня: norm { kcal, hold, walk, kg } плюс прогулянка цього дня. walk — норма за формулою:
 * у реальній витраті прогулянки вже є (вона з ваги й з'їденого), там не додаємо.
 */
export function dayNorm(state, norm, date) {
  if (!norm?.walk) return norm;
  return { ...norm, kcal: norm.kcal + M.walkKcal(walkOf(state, date), norm.kg) };
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
  // Прогулянки — до норми за формулою: сьогоднішня до норми дня, середня за тиждень — до середньої
  const walks = !en ? Array.from({ length: 7 }, (_, i) => M.walkKcal(walkOf(state, M.addDays(M.today(), -i)), kg)) : [0];
  const walkToday = walks[0];
  const walkWeek = walks.reduce((a, v) => a + v, 0) / walks.length;
  return {
    burn,
    burnToday: burn + walkToday,
    burnWeek: burn + walkWeek,
    walkToday,
    walkWeek,
    intake,
    balance: intake !== null ? intake - (burn + walkWeek) : null,
    source: en ? 'real' : 'formula',
    en,
    f,
    todayKcal: dayKcal(state, M.today()),
  };
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

export function undoToast(message, before) {
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

/**
 * Дні з часткою прийому (½ сніданку): продукт, що переїжджає, отримує ту частку як свою —
 * інакше минулі дні перерахувалися б за порцією нового прийому. Повертає [{ before, after }].
 */
function pinPortions(state, item, fromId, toId) {
  const out = [];
  for (const rec of state.settings) {
    const p = rec.portions;
    if (!rec.id.startsWith('day:') || !rec.date || !p || !(`meal:${fromId}` in p || `meal:${toId}` in p)) continue;
    const x = today(state, rec.date)?.meals.find((m) => m.id === fromId)?.items
      .find((y) => (item.isDay ? y.isDay : y.id === item.id));
    if (!x || x.off || x.skipped || x.id in p) continue;
    const { updated, ...plain } = rec;
    out.push({ before: plain, after: { ...plain, portions: { ...p, [x.id]: x.portion ?? 1 } } });
  }
  return out;
}

/**
 * Перенести продукт в інший прийом плану; продукт дня — усі продукти дня разом (у плані він один на прийом).
 * Калорії дня ті самі, суми прийомів перераховуються самі — їх рахує buildDay з плану.
 */
async function moveToMeal(item, from, to) {
  sync.renewOnGesture();
  const state = await db.loadAll();
  const before = planOf(state);
  if (!before) return;
  const plan = structuredClone(before);
  delete plan.updated;
  if (item.isDay) plan.day = { ...(plan.day ?? { items: [] }), meal: to.id };
  else {
    const at = locate(plan, item.id);
    const target = listOf(plan, { meal: to.id });
    if (!at || !target) return;
    target.push(...at.list.splice(at.i, 1));
  }
  const days = pinPortions(state, item, from.id, to.id);
  await db.write({ settings: { put: [plan, ...days.map((d) => d.after)] } });
  const { updated, ...old } = before;
  toast(item.isDay ? t('Продукт дня тепер у «{meal}»', { meal: to.name })
    : t('«{name}» тепер у «{meal}»', { name: item.name, meal: to.name }), {
    action: t('Скасувати'),
    onAction: () => db.write({ settings: { put: [old, ...days.map((d) => d.before)] } }),
  });
}

async function removeItem(item) {
  const before = await savePlan((plan) => {
    const at = locate(plan, item.id);
    if (at) at.list.splice(at.i, 1);
  });
  undoToast(t('«{name}» видалено', { name: item.name }), before);
}

/**
 * Раціон з ШІ замість страв прийомів з date: meals — [{ id, items: [{ name, qty, grams, kcal, p, f, c }] }].
 * Старі продукти лишаються в плані для минулих днів (період replaced від date), нові — лише від date.
 * Додане того ж дня попередньою заміною в минулих днях не було — прибирається зовсім. → план до зміни.
 */
export function replaceRation(meals, date = M.today()) {
  const prev = M.addDays(date, -1);
  return savePlan((plan) => {
    for (const g of meals) {
      const m = plan.meals?.find((x) => x.id === g.id);
      if (!m) continue;
      m.items = (m.items ?? []).flatMap((x) => {
        if (startOf(x) === date) return [];
        if (replacedAt(x, date)) return [x];
        return [{ ...x, offs: [...(x.offs ?? []), { from: date, replaced: true }] }];
      });
      m.items.push(...g.items.map((x) => ({
        id: newId(), name: x.name, qty: x.qty ?? '', ...(x.grams ? { grams: x.grams } : {}),
        ...Object.fromEntries(KEYS.map((k) => [k, Number(x[k]) || 0])), note: '', alts: [], src: 'ai',
        offs: [{ from: REPLACED_FROM, to: prev, replaced: true }],
      })));
    }
  });
}

/** День останньої заміни раціону з ШІ, що ще діє; немає — null. */
export function lastReplace(plan) {
  const days = (plan?.meals ?? []).flatMap((m) => (m.items ?? []).flatMap((x) => (x.offs ?? []).filter((p) => p.replaced && !p.undone && p.from !== REPLACED_FROM && !p.to).map((p) => p.from)));
  return days.length ? days.sort().at(-1) : null;
}

/**
 * Повернути раціон, який був до останньої заміни, — з date: минулі дні не перераховуються.
 * Заміна сьогоднішня — просто прибрати її сліди. → план до зміни.
 */
export function revertRation(date = M.today()) {
  const prev = M.addDays(date, -1);
  return savePlan((plan) => {
    const at = lastReplace(plan);
    if (!at) return;
    for (const m of plan.meals ?? []) {
      m.items = (m.items ?? []).flatMap((x) => {
        const start = startOf(x);
        // Нові з тієї заміни: сьогоднішні — геть, давніші — вимкнути з сьогодні
        // undone — не нова заміна: «Повернути» вдруге не відкотить повернення
        if (start && start >= at && !replacedAt(x, date)) return start === date ? [] : [{ ...x, offs: [...x.offs, { from: date, replaced: true, undone: true }] }];
        const offs = (x.offs ?? []).flatMap((p) => {
          if (!(p.replaced && p.from === at && !p.to)) return [p];
          return at === date ? [] : [{ ...p, to: prev }];
        });
        return [{ ...x, offs }];
      });
    }
  });
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

/**
 * «З'їв не всю порцію» сьогодні: ¼ · ½ · ¾ · уся. key — id продукту чи `meal:<id>`; now — вибрана частка.
 * «Уся» в продукту, коли в прийому порція, — явна 1: продукт з'їли цілком, хоч прийом і не весь.
 */
function portionChips(key, name, now, { mealPortion = null, done, onPick, caption = t('З\'їв сьогодні:'), whole = true } = {}) {
  const pick = (p) => { done?.(); (onPick ?? ((v) => setPortion(M.today(), key, name, v === 1 && !mealPortion ? null : v)))(p); };
  return h('div', { class: 'chips food-portion', role: 'group', 'aria-label': t('Порція сьогодні') },
    h('span', { class: 'muted small' }, caption),
    [[0.25, '¼'], [0.5, '½'], [0.75, '¾'], ...(whole ? [[1, t('усе')]] : [])].map(([p, label]) => h('button', {
      type: 'button', class: now === p ? 'on' : '', 'aria-pressed': String(now === p), onclick: () => pick(p),
    }, label)));
}

/** «Перенести в: Обід · Вечеря» — інші прийоми плану; добавка в паузу прийомом не є. */
function moveChips(item, meal, others, done) {
  if (!meal || meal.isPause || !others.length) return null;
  return h('div', { class: 'chips food-portion food-move', role: 'group', 'aria-label': t('Перенести в інший прийом') },
    h('span', { class: 'muted small' }, item.isDay ? t('Продукт дня — у прийом:') : t('Перенести в:')),
    others.map((m) => h('button', { type: 'button', onclick: () => { done(); moveToMeal(item, meal, m); } }, m.name)));
}

function itemSheet(item, meal = null, others = []) {
  const alts = item.alts ?? [];
  const full = item.full ?? item;
  const body = h('div', { class: 'food-sheet' },
    h('div', { class: 'food-figures' },
      full.qty ? h('b', {}, full.qty) : null,
      h('span', {}, kcal(full.kcal)),
      h('span', { class: 'muted' }, macros(totals([full])))),
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
    // Порція — лише коли продукт з'їли: «не з'їв» і так знімає його цілком
    const mealPortion = meal?.portion > 0 && meal.portion < 1 ? meal.portion : null;
    if (!item.skipped && Number(full.kcal) > 0) {
      body.append(portionChips(item.id, item.name, item.portion ?? 1, { mealPortion, done: () => close() }),
        item.portion ? h('p', { class: 'muted small food-portion-note' }, t('Сьогодні в підсумку {k} з {all}{why}', {
          k: kcal(item.kcal), all: kcal(full.kcal), why: item.ownPortion ? '' : t(' — порція всього прийому'),
        })) : '');
    }
    body.append(h('div', { class: 'btn-row' },
      btn(item.skipped ? withIcon('check', t('Усе ж з\'їв')) : t('Сьогодні не з\'їв'), () => { close(); toggleSkipped(M.today(), item); }),
      // Страва меню дня — не з плану: «тимчасово не додаю», перенос і правка міняли б план, а не меню
      item.fromMenu ? null : btn(t('Тимчасово не додаю'), () => { close(); offForm(item); })));
  }
  if (item.fromMenu) body.append(h('p', { class: 'muted small' }, t('Страва з меню дня — змінюється в самому меню: «Меню дня» над прийомами.')));
  // Перенос — правка плану назавжди, тому окремо від «сьогодні» й останнім
  else body.append(moveChips(item, meal, others, () => close()) ?? '');
  // Продукт дня в обіді переставляється серед продуктів дня, а не серед страв обіду; правка — повні числа плану
  const close = sheet(item.name, body, {
    tools: item.fromMenu ? [] : [
      toolBtn('up', t('Вище'), () => moveItem(item.id, -1)),
      toolBtn('down', t('Нижче'), () => moveItem(item.id, 1)),
      toolBtn('edit', t('Змінити'), () => { close(); itemForm(full, full.isDay ? { day: true } : {}); }),
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
  // «Порахувати»: ккал і БЖВ за назвою й порцією — свої продукти → довідник → ШІ
  const note = h('p', { class: 'small muted ration-calc-note' }, t('Напишіть, що й скільки, — «Порахувати» підставить ккал і БЖВ.'));
  const calc = btn(withIcon('spark', t('Порахувати')), async () => {
    const v = f.values();
    const q = [v.name, v.qty].filter(Boolean).join(' ');
    if (!q) { f.inputs.name.focus(); toast(t('Напишіть, що це')); return; }
    calc.disabled = true;
    try {
      // Порція в назві («гречка 150 г») переходить у «Скільки», назва лишається своєю
      const typed = parsePiece(v.name);
      const own = typed.n !== null && !v.qty ? typed.name : v.name;
      const r = await countFood(q);
      note.textContent = r.note ?? '';
      const x = r.item;
      if (!x) return;
      // Та сама кількість слів — назва з довідника («кефіру» → «Кефір»); своя довша («Котлета домашня») — своя
      const count = (s) => s.trim().split(/\s+/).length;
      const same = r.parts.length === 1 && count(own) === count(x.name);
      f.inputs.name.value = !own || same ? x.name : own[0].toUpperCase() + own.slice(1);
      if (!v.qty || own !== v.name) f.inputs.qty.value = x.qty || (x.grams ? t('{g} г', { g: fmt.int(x.grams) }) : '');
      for (const k of KEYS) f.inputs[k].value = num(Number(x[k]));
      if (r.parts.length > 1) toast(t('Порахував як одну страву: {list}', { list: r.parts.map((p) => p.name).join(', ') }));
    } finally { calc.disabled = false; }
  }, 'food-calc');
  for (const k of ['name', 'qty']) f.inputs[k].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); calc.click(); } });
  // Голосом — сказане стає назвою з порцією й одразу рахується
  const voice = voiceControl({
    label: t('Сказати голосом'),
    onText: (said) => { f.inputs.name.value = said; },
    onDone: (said) => { f.inputs.name.value = said; f.inputs.qty.value = ''; calc.click(); },
  });
  f.inputs.qty.closest('.field').after(h('div', { class: 'ration-calc' }, calc, voice, note));
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
    onClose: () => voice?.cancel(),
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

function foodRow(item, meal = null, others = []) {
  // Без калорій (кава без цукру) — тихий рядок без «0»: число там лише шумить
  const zero = !(Number(item.kcal) > 0);
  return h('button', { type: 'button', class: `row food-row ${item.isDay ? 'day' : ''} ${zero ? 'zero' : ''} ${item.skipped ? 'skipped' : ''} ${item.off ? 'off' : ''}`, onclick: () => itemSheet(item, meal, others) },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, item.name, item.isDay ? h('span', { class: 'food-tag' }, t('продукт дня')) : null,
        item.skipped && !item.inMissed ? h('span', { class: 'food-tag skip' }, t('не з\'їв')) : null,
        item.off ? h('span', { class: 'food-tag skip' }, offText(item.off)) : null,
        item.ownPortion ? h('span', { class: 'food-tag part' }, portionText(item.portion)) : null),
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
function swipeRow(item, meal, others) {
  // Тимчасово вимкнений — без свайпу: «не з'їв» йому ні до чого
  if (item.off) return foodRow(item, meal, others);
  return swipeLeft(foodRow(item, meal, others), {
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

/**
 * «З'їв частину: ¼ ½ ¾» усередині прийому, а не кнопкою в шапці — на телефоні шапці бракує місця.
 * Пропущений прийом частка й повертає; вибрана частка — ще й «усе», щоб зняти її.
 */
function mealPortionRow(meal, { missed = false } = {}) {
  const now = missed ? null : meal.portion;
  return portionChips(`meal:${meal.id}`, meal.name, now, {
    caption: t('З\'їв частину:'), whole: Boolean(now), onPick: (p) => setMealPortion(M.today(), meal, p, { unskip: missed }),
  });
}

function mealBox(meal, index, all) {
  // Куди можна перенести продукт цього прийому
  const others = all.filter((m) => m.id !== meal.id && !m.isPause);
  // Тимчасово вимкнені не їдяться й не пропускаються — їх ніби немає в прийомі
  const active = meal.items.filter((x) => !x.off);
  const eaten = active.filter((x) => !x.skipped);
  const s = totals(eaten);
  // Увесь прийом пропущено — заголовок каже це, ккал у ньому немає
  const missed = active.length > 0 && !eaten.length;
  const title = [meal.name, meal.time ? ` · ${meal.time}` : ''].join('');
  // День за меню: «+» додав би продукт у план, а не в меню; прийом-сирота з меню в плані не правиться
  const tools = meal.isPause || meal.orphan ? [] : [
    meal.fromMenu ? null : toolBtn('plus', t('Додати продукт'), () => itemForm(null, { meal: meal.id })),
    toolBtn('edit', t('Змінити'), () => mealForm(meal)),
  ].filter(Boolean);
  const key = `meal:${meal.id}`;
  openFirstTime(key);
  const toggleMeal = () => toggleMealSkipped(M.today(), meal);
  // Не весь прийом — частка в тій самій плашці, що й ккал: шапка не розлазиться на кілька рядків
  const part = !missed && meal.portion > 0 && meal.portion < 1 ? `${portionText(meal.portion)} · ` : '';
  const title2 = [withIcon(mealIcon(meal), title), missed ? h('span', { class: 'food-tag skip' }, t('пропущено')) : null];
  if (!meal.items.length) {
    return box(title2, h('p', { class: 'muted small' }, meal.fromMenu ? t('У меню дня цей прийом порожній.') : t('Порожньо — додайте продукт «+»')), { fold: key, tools });
  }
  let el;
  if (missed) {
    // Пропущений прийом — один рядок замість закреслених продуктів
    const all = totals(active);
    el = box(title2, h('div', { class: 'food-missed' },
      h('p', {}, h('b', {}, t('Не їли · −{k}', { k: kcal(all.kcal) })),
        h('span', { class: 'muted small' }, active.map((x) => x.name).join(', '))),
      h('button', { type: 'button', class: 'btn food-meal-btn', onclick: toggleMeal }, t('Повернути прийом')),
      // З'їли не нічого, а частину — повернути прийом із часткою одним тапом
      mealPortionRow(meal, { missed: true })), { fold: key, tools });
  } else {
    const hint = index === 0 && !recall(SWIPE_SEEN)
      ? h('p', { class: 'muted small food-swipe-hint' }, t('Свайп уліво по продукту — не з\'їв, по заголовку — весь прийом.')) : null;
    // Згорнутий прийом показує ккал у заголовку
    el = box(title2, h('div', {},
      h('div', { class: 'rows' }, meal.items.map((x) => swipeRow(x, meal, others))),
      h('div', { class: 'food-sum' }, h('b', {}, kcal(s.kcal)), h('span', { class: 'muted' }, macros(s))),
      active.length ? mealPortionRow(meal) : null,
      meal.note ? h('p', { class: 'muted small food-note' }, meal.note) : null,
      hint), { fold: key, count: Math.round(s.kcal) ? `${part}${kcal(s.kcal)}` : null, tools });
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
const RATION_SEGS = [['today', 'Сьогодні'], ['calendar', 'Календар'], ['foods', 'Продукти'], ['refs', 'Довідка']];
const SEG_KEY = 'weight-log:ration-seg';
let rationSeg = RATION_SEGS.some(([k]) => k === recall(SEG_KEY)) ? recall(SEG_KEY) : 'today';

export function renderRation(state, { noPlan, render, burn, aim, protein }) {
  current = state;
  // Редактор меню (🔄) бере мінімум білка звідси ж
  setProteinSource(protein);
  const day = today(state);
  if (!day) return h('div', {}, noPlan(), box(withIcon('leaf', t('Харчування при діабеті')), dietMemo(), { fold: 'diet' }));
  const seg = segmented(RATION_SEGS.map(([k, l]) => [k, t(l)]), rationSeg, (v) => {
    rationSeg = v;
    remember(SEG_KEY, v);
    render();
  });
  const body = { today: rationToday, calendar: rationCalendar, foods: rationFoods, refs: rationRefs }[rationSeg];
  return h('div', {}, seg, body(state, day, burn, aim, protein));
}

const r10 = (v) => Math.round(v / 10) * 10;

/**
 * «дефіцит 760» / «понад норму 120», на утриманні — «баланс +120»; norm — { kcal, hold }.
 * Від округлених чисел, щоб «норма − з'їдене» сходилося в голові.
 */
export function balanceText(eaten, norm) {
  const diff = balanceDiff(eaten, norm);
  return norm.hold ? t('баланс {d}', { d: fmt.signed(diff, 0) })
    : diff <= 0 ? t('дефіцит {d}', { d: fmt.int(-diff) }) : t('понад норму {d}', { d: fmt.int(diff) });
}

/** З'їдене мінус норма, обидва округлені до 10 ккал. */
export const balanceDiff = (eaten, norm) => r10(eaten) - r10(norm.kcal);

/** Колір балансу як на плитці головної: худнення — дефіцит добре; утримання — добре в межах ±150. */
export const balanceGood = (eaten, norm) => (norm.hold ? Math.abs(balanceDiff(eaten, norm)) <= 150 : balanceDiff(eaten, norm) <= 0);

/** «Норма 2 490 · дефіцит 760» під підсумком дня. */
function burnLine(state, sum, burn) {
  const b = burn?.();
  if (!b?.kcal) return null;
  const n = dayNorm(state, b, M.today());
  // Дефіцит — головне число рядка: жирним і кольором, як плитка на головній
  return h('div', { class: 'hero-sub' }, t('Норма {n}', { n: fmt.int(r10(n.kcal)) }), ' · ',
    h('b', { class: `hero-balance ${balanceGood(sum.kcal, n) ? 'good' : 'bad'}` }, balanceText(sum.kcal, n)),
    n.kcal > b.kcal ? h('span', { class: 'muted' }, ` · ${t('з прогулянкою')}`) : null);
}

/** БЖУ дня — окремими плитками під калоріями; з мінімумом білка — «мін. N» і зелений, коли добрали. */
function macroTiles(sum, prot) {
  const min = prot?.g ?? null;
  const cell = (label, g, extra = null, cls = '') => h('div', { class: `kcal-cell${cls}` },
    h('span', { class: 'muted small' }, label), h('b', {}, fmt.int(g), h('small', {}, t('г'))), extra);
  return h('div', { class: 'kcal-grid food-macros' },
    cell(t('Білки'), sum.p, min ? h('span', { class: 'muted small protein-min' }, t('мін. {g}', { g: fmt.int(min) })) : null,
      min && sum.p >= min ? ' good' : ''),
    cell(t('Жири'), sum.f), cell(t('Вуглеводи'), sum.c));
}

// ---------- мінімум білка ----------

const PROTEIN_SCENARIO = {
  gain: 'Ви тренуєтесь — цієї норми достатньо, щоб м\'язи росли.',
  maintenance: 'Цієї норми достатньо, щоб зберегти м\'язи.',
  moderate: 'На помірній дієті ця норма допомагає не втрачати м\'язи.',
  large: 'На жорсткій дієті м\'язам потрібно більше білка.',
};
export const NO_CALC_TEXT = 'Ми не розраховуємо норму білка для вашої ситуації. Порадьтеся з лікарем: іноді білок потрібно обмежувати.';

/** Попередження до мінімуму білка — тексти зі специфікації; r — результат M.proteinFor. */
export function proteinWarnings(r) {
  const text = {
    BIG_DEFICIT: t('Ваш дефіцит калорій великий ({d} %). Навіть із достатнім білком частина м\'язів може втрачатися. Спробуйте дефіцит до 20–25 %.', { d: fmt.int(r.deficit) }),
    EXTREME_DEFICIT: t('Дефіцит понад 40 % — це дуже багато. Немає даних, що білок захищає м\'язи за такого дефіциту. Радимо його зменшити.'),
    NO_TRAINING: t('Порада: силові тренування 2–3 рази на тиждень бережуть м\'язи сильніше, ніж будь-яка кількість білка.'),
    BMI_ADJUSTED: t('Норму розраховано від ваги {w} кг, а не від поточної: при великій вазі розрахунок від повної ваги завищує потребу.', { w: fmt.fix(r.ref, 1) }),
  };
  return r.warnings.filter((w) => text[w]).map((w) => ({ code: w, text: text[w] }));
}

/** Значення в рядку налаштувань «Білок». */
export function proteinValue(r, input) {
  if (!input) return input === null ? t('Не налаштовано') : '';
  if (input.missing) return t('Бракує зросту чи віку');
  if (!r) return '';
  return r.g === null ? t('Не рахуємо') : t('від {g} г на день', { g: fmt.int(r.g) });
}

/** Картка мінімуму білка: норма, пояснення, попередження, підказка про прийоми, застереження. */
export function proteinCard(r, input) {
  if (input?.missing) return h('p', { class: 'small muted' }, t('Для мінімуму білка вкажіть зріст і рік народження — у рядку «Норма калорій».'));
  if (!r) return null;
  if (r.g === null) return h('div', { class: 'protein-card' }, h('p', { class: 'small food-check' }, icon('warning'), h('span', {}, t(NO_CALC_TEXT))));
  const adjusted = r.warnings.includes('BMI_ADJUSTED');
  const basis = r.hold ? t('Розраховано для утримання ваги.')
    : r.guessed ? t('Витрату не пораховано (бракує статі) — беремо помірний дефіцит.')
      : r.deficit <= 0 ? t('Розраховано без дефіциту калорій: менше 5 % від витрати рахуємо як утримання.')
        : t('Розраховано для дефіциту {d} % від витрати — за планом схуднення.', { d: fmt.int(r.deficit) });
  return h('div', { class: 'protein-card' },
    h('div', { class: 'protein-title' }, t('Мінімум білка: {g} г на день', { g: fmt.int(r.g) })),
    h('p', { class: 'small' }, adjusted
      ? t('Це {m} г на кожен кілограм опорної ваги ({w} кг). Можна їсти більше, але м\'язам це майже нічого не додасть.', { m: fmt.fix(r.mult, 1), w: fmt.fix(r.ref, 1) })
      : t('Це {m} г на кожен кілограм ваги. Можна їсти більше, але м\'язам це майже нічого не додасть.', { m: fmt.fix(r.mult, 1) })),
    h('p', { class: 'small' }, t(PROTEIN_SCENARIO[r.scenario === 'maintenance' && !r.warnings.includes('NO_TRAINING') ? 'gain' : r.scenario])),
    h('p', { class: 'small muted' }, basis),
    proteinWarnings(r).map((w) => h('p', { class: `small ${w.code === 'NO_TRAINING' || w.code === 'BMI_ADJUSTED' ? 'muted' : 'food-check'}` },
      w.code.endsWith('DEFICIT') ? icon('warning') : null, h('span', {}, w.text))),
    r.mealTip ? h('p', { class: 'small' }, t('Розподіліть білок на 3–4 прийоми їжі, приблизно по {n} г.', { n: fmt.int(r.perMeal) })) : null,
    h('p', { class: 'small muted' }, t('Це загальна рекомендація, а не медична порада.')));
}

function rationToday(state, day, burn, aim, protein) {
  const { plan, pause, meals, planned, extra, sum } = day;
  const norm = plan.norm;
  return h('div', {},
    h('section', { class: 'hero accent food-hero' },
      h('div', { class: 'hero-label' }, t('Сьогодні')),
      h('div', { class: 'hero-value' }, fmt.int(sum.kcal), h('span', { class: 'hero-unit' }, t('ккал'))),
      extra.kcal ? h('div', { class: 'hero-sub food-split' },
        t('за планом {a} + поза планом {b}', { a: fmt.int(planned.kcal), b: fmt.int(extra.kcal) })) : null,
      burnLine(state, sum, burn),
      macroTiles(sum, protein?.()),
      dayPicker(state, day),
      menuPicker(state),
      windowEl(plan, Boolean(pause.now))),
    pauseNote(pause),
    meals.map(mealBox),
    h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Прийом їжі')), () => mealForm(null)),
      aim ? btn(withIcon('spark', t('Раціон з ШІ')), () => aiRationSheet(state, aim), 'ai-ration-open') : null),
    norm ? h('p', { class: 'muted small food-norm' }, t('План у середньому за тиждень: {k} · {m}', { k: kcal(norm.kcal), m: macros(norm) })) : null);
}

function rationCalendar(state, { plan }, burn) {
  const b = burn?.();
  return h('div', {},
    calendarPanel(state, b?.kcal ? b : null),
    monthBox(state, energy(state, M.series(state.weights))),
    pausesBox(plan));
}

/** «Продукти»: свої й довідник — переглянути, перевірити цифри, виправити. */
function rationFoods(state) {
  return h('div', {}, myFoodsBox(state), dictBox());
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

/** Рядок на головній: що сьогодні їсти й скільки лишилось вікна — тап веде у «Раціон». «Як день?» — картка одразу під ним. */
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
    // Позначений день — показати як; інакше — стан вікна
    if (status) sub.replaceChildren(h('span', { class: `day-dot ${status}`, 'aria-hidden': 'true' }), t(STATUS[status]));
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
