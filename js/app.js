import * as db from './db.js';
import * as sync from './sync.js';
import * as bot from './bot.js';
import * as BK from './bot-key.js';
import * as M from './model.js';
import {
  h, fmt, sheet, toast, form, btn, toolBtn, confirmSheet, fold, box, foldFrame, unfold, segmented,
  remember, recall, refreshSheets, saveFile, parseNum,
} from './ui.js';
import { t, plural, lang, setLang, LANGS, applyStatic } from './i18n.js';
import { initLock, lockOn, lockDelay, lockAvailable, enableLock, disableLock, setLockDelay, LOCK_DELAYS } from './lock.js';
import { lineChart } from './chart.js';
import { icon, withIcon } from './icons.js';
import { remindTime, setRemindTime, googleCalendarUrl, icsFile } from './remind.js';
import { renderRation, homeLine, noteTags, tickWindow, planOf } from './nutrition.js';
import { weightHint, afterSlip, yesterdayText, weekMarks, periodFood, streakMilestones, journalDay, dayDates, streak, dayOf } from './daylog.js';
import * as party from './celebrate.js';

const $ = (id) => document.getElementById(id);

let state = { weights: [], waists: [], settings: [], tombstones: [] };
let tab = 'home';
let rows = [];
// Дата, яку щойно записали з «Сьогодні»: галочка в картці середнього домалюється один раз
let justSaved = '';
let goal = { id: M.GOAL_ID };
let sum = M.summary([], goal);

function derive() {
  rows = M.series(state.weights);
  // Паузи на підтриманні з раціону: у них лінія плану стоїть, прогноз відсувається, плато мовчить
  goal = { ...M.goalOf(state), pauses: planOf(state)?.pauses ?? [] };
  sum = M.summary(rows, goal);
}

async function refresh() {
  state = await db.loadAll();
  derive();
  render();
  refreshSheets();
  celebrate();
}

/** Пройдені рубежі для святкування: контрольні точки, ціль і середнє вперше нижче сотні. */
function milestones() {
  const avgOn = (date) => rows.find((r) => r.date === date)?.avg ?? null;
  const base = sum.base?.avg ?? null;
  const list = M.checkpoints(rows, goal, sum).filter((c) => c.reached).map((c) => {
    const avg = avgOn(c.reached);
    return { id: `${c.isTarget ? 'target' : 'cp'}:${c.kg}`, kind: c.isTarget ? 'target' : 'cp', kg: c.kg, avg, date: c.reached, lost: base !== null ? base - avg : 0 };
  });
  // «Двозначне» — рубіж, лише якщо середнє колись було від сотні
  const under = rows.find((r) => r.avg !== null && r.avg < 100);
  if (under && rows.some((r) => r.avg !== null && r.avg >= 100)) {
    list.push({ id: 'century', kind: 'century', kg: 100, avg: under.avg, date: under.date, lost: base !== null ? base - under.avg : 0 });
  }
  return [...list, ...streakMilestones(state)];
}

function celebrate() {
  party.check(milestones(), rows.at(-1)?.date ?? null);
}

const kg = (v, d = 1) => `${fmt.fix(v, d)} ${t('кг')}`;
/** Зміна зі знаком: «−0,70 кг». */
const kgd = (v, d = 1) => `${fmt.signed(v, d)} ${t('кг')}`;
const numStr = (v) => (Number.isFinite(v) ? String(v).replace('.', ',') : '');
const findWeight = (date) => state.weights.find((w) => w.id === date);
const appUrl = () => location.href.split('#')[0];

function empty(name, title, text, ...actions) {
  return h('div', { class: 'empty' }, name ? icon(name, 'empty-ico') : null, title ? h('h3', {}, title) : null, h('p', { class: 'muted' }, text),
    actions.length ? h('div', { class: 'btn-col' }, actions) : null);
}

// ---------- скасування ----------

function snapshot(store, ids) {
  return [...new Set(ids)].map((id) => [id, state[store].find((r) => r.id === id) ?? null]);
}

async function restore(store, snap) {
  const put = snap.filter(([, r]) => r).map(([, r]) => { const { updated, ...rest } = r; return rest; });
  const del = snap.filter(([, r]) => !r).map(([id]) => id);
  await db.write({ [store]: { put, del } });
}

function undoToast(message, store, snap) {
  toast(message, { action: t('Отменить'), onAction: () => restore(store, snap) });
}

/** Короткий відгук пальцю після запису; на iPhone вібрації з браузера немає — тоді нічого. */
function buzz() {
  try { navigator.vibrate?.(15); } catch { /* заборонено політикою сторінки */ }
}

// ---------- запис ваги й талії ----------

/** Поле ваги з кнопками ±0,1: на вагах здебільшого міняється лише остання цифра. */
function stepper(input, fallback) {
  const shift = (d) => {
    const cur = parseNum(input.value);
    const base = Number.isFinite(cur) ? cur : fallback;
    if (!Number.isFinite(base)) return;
    input.value = fmt.fix(Math.round((base + d) * 10) / 10);
    input.dispatchEvent(new Event('input'));
  };
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': '−0,1', onclick: () => shift(-0.1) }, '−');
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': '+0,1', onclick: () => shift(0.1) }, '+');
  // Спершу мітка на місці поля: h() перенесе input в обгортку, і replaceWith на ньому вже не спрацює
  const spot = document.createComment('');
  input.replaceWith(spot);
  spot.replaceWith(h('div', { class: 'stepper' }, minus, input, plus));
}

function weightForm(date = M.today()) {
  const existing = findWeight(date);
  const lastKg = rows.at(-1)?.kg;
  const f = form([
    { name: 'kg', label: t('Вес, кг'), type: 'number', value: existing ? fmt.fix(existing.kg) : (lastKg ? fmt.fix(lastKg) : ''), required: true, min: 20, max: 400, big: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: date, required: true },
    { name: 'note', label: t('Заметка'), value: existing?.note ?? '', placeholder: t('что ел, самочувствие…') },
  ]);
  stepper(f.inputs.kg, lastKg);
  const tags = noteTags(state, f.inputs.note);
  if (tags) f.inputs.note.parentElement.after(tags);
  const save = () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    const clash = findWeight(v.date);
    const write = async () => {
      sync.renewOnGesture();
      close();
      const ids = [v.date, ...(existing && existing.id !== v.date ? [existing.id] : [])];
      const snap = snapshot('weights', ids);
      await db.write({
        weights: {
          put: [{ id: v.date, kg: Math.round(v.kg * 100) / 100, note: v.note }],
          del: existing && existing.id !== v.date ? [existing.id] : [],
        },
      });
      buzz();
      undoToast(t('Записано {kg} за {date}', { kg: kg(v.kg), date: fmt.date(v.date) }), 'weights', snap);
    };
    if (clash && clash.id !== existing?.id) {
      confirmSheet(t('Заменить запись?'), t('За {date} уже записано {kg}.', { date: fmt.date(v.date), kg: kg(clash.kg) }), t('Заменить'), write);
    } else write();
  };
  const remove = async () => {
    close();
    const snap = snapshot('weights', [existing.id]);
    await db.write({ weights: { del: [existing.id] } });
    undoToast(t('Запись за {date} удалена', { date: fmt.date(existing.id) }), 'weights', snap);
  };
  const close = sheet(existing ? t('Вес за {date}', { date: fmt.date(date) }) : t('Записать вес'), f.el, {
    tools: existing ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
  if (!existing) setTimeout(() => f.inputs.kg.select(), 250);
}

function waistForm(record) {
  const last = M.waistSeries(state.waists).at(-1);
  const f = form([
    { name: 'cm', label: t('Талия, см'), type: 'number', value: record ? fmt.fix(record.cm) : (last ? fmt.fix(last.cm) : ''), required: true, min: 20, max: 300, big: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: record?.date ?? M.today(), required: true },
  ]);
  stepper(f.inputs.cm, last?.cm);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    const id = M.waistId(v.date);
    const ids = [id, ...(record && record.id !== id ? [record.id] : [])];
    const snap = snapshot('waists', ids);
    sync.renewOnGesture();
    close();
    await db.write({ waists: { put: [{ id, date: v.date, cm: Math.round(v.cm * 10) / 10 }], del: record && record.id !== id ? [record.id] : [] } });
    buzz();
    undoToast(t('Записано {cm} см за {date}', { cm: fmt.fix(v.cm), date: fmt.date(v.date) }), 'waists', snap);
  };
  const remove = async () => {
    close();
    const snap = snapshot('waists', [record.id]);
    await db.write({ waists: { del: [record.id] } });
    undoToast(t('Замер за {date} удалён', { date: fmt.date(record.date) }), 'waists', snap);
  };
  const close = sheet(record ? t('Талия за {date}', { date: fmt.date(record.date) }) : t('Замер талии'), f.el, {
    tools: record ? [toolBtn('delete', t('Удалить'), remove, 'danger')] : [],
    actions: [btn(t('Отмена'), () => close()), btn(t('Сохранить'), save, 'primary')],
  });
}

// ---------- «Сьогодні» ----------

