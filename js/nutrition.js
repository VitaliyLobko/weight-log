// Раціон: план харчування на день — прийоми їжі, продукт дня, вікно їжі, паузи, довідка й мітки до нотатки.
// Сам план — запис налаштувань (у репозиторії його нема), тут лише показ і правка.
import * as db from './db.js';
import * as sync from './sync.js';
import * as M from './model.js';
import { h, fmt, sheet, toast, form, btn, toolBtn, box } from './ui.js';
import { t, plural } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { dietMemo } from './diet.js';

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
  return { plan, choice, pause, meals, sum: totals(meals.flatMap((m) => m.items)) };
}

// ---------- запис ----------

async function savePlan(change) {
  const plan = structuredClone(planOf(await db.loadAll()));
  if (!plan) return;
  change(plan);
  delete plan.updated;
  sync.renewOnGesture();
  await db.write({ settings: { put: [plan] } });
}

/** Усі списки продуктів плану: заміна запису за id шукає в кожному. */
const lists = (plan) => [...(plan.meals ?? []).map((m) => m.items ?? []), plan.day?.items ?? [], plan.pauseItems ?? []];

function saveItem(item) {
  return savePlan((plan) => {
    for (const list of lists(plan)) {
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) { list[i] = { ...list[i], ...item }; return; }
    }
  });
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
  const close = sheet(item.name, body, {
    tools: [toolBtn('edit', t('Изменить'), () => { close(); itemForm(item); })],
  });
}

function itemForm(item) {
  const num = (v) => (Number.isFinite(v) ? fmt.fix(v, v % 1 ? 1 : 0) : '');
  const f = form([
    { name: 'name', label: t('Название'), value: item.name, required: true },
    { name: 'qty', label: t('Сколько'), value: item.qty ?? '', placeholder: t('175 г, 3 шт, 1 ч.л.') },
    { name: 'kcal', label: t('Ккал'), type: 'number', value: num(item.kcal), required: true, min: 0, max: 5000, half: true },
    { name: 'p', label: t('Белки, г'), type: 'number', value: num(item.p), min: 0, max: 500, half: true },
    { name: 'f', label: t('Жиры, г'), type: 'number', value: num(item.f), min: 0, max: 500, half: true },
    { name: 'c', label: t('Углеводы, г'), type: 'number', value: num(item.c), min: 0, max: 500, half: true },
    { name: 'note', label: t('Заметка'), value: item.note ?? '' },
  ]);
  const alts = h('textarea', { rows: 6, placeholder: t('Одна замена — одна строка') });
  alts.value = (item.alts ?? []).join('\n');
  f.el.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Чем заменить')), alts));
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await saveItem({
      id: item.id, name: v.name, qty: v.qty, note: v.note,
      ...Object.fromEntries(KEYS.map((k) => [k, v[k] ?? 0])),
      alts: alts.value.split('\n').map((s) => s.trim()).filter(Boolean),
    });
    toast(t('Сохранено'));
  };
  const close = sheet(item.name, f.el, { actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')] });
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
  return h('button', { type: 'button', class: `row food-row ${item.isDay ? 'day' : ''}`, onclick: () => itemSheet(item) },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, item.name, item.isDay ? h('span', { class: 'food-tag' }, t('продукт дня')) : null),
      item.qty ? h('span', { class: 'muted small' }, item.qty) : null),
    h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(item.kcal)),
      item.alts?.length ? h('span', { class: 'muted small' }, t('замен: {n}', { n: item.alts.length })) : null));
}

function mealBox(meal) {
  const s = totals(meal.items);
  const title = [meal.name, meal.time ? ` · ${meal.time}` : ''].join('');
  return box(withIcon(meal.isPause ? 'calendar' : 'leaf', title), h('div', {},
    h('div', { class: 'rows' }, meal.items.map(foodRow)),
    h('div', { class: 'food-sum' }, h('b', {}, kcal(s.kcal)), h('span', { class: 'muted' }, macros(s))),
    meal.note ? h('p', { class: 'muted small food-note' }, meal.note) : null));
}

function dayPicker(state, day) {
  const list = day.plan.day?.items ?? [];
  if (list.length < 2) return null;
  const cur = day.choice.item.id;
  return h('div', { class: 'food-pick' },
    h('div', { class: 'chips' }, list.map((p) => h('button', {
      type: 'button', class: p.id === cur ? 'on' : '', 'aria-pressed': String(p.id === cur),
      onclick: () => { if (!(day.choice.picked && p.id === cur)) setPick(state, M.today(), p.id); },
    }, p.short || p.name))),
    day.choice.picked ? null : h('p', { class: 'muted small' }, t('Предложено по разам в неделю — нажмите, чтобы выбрать')));
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

/** Вкладка «Раціон». noPlan — порожній екран, коли плану ще нема. */
export function renderRation(state, { noPlan }) {
  const day = today(state);
  if (!day) return h('div', {}, noPlan(), box(withIcon('leaf', t('Питание при диабете')), dietMemo(), { fold: 'diet' }));
  const { plan, choice, pause, meals, sum } = day;
  const win = windowText(plan);
  // У паузу є вечеря — порада про кефір зайва
  if (win && pause.now) win.sub = null;
  const norm = plan.norm;
  return h('div', {},
    h('section', { class: 'hero accent food-hero' },
      h('div', { class: 'hero-label' }, choice ? t('Сегодня: {name}', { name: choice.item.short || choice.item.name }) : t('Сегодня')),
      h('div', { class: 'hero-value' }, fmt.int(sum.kcal), h('span', { class: 'hero-unit' }, t('ккал'))),
      h('div', { class: 'hero-sub' }, macros(sum)),
      choice ? dayPicker(state, day) : null,
      win ? h('div', { class: `food-window ${win.state}` }, icon('bell'), h('span', {}, win.text, win.sub ? h('span', { class: 'muted small' }, win.sub) : null)) : null),
    pauseNote(pause),
    meals.map(mealBox),
    norm ? h('p', { class: 'muted small food-norm' }, t('Норма в среднем за неделю: {k} · {m}', { k: kcal(norm.kcal), m: macros(norm) })) : null,
    (plan.refs ?? []).map((r) => box(withIcon('note', r.title), refText(r.text), {
      fold: `ref:${r.id}`, tools: [toolBtn('edit', t('Изменить'), () => refForm(r))],
    })),
    box(withIcon('leaf', t('Питание при диабете')), dietMemo(), { fold: 'diet' }));
}

/** Рядок на головній: що сьогодні їсти й скільки лишилось вікна — тап веде у «Раціон». */
export function homeLine(state) {
  const day = today(state);
  if (!day) return null;
  const win = windowText(day.plan);
  return h('a', { href: '#ration', class: 'panel food-line' },
    icon('leaf'),
    h('span', { class: 'food-line-main' },
      h('b', {}, day.choice ? `${day.choice.item.short || day.choice.item.name} · ${kcal(day.sum.kcal)}` : kcal(day.sum.kcal)),
      win ? h('span', { class: 'muted small' }, win.text) : null),
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
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