/** Швидкий запис просто на головній: відкрив, поправив останню цифру, зберіг. */
function quickEntry() {
  const lastKg = rows.at(-1)?.kg;
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'big-input', autocomplete: 'off', 'aria-label': t('Вес, кг'), placeholder: t('Вес, кг') });
  input.value = lastKg ? fmt.fix(lastKg) : '';
  const note = h('input', { type: 'text', autocomplete: 'off', placeholder: t('Заметка (необязательно)') });
  const field = h('div', { class: 'quick-kg' }, input);
  const save = async () => {
    const v = parseNum(input.value);
    if (!Number.isFinite(v) || v < 20 || v > 400) { toast(t('Введите вес в килограммах')); input.focus(); return; }
    const date = M.today();
    const snap = snapshot('weights', [date]);
    // Ключ Google сплив — оновлюємо з цього ж дотику, поки браузер дозволяє відкрити вікно входу
    sync.renewOnGesture();
    justSaved = date;
    await db.write({ weights: { put: [{ id: date, kg: Math.round(v * 100) / 100, note: note.value.trim() }] } });
    buzz();
    undoToast(t('Записано {kg} за {date}', { kg: kg(v), date: fmt.date(date) }), 'weights', snap);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const panel = h('section', { class: 'panel quick' },
    h('div', { class: 'quick-head' }, h('h3', {}, withIcon('scale', t('Сегодня ещё не взвешивались'))),
      lastKg ? h('span', { class: 'muted small' }, t('прошлый раз {kg}', { kg: kg(lastKg) })) : null),
    field,
    h('label', { class: 'field' }, note),
    noteTags(state, note),
    h('div', { class: 'btn-row' }, btn(t('Записать'), save, 'primary')));
  stepper(input, lastKg);
  return panel;
}

/** Сьогоднішня вага рядком усередині картки середнього: головне число одне — середнє. */
function todayLine(row) {
  const prev = rows[rows.indexOf(row) - 1];
  const just = justSaved === row.date;
  justSaved = '';
  return h('button', { type: 'button', class: 'today-line', onclick: () => weightForm(row.date) },
    h('span', { class: `today-label${just ? ' just' : ''}` }, icon('check'), t('Сегодня')),
    h('b', { class: 'today-kg' }, kg(row.kg)),
    prev ? h('span', { class: `today-delta ${trendClass(row.day)}` }, t('{d} к {date}', { d: fmt.signed(row.day), date: fmt.short(prev.date) })) : null,
    icon('edit'),
    row.note ? h('span', { class: 'today-note muted small' }, row.note) : null);
}

/** Знижується — добре (зелене), росте — погано: ціль — схуднути. */
function trendClass(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return 'flat';
  return v < 0 ? 'good' : 'bad';
}

function stat(name, label, value, sub, cls = '') {
  return h('div', { class: `stat ${cls}` },
    h('div', { class: 'stat-label' }, icon(name), label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub muted' }, sub) : null);
}

function hero(todayRow) {
  const s = sum;
  if (!s.hasAvg) {
    const left = 7 - (M.daysBetween(rows[0].date, M.today()) + 1);
    return h('section', { class: 'hero' },
      h('div', { class: 'hero-label' }, t('Последний вес')),
      h('div', { class: 'hero-value' }, fmt.fix(s.last.kg), h('span', { class: 'hero-unit' }, t('кг'))),
      h('div', { class: 'hero-sub' }, left > 0
        ? t('Среднее за 7 дней появится через {n} {days}', { n: left, days: plural(left, [t('день'), t('дня'), t('дней')]) })
        : t('Для среднего нужно хотя бы {n} взвешивания за неделю', { n: M.AVG_MIN })),
      todayRow ? todayLine(todayRow) : null);
  }
  const span = s.base && s.target !== null ? s.base.avg - s.target : null;
  const pos = (k) => `${Math.min(100, Math.max(0, ((s.base.avg - k) / span) * 100))}%`;
  return h('section', { class: 'hero accent' },
    h('div', { class: 'hero-label' }, t('Среднее за 7 дней')),
    h('div', { class: 'hero-value' }, fmt.fix(s.current, 2), h('span', { class: 'hero-unit' }, t('кг'))),
    h('div', { class: 'hero-sub' },
      s.lost !== null ? t('{d} кг с начала', { d: fmt.signed(-s.lost, 2) }) : null,
      s.progress !== null ? ` · ${t('{p} % пути', { p: fmt.int(s.progress * 100) })}` : null),
    span > 0 ? h('div', { class: 'goal-track', 'aria-hidden': 'true' },
      h('div', { class: 'goal-bar' },
        h('div', { class: 'goal-fill', style: `width:${pos(s.current)}` }),
        M.checkpoints(rows, goal, s).filter((c) => !c.isTarget).map((c) => h('span', { class: `goal-tick ${c.reached ? 'done' : ''}`, style: `left:${pos(c.kg)}` }))),
      h('div', { class: 'goal-ends' }, h('span', {}, fmt.fix(s.base.avg, 2)), h('span', {}, s.toGo > 0
        ? t('цель {kg} · ещё {d}', { kg: fmt.fix(s.target), d: fmt.fix(s.toGo, 1) })
        : t('цель {kg}', { kg: fmt.fix(s.target) })))) : null,
    todayRow ? todayLine(todayRow) : null);
}

function statsGrid() {
  const s = sum;
  const g = s.goal;
  const tiles = [];
  // «До цілі» — уже в картці середнього (смужка і «ще …»), тут не повторюємо
  if (s.rate !== null) {
    // Крупно — темп за 4 тижні: ним рахується прогноз, і на плато він не хвалить загальним темпом
    const rate = s.recent ?? s.rate;
    const planOk = Number.isFinite(g.planRate) && rate >= g.planRate;
    tiles.push(stat('speed', s.recent !== null ? t('Темп за 4 нед.') : t('Темп'), `${fmt.fix(rate, 2)} ${t('кг/нед')}`,
      [s.recent !== null ? t('с начала {r}', { r: fmt.fix(s.rate, 2) }) : null,
        Number.isFinite(g.planRate) ? t('план {r}', { r: fmt.fix(g.planRate, 2) }) : null].filter(Boolean).join(' · ') || null,
      planOk ? 'good' : rate <= 0 ? 'bad' : ''));
  }
  if (s.weekDelta !== null) tiles.push(stat('trend', t('За неделю'), kgd(s.weekDelta, 2), t('среднее к прошлой неделе'), trendClass(s.weekDelta)));
  if (s.planDiff !== null) {
    tiles.push(stat('route', t('От плана'), kgd(s.planDiff, 2),
      s.planDiff < -0.005 ? t('опережаете') : s.planDiff > 0.005 ? t('отстаёте') : t('точно по плану'), trendClass(s.planDiff)));
  }
  // Дата фінішу з прогнозом — у «Контрольних точках» рядком цілі; плитка лишається для «ціль досягнута» і «не знижується»
  if (s.toGo !== null && s.toGo <= 0) tiles.push(stat('trophy', t('Цель'), t('достигнута'), null, 'good'));
  else if (!s.finish && s.toGo !== null && s.rate !== null) {
    tiles.push(stat('flag', t('Прогноз финиша'), '—', s.recent !== null ? t('за 4 нед. вес не снижается') : t('вес не снижается'), 'bad'));
  }
  // З планом харчування — тиждень за раціоном замість «Днів записано»
  const wk = planOf(state) ? weekMarks(state, M.addDays(M.today(), -6), M.today()) : null;
  if (wk?.marked) {
    const n = streak(state);
    tiles.push(stat('leaf', t('По рациону за 7 дн.'), t('{a} из {b}', { a: wk.ok, b: wk.marked }),
      [wk.slip ? t('срывов: {n}', { n: wk.slip }) : null, n >= 2 ? t('{n} дн. без срыва', { n }) : null].filter(Boolean).join(' · ') || t('за планом'),
      wk.slip ? 'bad' : wk.ok === wk.marked ? 'good' : ''));
  } else {
    tiles.push(stat('calendar-check', t('Дней записано'), fmt.int(s.days), g.startDate ? t('с {date}', { date: fmt.date(g.startDate) }) : null));
  }
  return h('div', { class: 'stats' }, tiles);
}

/** Плашка «Плато»: середнє давно не оновлює мінімум. */
/** Бот відкидає ключ — на головній, а не лише в налаштуваннях: інакше записи тихо не їдуть на інші пристрої. */
function keyNote() {
  if (!bot.keyProblem()) return null;
  return h('section', { class: 'plateau key-note' },
    h('div', { class: 'plateau-head' }, icon('warning'), h('b', {}, t('Ключ доступа не подходит'))),
    h('p', { class: 'small' }, t('Записи не уходят на другие устройства. Возьмите новый ключ командой /key в Telegram-боте и вставьте в любом приложении — Хобі-план, Вага или Марнотрат: остальные на этом устройстве возьмут его сами, другие — с Google Диска.')),
    h('div', { class: 'btn-row' }, btn(t('Вставить ключ'), () => openSettings('data'), 'primary')));
}

function plateauNote() {
  const p = M.plateau(rows, goal.pauses);
  if (!p || (sum.toGo !== null && sum.toGo <= 0)) return null;
  // На виду — що сталося, порада — по тапу
  return h('details', { class: 'plateau' },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon('warning'),
        h('b', {}, t('Плато {n} {days}', { n: p.days, days: plural(p.days, [t('день'), t('дня'), t('дней')]) }))),
      h('p', { class: 'small' }, t('Среднее с {date} не опускается ниже {kg}.', { date: fmt.date(p.since), kg: kg(p.low, 2) }))),
    h('p', { class: 'small' }, plateauAdvice(p)));
}

/** Порада на плато — з позначок раціону за час плато, а без них — загальна. */
function plateauAdvice(p) {
  const general = t('Обычно это вода и соль, а не жир: проверьте порции и сладкое, добавьте шагов — и подождите ещё неделю.');
  if (!planOf(state)) return general;
  const f = periodFood(state, p.since, M.today());
  if (f.marked < f.days / 2) return [t('Отмечено только {n} из {d} дней по рациону — причину по ним не видно.', { n: f.marked, d: f.days }), ' ', general];
  if (f.slip || f.extra > 0) {
    return t('За время плато: срывов {s}, вне плана {k} ккал (≈{kg} кг). Похоже, дело в них — вернитесь к плану.',
      { s: f.slip, k: fmt.int(f.extra), kg: fmt.fix(f.extra / 7700, 2) });
  }
  return t('За время плато всё по плану ({n} из {d} дней) — это вода, не жир. Ничего не урезайте, подождите ещё неделю.', { n: f.ok, d: f.days });
}

/** Тижневі стовпчики з підписом «5/7» — днів за планом із позначених. */
function weekBars() {
  const list = M.weeklyChanges(rows);
  if (!planOf(state)) return list;
  return list.map((b) => {
    const m = weekMarks(state, b.from, b.to);
    return m.marked ? { ...b, tag: `${m.ok}/${m.marked}` } : b;
  });
}

/** Під графіком: тижні без зривів проти тижнів зі зривами — по 2 і більше кожних. */
function weekCompare() {
  if (!planOf(state)) return null;
  const clean = [];
  const slipped = [];
  for (const b of M.weeklyChanges(rows)) {
    const m = weekMarks(state, b.from, b.to);
    if (m.marked < 5) continue;
    (m.slip ? slipped : clean).push(b.v);
  }
  if (clean.length < 2 || slipped.length < 2) return null;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return h('p', { class: 'muted small week-compare' }, icon('leaf'),
    h('span', {}, t('Недели без срывов: {a} кг в среднем, со срывами: {b} кг ({n1} и {n2} нед.)', {
      a: fmt.signed(mean(clean), 2), b: fmt.signed(mean(slipped), 2), n1: clean.length, n2: slipped.length,
    })));
}

function checkpointsBox() {
  const list = M.checkpoints(rows, goal, sum);
  if (!list.length) return null;
  // Пройдену точку можна тапнути — святкування ще раз
  const won = new Map(milestones().map((m) => [m.id, m]));
  const replay = (c) => won.get(`${c.isTarget ? 'target' : 'cp'}:${c.kg}`);
  return box(withIcon('flag', t('Контрольные точки')), h('div', { class: 'rows' }, list.map((c) => h(replay(c) ? 'button' : 'div', {
    class: `row cp ${c.reached ? 'done' : ''}`,
    ...(replay(c) ? { type: 'button', onclick: () => party.play(replay(c)) } : {}),
  },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, kg(c.kg), c.isTarget ? h('span', { class: 'cp-target' }, t('цель')) : null),
      c.note ? h('span', { class: 'muted small' }, c.note) : null),
    h('div', { class: 'row-side' },
      c.reached ? h('span', { class: 'good cp-done' }, icon('check'), fmt.date(c.reached))
        : c.eta ? [h('span', {}, `≈ ${fmt.date(c.eta)}`), h('span', { class: 'muted small' }, weeksText(M.daysBetween(sum.currentDate, c.eta)))]
          : h('span', { class: 'muted' }, '—'))))),
  { tools: [toolBtn('edit', t('Изменить'), () => openSettings('checkpoints'))] });
}

function weeksText(days) {
  if (days < 14) return t('через {n} {d}', { n: days, d: plural(days, [t('день'), t('дня'), t('дней')]) });
  const w = Math.round(days / 7);
  return t('через {n} нед.', { n: w });
}

const BMI_MIN = 15;
const BMI_MAX = 45;

function bmiBox() {
  const b = sum.bmi;
  if (!b) {
    return box(withIcon('person', t('ИМТ')), h('div', {},
      h('p', { class: 'muted small' }, t('Индекс массы тела = вес ÷ рост². Укажите рост — и он будет считаться по среднему весу.')),
      btn(t('Указать рост'), () => openSettings('goal'))));
  }
  const at = (v) => `${((Math.min(BMI_MAX, Math.max(BMI_MIN, v)) - BMI_MIN) / (BMI_MAX - BMI_MIN)) * 100}%`;
  return box(withIcon('person', t('ИМТ')), h('div', { class: 'bmi' },
    h('div', { class: 'bmi-head' }, h('b', { class: 'bmi-value' }, fmt.fix(b.value, 1)), h('span', {}, t(b.label))),
    h('div', { class: 'bmi-scale', 'aria-hidden': 'true' },
      M.BMI_CLASSES.slice(0, -1).map(([v]) => h('span', { class: 'bmi-tick', style: `left:${at(v)}` }, h('i', {}, fmt.fix(v, v % 1 ? 1 : 0)))),
      h('span', { class: 'bmi-mark', style: `left:${at(b.value)}` })),
    b.nextKg ? h('p', { class: 'muted small' }, t('До «{label}» — {kg} ({d})', { label: t(b.nextLabel), kg: kg(b.nextKg), d: fmt.signed(b.nextKg - sum.current, 1) })) : null,
    h('p', { class: 'muted small' }, t('По среднему за 7 дней и росту {h} см. Категории ВОЗ; ИМТ не учитывает мышцы и телосложение.', { h: fmt.int(sum.goal.height) }))));
}

function renderHome() {
  if (!rows.length) {
    // Заголовок і значок уже є у формі запису вище — тут лише підказка
    return h('div', {}, keyNote(), quickEntry(), empty(null, null,
      t('Записывайте вес каждое утро — среднее за 7 дней, темп и прогноз посчитаются сами. Уже вели учёт на другом устройстве — подключите Google Диск в настройках.'),
      btn(withIcon('cloud', t('Подключить Google Диск')), () => openSettings('data'))));
  }
  const todayRow = rows.find((r) => r.date === M.today());
  return h('div', {},
    keyNote(),
    todayRow ? null : quickEntry(),
    hero(todayRow),
    weightHint(state, todayRow),
    plateauNote(),
    homeLine(state),
    statsGrid(),
    checkpointsBox());
}

// ---------- графік ----------

const PERIODS = [['7', 'Неделя'], ['30', 'Месяц'], ['90', '3 месяца'], ['all', 'Всё']];
/** Серії, вимкнені тапом по легенді, — пам'ятаються на пристрої. */
const HIDDEN_KEY = 'weight-log:hidden-series';
function hiddenSeries() {
  try {
    const v = JSON.parse(recall(HIDDEN_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    // До 0.1.12 заливка вимикалась окремо — тепер вона йде за планом
    return [...v.filter((k) => k !== 'gap'), ...(v.includes('plan') ? ['gap'] : [])];
  } catch {
    return [];
  }
}
/** Лінію прогнозу до фінішу, дальшого за стільки днів, не малюємо. */
const FORECAST_MAX_DAYS = 365;
/** Запас праворуч під хвостик прогнозу — частка видимого періоду. */
const FORECAST_PEEK = 0.15;
let period = PERIODS.some(([k]) => k === recall('weight-log:period')) ? recall('weight-log:period') : '90';
let picked = null;
/** Вікно, набране колесом миші; кнопка періоду його скидає. */
let chartView = null;

function dayTip(date) {
  const r = rows.find((x) => x.date === date);
  if (!r) return [];
  const plan = M.planAt(sum.goal, date);
  return [
    `${fmt.date(date)}, ${fmt.weekday(date)}`,
    `${t('Вес')}: ${kg(r.kg)}`,
    r.avg !== null ? `${t('Среднее')}: ${kg(r.avg, 2)}` : null,
    plan !== null ? `${t('План')}: ${kg(plan, 2)}` : null,
    r.note || null,
    yesterdayText(state, date),
  ].filter(Boolean);
}

/** Вибраний день одним рядком під графіком: дата, вага, зміна, середнє, від плану, нотатка й «Змінити». */
function dayLine(date) {
  const r = rows.find((x) => x.date === date);
  if (!r) return null;
  const plan = M.planAt(sum.goal, date);
  return h('div', { class: 'day-line' },
    h('div', { class: 'day-line-main' },
      h('div', { class: 'muted small' }, fmt.dayLong(date)),
      h('div', {}, h('b', { class: 'day-kg' }, kg(r.kg)),
        r.day !== null ? [' ', h('span', { class: `small ${trendClass(r.day)}` }, t('за сутки {d}', { d: fmt.signed(r.day) }))] : null),
      h('div', { class: 'chart-chips' },
        r.avg !== null ? h('span', { class: 'stat-chip' }, t('сред. {v}', { v: fmt.fix(r.avg, 2) })) : null,
        plan !== null && r.avg !== null ? h('span', { class: `stat-chip ${trendClass(r.avg - plan)}` }, t('план {d}', { d: fmt.signed(r.avg - plan, 2) })) : null),
      r.note ? h('div', { class: 'row-note' }, icon('note'), h('span', {}, r.note)) : null),
    toolBtn('edit', t('Изменить'), () => weightForm(date)));
}

/** Рядок над графіком: зміна за видимий період крупно, мінімум і максимум ваги. */
function periodLine(a, b) {
  const st = M.periodStats(rows, a, b);
  if (!st) return [];
  return [
    st.change !== null ? h('span', { class: `chart-change ${trendClass(st.change)}` }, kgd(st.change, Math.abs(st.change) < 1 ? 2 : 1)) : null,
    st.change !== null ? h('span', { class: 'muted small' }, t('за период')) : null,
    h('span', { class: 'muted small chart-range' }, `${t('мин {v}', { v: fmt.fix(st.min) })} · ${t('макс {v}', { v: fmt.fix(st.max) })}`),
  ].filter(Boolean);
}

/** Пігулки над графіком: скільки до цілі й наскільки середнє від плану. */
function chartChips() {
  const last = rows.at(-1);
  const plan = M.planAt(sum.goal, last.date);
  const chips = [
    sum.target !== null ? h('span', { class: 'stat-chip' }, t('цель {kg} · ещё {d}', { kg: fmt.fix(sum.target), d: fmt.fix(Math.max(0, sum.toGo ?? 0), 1) })) : null,
    plan !== null && last.avg !== null ? h('span', { class: `stat-chip ${trendClass(last.avg - plan)}` }, t('от плана {d}', { d: fmt.signed(last.avg - plan, 2) })) : null,
  ].filter(Boolean);
  return chips.length ? h('div', { class: 'chart-chips' }, chips) : null;
}

/** Зміна за кожен день — стовпчики під графіком на «Тиждень», де тижневих було б 1–2. */
function dayBars() {
  return rows.filter((r) => r.day !== null).map((r) => ({ from: r.date, to: r.date, v: r.day }));
}

function renderChart() {
  if (!rows.length) return empty('chart', t('Пока нечего показать'), t('Запишите вес — и здесь появится график.'));
  const seg = segmented(PERIODS.map(([k, l]) => [k, t(l)]), period, (v) => { period = v; chartView = null; remember('weight-log:period', v); render(); });
  const lastDate = rows.at(-1).date;
  const from = period === 'all' ? rows[0].date : M.addDays(lastDate, -(Number(period) - 1));
  const vis = rows.filter((r) => r.date >= from);
  const stats = h('div', { class: 'chart-stats' });
  const showRange = (a, b) => {
    $('subtitle').textContent = `${fmt.date(a)} — ${fmt.date(b)}`;
    stats.replaceChildren(...periodLine(a, b));
  };
  // Прогноз — пунктир від поточного середнього до цілі; фініш далі за рік не малюємо — стиснув би графік
  const finish = sum.finish && M.daysBetween(sum.currentDate, sum.finish) <= FORECAST_MAX_DAYS ? sum.finish : null;
  const forecast = finish ? [{ date: sum.currentDate, v: sum.current }, { date: finish, v: sum.target }] : [];
  // Графік заглядає вперед лише на кілька днів — прогноз видно хвостиком, дані лишаються на всю ширину
  const peek = finish ? Math.min(M.daysBetween(lastDate, finish), Math.max(3, Math.round(M.daysBetween(vis[0].date, lastDate) * FORECAST_PEEK))) : 0;
  const home = [vis[0].date, M.addDays(lastDate, peek)];
  const view = chartView ?? home;
  showRange(...view);
  const g = sum.goal;
  const plan = rows.map((r) => ({ date: r.date, v: M.planAt(g, r.date) })).filter((p) => p.v !== null);
  const marks = M.checkpoints(rows, goal, sum).map((c) => ({ v: c.kg, label: c.isTarget ? t('цель') : fmt.int(c.kg), cls: c.isTarget ? 'target' : 'cp' }));
  const day = picked && rows.some((r) => r.date === picked) ? picked : lastDate;
  const slipped = afterSlip(state);
  const details = h('div', {}, dayLine(day));
  // Заливка між середнім і планом: зелена — середнє нижче плану (випереджаєте), червона — вище
  const planOn = new Map(plan.map((p) => [p.date, p.v]));
  const ahead = rows.filter((r) => r.avg !== null && planOn.has(r.date)).map((r) => ({ date: r.date, a: r.avg, b: planOn.get(r.date) }));
  const st = M.periodStats(rows, vis[0].date, lastDate);
  const lastAvg = rows.at(-1).avg;
  const summary = [
    t('График веса'),
    st?.change != null ? `${t('за период')} ${kgd(st.change)}` : null,
    lastAvg !== null ? t('сред. {v}', { v: fmt.fix(lastAvg, 2) }) : null,
    lastAvg !== null && planOn.has(lastDate) ? t('от плана {d}', { d: fmt.signed(lastAvg - planOn.get(lastDate), 2) }) : null,
  ].filter(Boolean).join(', ');
  const chart = lineChart({
    series: [
      { key: 'gap', kind: 'band', cls: 's-gap', points: ahead },
      { key: 'plan', kind: 'line', cls: 's-plan', points: plan },
      { key: 'kg', kind: 'dots', cls: 's-kg', points: rows.map((r, i) => ({ date: r.date, v: r.kg, ring: Boolean(r.note), last: i === rows.length - 1, cls: slipped.has(r.date) ? 'slip' : null })) },
      { key: 'avg', kind: 'line', cls: 's-avg', points: rows.filter((r) => r.avg !== null).map((r) => ({ date: r.date, v: r.avg })), endLabel: true },
      { key: 'forecast', kind: 'line', cls: 's-forecast', points: forecast, aside: true },
    ],
    height: 260,
    zoom: true,
    view,
    home,
    ahead: peek,
    onView: (a, b) => { chartView = [a, b]; showRange(a, b); },
    resetLabel: t('Сбросить'),
    hlines: marks,
    gap: { of: 'avg', to: 'plan', label: t('план') },
    summary,
    bars: period === '7' ? dayBars() : weekBars(),
    spans: (goal.pauses ?? []).map((p) => ({ from: p.from, to: p.to, label: t('пауза'), cls: 'pause' })),
    barsLabel: period === '7' ? t('сутки') : t('нед.'),
    legend: [
      { label: t('Вес'), kind: 'dot', cls: 's-kg', keys: ['kg'] },
      { label: t('Среднее'), kind: 'line', cls: 's-avg', keys: ['avg'] },
      // Заливка без плану сенсу не має — вмикається й вимикається разом із ним; дата фінішу — в «Контрольних точках»
      plan.length ? { label: t('План'), kind: 'line dash', cls: 's-plan', keys: ['plan', 'gap'] } : null,
      finish ? { label: t('прогноз'), kind: 'line dash', cls: 's-forecast', keys: ['forecast'] } : null,
      vis.some((r) => r.note) ? { label: t('заметка'), kind: 'ring', cls: 's-kg' } : null,
      vis.some((r) => slipped.has(r.date)) ? { label: t('после срыва'), kind: 'dot', cls: 's-kg slip' } : null,
    ].filter(Boolean),
    hidden: hiddenSeries(),
    onHidden: (keys) => remember(HIDDEN_KEY, JSON.stringify(keys)),
    digits: 2,
    selected: day,
    tip: dayTip,
    onPick: (date) => { picked = date; details.replaceChildren(dayLine(date) ?? ''); },
  });
  return h('div', {}, seg,
    h('section', { class: 'panel chart-panel' }, stats, chartChips(), chart, details),
    weekCompare(),
    waistBox(),
    bmiBox());
}

function waistBox() {
  const ws = M.waistSeries(state.waists);
  const add = btn(withIcon('plus', t('Замер талии')), () => waistForm());
  if (!ws.length) {
    return box(withIcon('tape', t('Талия')), h('div', {}, h('p', { class: 'muted small' }, t('Талия уходит вместе с весом — замер раз в неделю, утром, по пупку.')), add));
  }
  const last = ws.at(-1);
  return box(withIcon('tape', t('Талия')), h('div', {},
    h('div', { class: 'waist-head' }, h('b', {}, `${fmt.fix(last.cm)} ${t('см')}`),
      last.change !== null ? h('span', { class: trendClass(last.change) }, t('{d} см с {date}', { d: fmt.signed(last.change), date: fmt.date(ws[0].date) })) : null),
    ws.length > 1 ? lineChart({
      series: [{ key: 'cm', kind: 'line', cls: 's-waist', points: ws.map((w) => ({ date: w.date, v: w.cm })) },
        { key: 'cmd', kind: 'dots', cls: 's-waist', points: ws.map((w) => ({ date: w.date, v: w.cm })) }],
      height: 150,
      tip: (date) => { const w = ws.find((x) => x.date === date); return w ? [fmt.date(date), `${fmt.fix(w.cm)} ${t('см')}`] : []; },
    }) : null,
    add));
}

// ---------- журнал ----------

const LOG_SEGS = [['weight', 'Вес'], ['waist', 'Талия'], ['sizes', 'Размеры'], ['health', 'Здоровье']];
let logSeg = LOG_SEGS.some(([k]) => k === recall('weight-log:log-seg')) ? recall('weight-log:log-seg') : 'weight';

const settingText = (id) => state.settings.find((s) => s.id === id)?.text ?? '';

/** Запис налаштувань одним текстом (розміри, діагнози): так список можна вставити цілком. */
function textForm(id, { title, hint, placeholder, saved, rows = 12 }) {
  const input = h('textarea', { rows, placeholder, autocomplete: 'off' });
  input.value = settingText(id);
  const save = async () => {
    sync.renewOnGesture();
    close();
    const text = input.value.split('\n').map((s) => s.trimEnd()).join('\n').trim();
    await db.write({ settings: { put: [{ id, text }] } });
    toast(saved);
  };
  const close = sheet(title, h('div', { class: 'form' },
    h('label', { class: 'field' }, input, h('small', { class: 'muted' }, hint))), {
    actions: [btn(t('Сохранить'), save, 'primary')],
  });
}

const sizesForm = () => textForm(M.SIZES_ID, {
  title: t('Мои размеры'),
  hint: t('Строка — один размер: название, потом значение. Можно вставить список целиком.'),
  placeholder: t('Перчатки L\nОбувь 43/44, стелька 28,5 см\nГолова 59 см'),
  saved: t('Размеры сохранены'),
});

const healthForm = () => textForm(M.HEALTH_ID, {
  title: t('Здоровье'),
  hint: t('Диагнозы, операции, уколы — как удобно. Строка с 🔹 или двоеточием в конце станет заголовком.'),
  placeholder: t('🔹 Позвоночник:\nГрыжа L5–S1\nОперация 2010\n\nДиабет 2 типа'),
  saved: t('Сохранено'),
  rows: 16,
});

/** Текст діагнозів як є: рядки з 🔹 чи двокрапкою в кінці — заголовки, порожній рядок — відступ. */
function renderHealth(seg) {
  const lines = settingText(M.HEALTH_ID).split('\n');
  $('subtitle').textContent = '';
  if (!lines.some((l) => l.trim())) {
    return h('div', {}, seg, empty('heart', t('Записей нет'),
      t('Диагнозы, операции, хронические болячки — чтобы были под рукой у врача.'),
      btn(withIcon('plus', t('Записать')), healthForm)));
  }
  return h('div', {}, seg, h('button', { type: 'button', class: 'panel health', onclick: healthForm },
    lines.map((l) => {
      const s = l.trim();
      if (!s) return h('div', { class: 'health-gap' });
      return /^🔹|:$/u.test(s) ? h('h4', {}, s.replace(/^🔹\s*/u, '')) : h('p', {}, s);
    })));
}

function renderSizes(seg) {
  const list = M.parseSizes(settingText(M.SIZES_ID));
  $('subtitle').textContent = t('размеров: {n}', { n: list.length });
  if (!list.length) {
    return h('div', {}, seg, empty('tape', t('Размеров нет'),
      t('Перчатки, обувь, одежда, кольцо — чтобы всегда были под рукой в магазине.'),
      btn(withIcon('plus', t('Указать размеры')), sizesForm)));
  }
  // Довге значення — під назвою на всю ширину, а не притиснуте вправо в кілька рядків
  return h('div', {}, seg, h('div', { class: 'rows sizes' }, list.map((s) => h('button', { type: 'button', class: `row log-row ${s.value?.length > 16 ? 'stacked' : ''}`, onclick: sizesForm },
    h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, s.label)),
    s.value ? h('div', { class: 'row-side' }, h('span', { class: 'size-value' }, s.value)) : null))));
}

/** Підсумок місяця за раціоном для заголовка: «✓ 18 · ✕ 2». */
function monthFood(list) {
  const marks = list.map((r) => dayOf(state, r.date)?.status).filter(Boolean);
  if (!marks.length) return null;
  const n = (k) => marks.filter((x) => x === k).length;
  return t('по плану {ok} · срывов {slip}', { ok: n('ok'), slip: n('slip') });
}

/** День у «Журналі»: зважування (чи «без зважування») і під ним — як минув день за раціоном. */
function weightRow(r) {
  const weighed = r.kg !== null;
  const food = journalDay(state, r.date);
  return h('div', { class: `log-day ${food ? 'has-food' : ''}` },
    h('button', { type: 'button', class: 'row log-row', onclick: () => weightForm(r.date) },
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, fmt.short(r.date), h('span', { class: 'muted' }, ` · ${fmt.weekday(r.date)}`)),
        weighed ? h('span', { class: 'muted small' }, [
          r.avg !== null ? t('сред. {v}', { v: fmt.fix(r.avg, 2) }) : null,
          r.delta !== null ? t('нед. {v}', { v: fmt.signed(r.delta, 2) }) : null,
        ].filter(Boolean).join(' · ')) : null,
        r.note ? h('span', { class: 'row-note' }, icon('note'), h('span', {}, r.note)) : null),
      h('div', { class: 'row-side' },
        weighed ? h('span', { class: 'row-kg' }, fmt.fix(r.kg)) : h('span', { class: 'muted small' }, t('без взвешивания')),
        weighed && r.day !== null ? h('span', { class: `small ${trendClass(r.day)}` }, fmt.signed(r.day)) : null)),
    food);
}

function renderLog() {
  const seg = segmented(LOG_SEGS.map(([k, l]) => [k, t(l)]), logSeg, (v) => { logSeg = v; remember('weight-log:log-seg', v); render(); });
  if (logSeg === 'sizes') return renderSizes(seg);
  if (logSeg === 'health') return renderHealth(seg);
  if (logSeg === 'waist') {
    const ws = M.waistSeries(state.waists).reverse();
    $('subtitle').textContent = t('замеров: {n}', { n: ws.length });
    return h('div', {}, seg, ws.length
      ? h('div', { class: 'rows' }, ws.map((w) => h('button', { type: 'button', class: 'row log-row', onclick: () => waistForm(state.waists.find((x) => x.id === w.id)) },
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, fmt.date(w.date))),
        h('div', { class: 'row-side' }, h('span', { class: 'row-kg' }, `${fmt.fix(w.cm)} ${t('см')}`),
          w.prev !== null ? h('span', { class: `small ${trendClass(w.prev)}` }, fmt.signed(w.prev)) : null))))
      : empty('tape', t('Замеров нет'), t('Нажмите «+», чтобы записать обхват талии.')));
  }
  $('subtitle').textContent = t('записей: {n}', { n: rows.length });
  if (!rows.length) return h('div', {}, seg, empty('journal', t('Журнал пуст'), t('Нажмите «+», чтобы записать вес.')));
  // Дні з позначкою раціону, але без зважування — теж у журналі (з першого зважування й до сьогодні)
  const weighedDates = new Set(rows.map((r) => r.date));
  const extra = dayDates(state).filter((d) => !weighedDates.has(d) && d >= rows[0].date && d <= M.today())
    .map((date) => ({ date, kg: null, note: '' }));
  const entries = [...rows, ...extra].sort((a, b) => (a.date < b.date ? -1 : 1));
  const months = new Map();
  for (const r of entries.reverse()) {
    const ym = r.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym).push(r);
  }
  // Новий місяць розгортається сам один раз — далі пам'ятається, як його лишили
  const latest = months.keys().next().value;
  if (recall('weight-log:log-month') !== latest) {
    unfold(`log:${latest}`);
    remember('weight-log:log-month', latest);
  }
  return h('div', {}, seg, [...months].map(([ym, list]) => {
    const ws = list.filter((r) => r.kg !== null);
    const avg = ws.length ? ws.reduce((s, r) => s + r.kg, 0) / ws.length : null;
    const change = ws.length > 1 ? ws[0].kg - ws.at(-1).kg : null;
    return fold(`log:${ym}`, [
      h('span', { class: 'fold-stack' }, h('span', { class: 'fold-title' }, fmt.month(ym)),
        h('span', { class: 'fold-meta' }, [
          avg !== null ? t('{n} взв. · сред. {v}', { n: ws.length, v: fmt.fix(avg, 1) }) : null,
          monthFood(list),
        ].filter(Boolean).join(' · '))),
      change !== null ? h('span', { class: `fold-sum ${trendClass(change)}` }, fmt.signed(change)) : null,
    ], () => h('div', { class: 'rows' }, list.map(weightRow)));
  }));
}

// ---------- налаштування ----------

async function saveGoal(patch) {
  const { pauses, ...g } = goal;
  await db.write({ settings: { put: [{ ...g, ...patch, id: M.GOAL_ID }] } });
}

function goalPanel() {
  const g = M.effectiveGoal(goal, rows);
  const f = form([
    { name: 'start', label: t('Стартовый вес, кг'), type: 'number', value: numStr(g.start), half: true, min: 20, max: 400 },
    { name: 'startDate', label: t('Дата старта'), type: 'dmy', value: g.startDate ?? '', half: true },
    { name: 'target', label: t('Цель, кг'), type: 'number', value: numStr(g.target), half: true, min: 20, max: 400 },
    { name: 'planRate', label: t('План, кг/нед'), type: 'number', value: numStr(g.planRate), half: true, min: 0, max: 3 },
    { name: 'height', label: t('Рост, см (для ИМТ)'), type: 'number', value: numStr(g.height), min: 100, max: 250 },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Проверьте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    await saveGoal({ start: v.start ?? undefined, startDate: v.startDate || undefined, target: v.target ?? undefined, planRate: v.planRate ?? undefined, height: v.height ?? undefined });
    toast(t('Цель сохранена'));
  };
  return h('section', { class: 'panel' },
    h('p', { class: 'muted small' }, t('План — линия на графике: от стартового веса ровно по «кг/нед». Без стартового веса берётся первое взвешивание.')),
    f.el, h('div', { class: 'btn-row' }, btn(t('Сохранить'), save, 'primary')));
}

function checkpointsPanel() {
  const list = [...(goal.checkpoints ?? [])].sort((a, b) => b.kg - a.kg);
  const kgInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: t('кг'), autocomplete: 'off', class: 'cp-kg' });
  const noteInput = h('input', { type: 'text', placeholder: t('что значит (необязательно)'), autocomplete: 'off' });
  const add = async () => {
    const v = parseNum(kgInput.value);
    if (!Number.isFinite(v) || v < 20 || v > 400) { toast(t('Введите вес в килограммах')); return; }
    await saveGoal({ checkpoints: [...(goal.checkpoints ?? []), { id: db.uid(), kg: v, note: noteInput.value.trim() }] });
  };
  const remove = (c) => saveGoal({ checkpoints: (goal.checkpoints ?? []).filter((x) => x.id !== c.id) });
  return h('section', { class: 'panel' },
    h('p', { class: 'muted small' }, t('Промежуточные веса на пути к цели: для каждой — прогнозная дата по фактическому темпу. Сама цель добавляется в список автоматически.')),
    list.length ? h('div', { class: 'rows cp-list' }, list.map((c) => h('div', { class: 'row' },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, kg(c.kg)), c.note ? h('span', { class: 'muted small' }, c.note) : null),
      toolBtn('delete', t('Удалить'), () => remove(c), 'danger')))) : null,
    h('div', { class: 'cp-add' }, kgInput, noteInput, btn(t('Добавить'), add)));
}

function remindPanel() {
  const time = h('input', {
    type: 'time', value: remindTime(), class: 'time-input',
    onchange: (e) => { setRemindTime(e.target.value); bot.scheduleBot(500); },
  });
  const connected = Boolean(bot.botConfig().from);
  return h('section', { class: 'panel' },
    h('p', { class: 'muted small' }, t('Пока вес за сегодня не записан, на главной сверху стоит поле записи и горит точка на вкладке. Чтобы телефон сам напомнил в нужный час, нужен Telegram-бот или событие в календаре.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Время')), time),
    h('h4', { class: 'sub-head' }, withIcon('bell', 'Telegram')),
    connected
      ? segmented([['on', t('Напоминать')], ['off', t('Не напоминать')]], bot.remindOn() ? 'on' : 'off',
        (v) => { bot.setRemindOn(v === 'on'); bot.scheduleBot(300); })
      : h('p', { class: 'muted small' }, t('Синхронизация не включена — это в группе «Данные» ниже.')),
    connected && planOf(state) ? dayAskPanel() : null,
    fold('remind-calendar', withIcon('calendar', t('Календарь телефона')), h('div', {},
      h('p', { class: 'muted small' }, t('Запасной вариант без бота: ежедневное событие «Взвеситься» с уведомлением — будит телефон сам календарь.')),
      h('div', { class: 'btn-row' },
        btn(withIcon('calendar', t('Google Календарь')), () => { setRemindTime(time.value); window.open(googleCalendarUrl(remindTime(), appUrl()), '_blank', 'noopener'); }),
        btn(withIcon('download', t('Файл .ics')), () => { setRemindTime(time.value); saveFile(icsFile(remindTime(), appUrl()), true); })),
      h('p', { class: 'muted small' }, t('В Google Календаре проверьте, что у события включено уведомление «в момент начала». Файл .ics открывают календари Samsung, iPhone и Outlook.')))));
}

/** Вечірнє «Як день за раціоном?» у Telegram: кнопки «За планом / Трохи не так / Зрив». */
function dayAskPanel() {
  const at = bot.dayAskTime();
  const time = h('input', {
    type: 'time', value: at ?? bot.DAY_ASK_DEFAULT, class: 'time-input', disabled: !at,
    onchange: (e) => { if (e.target.value) { bot.setDayAskTime(e.target.value); bot.scheduleBot(500); } },
  });
  return h('div', {},
    h('h4', { class: 'sub-head' }, withIcon('leaf', t('Вопрос о рационе'))),
    h('p', { class: 'muted small' }, t('Вечером бот спросит, как прошёл день: три кнопки, при срыве — причина. Отметка ляжет в «Рацион». Если день уже отмечен — не спросит.')),
    segmented([['on', t('Спрашивать')], ['off', t('Не спрашивать')]], at ? 'on' : 'off', (v) => {
      bot.setDayAskTime(v === 'on' ? (time.value || bot.DAY_ASK_DEFAULT) : null);
      time.disabled = v !== 'on';
      bot.scheduleBot(300);
    }),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Во сколько')), time));
}

// ---------- Telegram-бот ----------

let botError = '';

/** Синхронізація; нова вага з бази (з Telegram чи з іншого пристрою) — коротке повідомлення. Без мережі тихо: спробуємо наступного разу. */
async function runBot() {
  try {
    const { got } = await bot.syncBot();
    botError = '';
    if (got?.length === 1) toast(t('Новое взвешивание: {kg} за {date}', { kg: kg(got[0].kg), date: fmt.date(got[0].date) }));
    else if (got?.length) toast(t('Новых взвешиваний: {n}', { n: got.length }));
  } catch (err) {
    // fetch без мережі падає з «Failed to fetch» — людині зрозуміліше своїми словами
    botError = err.message === 'key' || err.message.startsWith('HTTP') ? err.message : t('сеть недоступна');
  }
  renderSyncChip();
  // Статус у налаштуваннях — свіжий, але не під пальцями, що саме вводять адресу чи ключ
  if (tab === 'settings' && !document.activeElement?.matches('input')) render();
}

function botStatus(cfg) {
  if (bot.keyProblem()) return t('Ключ доступа не подходит — возьмите новый командой /key в Telegram-боте и вставьте ниже.');
  if (!cfg.from) return t('Не включена. Вставьте адрес сервера и ключ доступа ниже — или включите синхронизацию в Хобі-плане на этом устройстве, она подхватится сама.');
  if (botError === 'key') return t('Ключ доступа не подходит — возьмите новый командой /key в Telegram-боте и вставьте ниже.');
  if (botError) return t('Нет связи с сервером: {e}', { e: botError });
  return t('Обмен: {time}', { time: syncTime(bot.lastSync()) });
}

/** «Синхронізація»: стан обміну, адреса й ключ (спільні для застосунків на пристрої), обмін і від'єднання. */
function botPanel() {
  const cfg = bot.botConfig();
  const f = form([
    { name: 'url', label: t('Адрес сервера'), value: cfg.url, placeholder: 'https://….workers.dev' },
    { name: 'key', label: t('Ключ доступа'), type: 'password', value: cfg.key },
  ]);
  const save = async () => {
    const v = f.values();
    if (!v.url.startsWith('https://') || !v.key) { toast(t('Укажите адрес https://… и ключ')); return; }
    bot.setBotConfig(v.url, v.key);
    sync.botChanged();
    await runBot();
    render();
    toast(botError ? botStatus(bot.botConfig()) : t('Синхронизация включена'));
  };
  const exchange = async () => {
    await runBot();
    render();
    if (!botError) toast(t('Обмен прошёл'));
  };
  const bad = Boolean(botError) || bot.keyProblem();
  return h('section', { class: 'panel' },
    h('h3', {}, withIcon('sync', t('Синхронизация'))),
    h('p', { class: `small ${bad ? 'error-text' : 'muted'}` }, botStatus(cfg)),
    h('p', { class: 'muted small' }, t('Весь журнал (вес, талия, настройки) лежит в общей базе на сервере — одинаковый на всех устройствах; без интернета всё уйдёт позже. Эту же базу читает Telegram-бот: напоминает взвеситься и принимает вес сообщением. Ключ доступа даёт команда /key в боте; достаточно вставить в одном приложении — Хобі-план, Вага или Марнотрат.')),
    f.el,
    h('div', { class: 'btn-row' },
      btn(t('Сохранить'), save, cfg.from ? '' : 'primary'),
      cfg.from ? btn(withIcon('sync', t('Обменяться сейчас')), exchange, 'primary') : null,
      cfg.from ? btn(t('Выключить синхронизацию'), () => { bot.setBotConfig('', ''); botError = ''; render(); }) : null));
}

const CHIP = {
  idle: () => `✓ ${fmt.time(sync.status.lastSync)}`,
  syncing: () => '…',
  offline: () => t('офлайн'),
  auth: () => t('войти'),
  error: () => t('ошибка'),
};

/** Аватар Google-акаунта; без фото чи без мережі — іконка хмари. */
function avatar(photo, cls = '') {
  if (!photo) return icon('cloud');
  return h('img', {
    class: `avatar ${cls}`, alt: '', referrerpolicy: 'no-referrer',
    src: photo.replace(/=s\d+(-c)?$/, '=s96-c'),
    onerror: (e) => e.target.replaceWith(icon('cloud')),
  });
}

/**
 * Значок у шапці — основна синхронізація: база на сервері, а без неї — Google Диск. Стани й вигляд — як у Хобі-плані
 * й Марнотраті: idle «✓ час», syncing, offline, key (ключ не підходить), error.
 */
function chipState() {
  if (bot.keyProblem() || botError === 'key') return { st: 'key', text: t('ключ'), title: t('Ключ доступа не подходит') };
  if (bot.botConfig().from) {
    if (!navigator.onLine) return { st: 'offline', text: t('офлайн'), title: t('Нет интернета — синхронизация произойдёт, когда появится связь') };
    if (botError) return { st: 'error', text: t('ошибка'), title: t('Нет связи с сервером: {e}', { e: botError }) };
    const at = bot.lastSync();
    if (!at) return { st: 'syncing', text: '…', title: t('Синхронизация') };
    return { st: 'idle', text: `✓ ${fmt.time(at)}`, title: t('Обмен: {time}', { time: syncTime(at) }) };
  }
  const s = sync.status;
  if (!CHIP[s.state]) return null;
  return { st: s.state, text: CHIP[s.state](), title: s.message || t('Синхронизация с Google Диском'), drive: true, photo: s.photo };
}

function renderSyncChip() {
  const chip = $('sync-chip');
  const s = chipState();
  chip.hidden = !s;
  if (!s) return;
  chip.replaceChildren(s.drive ? avatar(s.photo) : icon(s.st === 'key' ? 'warning' : 'sync'), s.text);
  chip.className = `sync-chip ${s.st}`;
  chip.title = s.title;
}

function onSyncChip() {
  const s = chipState();
  if (s?.st === 'key') { openSettings('data'); return; }
  if (s?.st === 'offline') { toast(t('Нет интернета — синхронизация произойдёт, когда появится связь')); return; }
  if (bot.botConfig().from) {
    runBot().then(() => toast(botError ? chipState()?.title ?? botError : t('Обмен прошёл')));
    return;
  }
  const { state: st, message } = sync.status;
  if (st === 'auth') connectGoogle();
  else if (st === 'offline') toast(t('Нет интернета — синхронизация произойдёт, когда появится связь'));
  else if (st === 'error') { toast(message || t('Ошибка синхронизации')); sync.syncNow({ force: true }); } else sync.syncNow({ force: true });
  runBot();
}

function syncTime(ms) {
  if (!ms) return t('ещё не было');
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? t('сегодня в {time}', { time: fmt.time(ms) })
    : `${fmt.date(new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10))} ${fmt.time(ms)}`;
}

function connectGoogle() {
  sync.connect().then(() => toast(t('Google Диск подключён'))).catch((err) => toast(err.message));
}

/** «Google Диск»: з ботом — щоденна копія, без бота — синхронізація між пристроями. */
function drivePanel() {
  const s = sync.status;
  const daily = Boolean(bot.botConfig().from);
  const panel = h('section', { class: 'panel' }, h('h3', {}, withIcon('cloud', daily ? t('Google Диск · ежедневная копия') : t('Google Диск · синхронизация'))));
  if (!sync.configured()) {
    panel.append(h('p', { class: 'muted small' }, t('Не настроена: в js/config.js не указан Google Client ID.')));
  } else if (!sync.enabled()) {
    panel.append(
      h('p', { class: 'muted small' }, t('Копия журнала — файл weight-log.json на вашем Google Диске; там же адрес сервера и ключ доступа для других устройств. Приложение видит только свои файлы.')),
      h('div', { class: 'btn-row' }, btn(withIcon('cloud', t('Подключить Google Диск')), connectGoogle, 'primary')));
  } else {
    const restore = async () => {
      try {
        const parsed = await sync.fetchBackup();
        if (!parsed) { toast(t('На Диске ещё нет копии')); return; }
        importParsed(parsed, t('Копия с Google Диска'));
      } catch (err) { toast(err.message); }
    };
    panel.append(
      h('div', { class: 'account' }, avatar(s.photo, 'big'),
        h('div', { class: 'account-text' }, h('b', {}, s.name ?? s.email ?? '—'), s.name && s.email ? h('span', { class: 'muted small' }, s.email) : null)),
      h('p', { class: `small ${s.state === 'error' ? 'error-text' : 'muted'}` },
        s.message || t('Последняя копия: {time}', { time: syncTime(s.lastSync) })),
      h('div', { class: 'btn-row' },
        s.state === 'auth' ? btn(t('Войти в Google'), connectGoogle, 'primary') : btn(withIcon('sync', t('Сохранить сейчас')), () => sync.syncNow({ force: true }), 'primary'),
        btn(withIcon('download', t('Восстановить с Диска')), restore),
        btn(t('Отключить'), () => confirmSheet(t('Отключить Google Диск?'), t('Копия на Диске останется, просто перестанет обновляться. Вход в Google в других приложениях не тронем.'), t('Отключить'), () => sync.disconnect()))));
  }
  return panel;
}

/** «Вхід за відбитком»: увімкнути, через скільки блокувати у фоні, вимкнути з підтвердженням. */
function lockPanel() {
  const body = h('div', {});
  const act = (fn, done) => async () => {
    try {
      await fn();
      toast(done);
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast(t('Ошибка: {msg}', { msg: err?.message || String(err) }));
    }
    render();
  };
  if (lockOn()) {
    body.append(
      h('p', { class: 'muted small' }, t('Блокировать после сворачивания:')),
      segmented(LOCK_DELAYS.map((m) => [String(m), m ? t('{n} мин', { n: m }) : t('Сразу')]), String(lockDelay()), (v) => setLockDelay(Number(v))),
      h('div', { class: 'btn-row' }, btn(t('Выключить'), act(disableLock, t('Вход по отпечатку выключен')))));
  } else {
    lockAvailable().then((ok) => body.append(ok
      ? h('div', { class: 'btn-row' }, btn(t('Включить'), act(enableLock, t('Вход по отпечатку включён')), 'primary'))
      : h('p', { class: 'muted small' }, t('На этом устройстве нет отпечатка, лица или PIN-кода, которые браузер может проверить.'))));
  }
  return h('section', { class: 'panel' }, h('h3', {}, t('Вход по отпечатку')),
    h('p', { class: 'muted small' }, t('Приложение открывается отпечатком, лицом или PIN-кодом телефона — только на этом устройстве. Это защита от чужих глаз, данные не шифруются.')),
    body);
}

/** «Копія у файл»: зберегти (на телефоні — «Поділитися», на комп'ютері — завантажити) і відновити. */
function filePanel() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; } });
  return h('section', { class: 'panel' },
    h('h3', {}, withIcon('archive', t('Копия в файл'))),
    h('p', { class: 'muted small' }, t('Взвешиваний: {w} · замеров талии: {c}', { w: state.weights.length, c: state.waists.length })),
    h('div', { class: 'btn-row' },
      btn(withIcon('download', t('Сохранить копию')), () => exportData(true)),
      btn(withIcon('upload', t('Восстановить из файла')), () => input.click())),
    input);
}

async function exportData(share) {
  const payload = JSON.stringify({ app: 'weight-log', format: 1, exportedAt: new Date().toISOString(), data: state }, null, 1);
  const name = `weight-log-${M.today()}.json`;
  await saveFile(new File([payload], name, { type: 'application/json' }), share);
}

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importBackup(file) {
  let parsed;
  try { parsed = JSON.parse(await readText(file)); } catch { toast(t('Файл не похож на JSON')); return; }
  importParsed(parsed, t('Импорт копии'));
}

/** Копія (з файлу чи з Диска): «Объединить» або «Заменить всё». */
function importParsed(parsed, title) {
  const data = parsed?.data;
  if (parsed?.app !== 'weight-log' || !data || !db.STORES.every((s) => !data[s] || Array.isArray(data[s]))) {
    toast(t('Это не резервная копия Weight Log'));
    return;
  }
  const count = db.STORES.reduce((s, k) => s + (data[k]?.length ?? 0), 0);
  const changes = Object.fromEntries(db.STORES.map((s) => [s, { put: (data[s] ?? []).filter((x) => x && x.id) }]));
  const close = sheet(title, h('div', {},
    h('p', {}, t('В файле {n} записей.', { n: count })),
    h('p', { class: 'muted small' }, t('«Объединить» — добавит новые записи и обновит те, что в файле новее: более поздние правки на устройстве останутся. «Заменить всё» — сначала удалит текущие данные.')),
    sync.enabled() || bot.botConfig().from ? h('p', { class: 'muted small' }, t('«Заменить всё» заменит данные и на других устройствах. «Объединить» не откатит более новые правки с них.')) : null), {
    actions: [
      btn(t('Отмена'), () => close()),
      btn(t('Объединить'), async () => { close(); await db.mergeImport(changes); bot.rewindPushed(); toast(t('Импортировано')); }, 'primary'),
      btn(t('Заменить всё'), () => {
        close();
        confirmSheet(t('Заменить все данные?'), t('Текущие данные будут удалены. Сначала сохраните копию, если они нужны.'), t('Заменить'), async () => {
          const at = await db.replaceAll(changes);
          sync.markRestore(at);
          bot.markRestore(at);
          toast(t('Данные заменены'));
        });
      }, 'danger'),
    ],
  });
}

// Тема: auto — як у системі. Першу розстановку до малювання робить скрипт в index.html.
const THEMES = [['auto', 'Авто'], ['dark', 'Тёмная'], ['light', 'Светлая']];
const lightScheme = matchMedia('(prefers-color-scheme: light)');

function themePref() {
  const v = recall('weight-log:theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}

function applyTheme() {
  const pref = themePref();
  const theme = pref === 'auto' ? (lightScheme.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f1f4f9' : '#0c111a');
}

lightScheme.addEventListener('change', applyTheme);

function switchLang(code) {
  setLang(code);
  applyStatic();
  renderSyncChip();
  render();
}

/** «Про застосунок», як у shooting-log: аватар автора, що це таке, де дані, з чого почати. */
function aboutPanel() {
  const more = (title, node) => h('details', { class: 'about-more' }, h('summary', {}, title), node);
  return h('section', { class: 'panel about' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-avatar', src: './icons/author.jpg', alt: '', width: 64, height: 64, loading: 'lazy' }),
      h('div', {},
        h('p', { class: 'muted small' }, t('Weight Log — ежедневный вес, среднее за 7 дней, темп и прогноз цели. Работает без интернета: всё считается на устройстве.')))),
    more(t('Где мои данные'), h('div', { class: 'muted small' },
      h('p', {}, t('Записи лежат в браузере на этом устройстве. Сервера у приложения нет, автор не получает ни данных, ни статистики.')),
      h('p', {}, t('Google Диск подключается по желанию: копия ложится в файл weight-log.json на вашем Диске, приложение видит только свои файлы.')),
      h('p', {}, t('Резервная копия — «Поделиться копией» ниже. Она же переносит данные на другое устройство через «Импорт копии».')))),
    more(t('С чего начать'), h('ol', { class: 'about-steps' },
      h('li', {}, t('Задайте цель: стартовый вес, целевой и план, кг в неделю.')),
      h('li', {}, t('Взвешивайтесь каждое утро и записывайте вес на главной — поле само предложит прошлое значение.')),
      h('li', {}, t('Подключите Google Диск — записи будут одинаковыми на телефоне и компьютере.')),
      h('li', {}, t('Включите напоминание — Telegram-бот или событие в календаре, чтобы не пропускать дни.')))),
    h('p', { class: 'muted small' },
      h('a', { href: 'https://github.com/VitaliyLobko/weight-log', target: '_blank', rel: 'noopener' }, t('Исходный код'))),
    h('p', { class: 'muted small' }, t('Хрюк — '),
      h('a', { href: 'https://freesound.org/people/Erdie/sounds/44274/', target: '_blank', rel: 'noopener' }, '«Pig grunt», erdie'),
      ', ', h('a', { href: 'https://creativecommons.org/licenses/by/3.0/', target: '_blank', rel: 'noopener' }, 'CC BY 3.0')));
}

function renderSettings() {
  $('subtitle').textContent = t('версия {v}', { v: self.APP_VERSION });
  return h('div', {},
    settingsGroup(t('О приложении'), [aboutPanel(),
      h('section', { class: 'panel' },
        h('h3', {}, withIcon('phone', t('Установка на телефон'))),
        h('p', { class: 'muted small' }, t('Chrome → меню ⋮ → «Добавить на главный экран» / «Установить приложение». После установки работает без интернета.')))]),
    settingsGroup(withIcon('target', t('Цель')), [goalPanel()], { fold: 'goal' }),
    settingsGroup(withIcon('flag', t('Контрольные точки')), [checkpointsPanel()], { fold: 'checkpoints' }),
    settingsGroup(withIcon('bell', t('Напоминание')), [remindPanel()], { fold: 'remind' }),
    settingsGroup(withIcon('cloud', t('Данные')), [botPanel(), drivePanel(), lockPanel(), filePanel()], { fold: 'data' }),
    settingsGroup(withIcon('theme', t('Внешний вид')), [
      h('section', { class: 'panel' }, h('h3', {}, withIcon('globe', 'Язык · Мова')), segmented(Object.entries(LANGS), lang(), switchLang)),
      h('section', { class: 'panel' }, h('h3', {}, withIcon('theme', t('Тема'))),
        segmented(THEMES.map(([k, label]) => [k, t(label)]), themePref(), (v) => { remember('weight-log:theme', v); applyTheme(); }))], { fold: 'look' }),
    settingsGroup(t('Опасная зона'), [h('section', { class: 'panel' },
      btn(t('Удалить данные с устройства'), () => confirmSheet(t('Удалить данные с устройства?'), sync.enabled()
        ? t('Данные будут удалены с этого устройства. Копия на Google Диске останется и вернётся при следующей синхронизации — чтобы этого не было, сначала отключите синхронизацию.')
        : t('Все взвешивания, замеры и цель будут удалены с этого устройства. Отменить нельзя.'), t('Удалить'), async () => {
        await db.clearAll(); await refresh(); toast(t('Данные удалены'));
      }), 'danger'))], { danger: true }));
}

/**
 * Група налаштувань, як у Стрілецькому журналі: рамка з назвою на лінії, розділи всередині — через лінію.
 * fold — ключ: група згортається тапом по назві й пам'ятає, чи розгорнута.
 */
function settingsGroup(title, sections, { danger = false, fold: key } = {}) {
  const cls = `settings-group${danger ? ' danger' : ''}`;
  if (key) return foldFrame(cls, `settings:${key}`, title, sections.filter(Boolean));
  return h('fieldset', { class: cls }, h('legend', {}, title), sections.filter(Boolean));
}

/** Перейти в налаштування з уже розгорнутою групою key. */
function openSettings(key) {
  unfold(`settings:${key}`);
  location.hash = '#settings';
}

// ---------- навігація ----------

const VIEWS = {
  // Сьогоднішня вага пишеться формою вгорі головної, за інший день — у «Журналі»; «+» тут лише перекривав блоки
  home: { title: 'Вес', render: renderHome },
  // На графіку «+» перекривав блок талії, а запис дня там і так є — олівцем під графіком
  chart: { title: 'График', render: renderChart },
  ration: {
    title: 'Рацион',
    render: () => renderRation(state, {
      render,
      noPlan: () => empty('leaf', t('Плана питания пока нет'),
        t('Загрузите файл с планом: Данные → Копия в файл → Восстановить из файла → Объединить.'),
        btn(withIcon('upload', t('Открыть «Данные»')), () => openSettings('data'))),
    }),
  },
  log: { title: 'Журнал', render: renderLog, fab: () => ({ waist: waistForm, sizes: sizesForm, health: healthForm }[logSeg] ?? weightForm)() },
  settings: { title: 'Настройки', render: renderSettings },
};

// Остання вага — для «Сьогодні» в Хобі-плані на цьому ж пристрої (спільний localStorage сайту)
const WEIGHT_SHARE = 'vitaliylobko:weight-today';

function shareWeight() {
  const last = rows.at(-1);
  const prev = rows.at(-2);
  const v = last ? JSON.stringify({ date: last.date, kg: last.kg, prevKg: prev?.kg ?? null, prevDate: prev?.date ?? null }) : null;
  try {
    if (v === null) localStorage.removeItem(WEIGHT_SHARE);
    else if (localStorage.getItem(WEIGHT_SHARE) !== v) localStorage.setItem(WEIGHT_SHARE, v);
  } catch { /* приватний режим */ }
}

function render() {
  shareWeight();
  const view = VIEWS[tab];
  $('title').textContent = t(view.title);
  $('subtitle').textContent = '';
  if (tab === 'home' || tab === 'ration') $('subtitle').textContent = new Date().toLocaleDateString(lang() === 'uk' ? 'uk-UA' : 'ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('view').replaceChildren(view.render());
  $('fab').hidden = !view.fab;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $('settings-btn').classList.toggle('active', tab === 'settings');
  // Точка на вкладці: за сьогодні ще не зважувались
  document.querySelector('.tabs a[data-tab="home"]').classList.toggle('alert', rows.length > 0 && !rows.some((r) => r.date === M.today()));
}

function route() {
  const next = location.hash.slice(1);
  tab = VIEWS[next] ? next : 'home';
  render();
  window.scrollTo(0, 0);
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const offer = (worker) => {
    $('update').hidden = false;
    $('update-btn').onclick = () => worker.postMessage('skipWaiting');
  };
  // updateViaCache 'none' — перевірка оновлення не бере sw.js і version.js з HTTP-кешу.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('SW registration failed', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// Опівночі «сьогодні» змінюється: застосунок, відкритий з учора, має знову запропонувати запис
let shownDay = M.today();
// Відлік вікна їжі — щохвилини на місці, без перемальовування екрана (не збиває введення ваги)
setInterval(() => { if (document.visibilityState === 'visible') tickWindow(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && M.today() !== shownDay) { shownDay = M.today(); render(); }
  // Відкрили застосунок — забрати вагу, надіслану боту, поки його не було на екрані
  if (document.visibilityState === 'visible') runBot();
});
window.addEventListener('online', () => runBot());
// Записали вагу тут — бот має знати, щоб не нагадувати
window.addEventListener('db-change', () => bot.scheduleBot());
window.addEventListener('sync-applied', () => bot.scheduleBot());
// Адреса й ключ прийшли з Диска (спільний bot-settings.json) — одразу обмін, статус у налаштуваннях оновить runBot
window.addEventListener('bot-config', () => runBot());
// Бот відкинув ключ — шукаємо новіший на Диску (його могли вставити на іншому пристрої) і показуємо плашку
window.addEventListener('bot-key', () => { sync.botRound(); render(); });
// Ключ вставили в іншому застосунку на цьому пристрої
BK.onShared(() => { runBot(); render(); });

applyStatic();
applyTheme();
initLock({ key: 'weight-log:lock', name: t('Вес'), icon: 'icons/icon-192.png', text: () => ({
  locked: t('Приложение заблокировано'), unlock: t('Разблокировать'), denied: t('Не подтверждено. Попробуйте ещё раз.'),
  failed: t('Ошибка: {msg}'), reset: t('Не получается? Создать ключ заново') }) });
$('fab').addEventListener('click', () => VIEWS[tab].fab?.());
$('sync-chip').addEventListener('click', onSyncChip);
window.addEventListener('hashchange', route);
window.addEventListener('db-change', refresh);
window.addEventListener('sync-applied', refresh);
window.addEventListener('db-blocked', () => toast(t('Закройте другие вкладки приложения — база обновляется')));
registerWorker();
navigator.storage?.persist?.().catch(() => {});
state = await db.loadAll();
derive();
route();
celebrate();
sync.onStatus(() => {
  renderSyncChip();
  if (tab === 'settings') render();
});
window.addEventListener('offline', renderSyncChip);
sync.preload();
sync.syncNow();
runBot();

