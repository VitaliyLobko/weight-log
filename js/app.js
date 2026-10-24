import * as db from './db.js';
import * as sync from './sync.js';
import * as bot from './bot.js';
import * as M from './model.js';
import {
  h, fmt, sheet, toast, form, btn, toolBtn, confirmSheet, fold, box, segmented,
  remember, recall, refreshSheets, saveFile, parseNum,
} from './ui.js';
import { t, plural, lang, setLang, LANGS, applyStatic } from './i18n.js';
import { lineChart } from './chart.js';
import { icon, withIcon } from './icons.js';
import { parseCsv, fromSheet } from './importer.js';
import { remindTime, setRemindTime, googleCalendarUrl, icsFile } from './remind.js';
import { dietMemo } from './diet.js';

const $ = (id) => document.getElementById(id);

let state = { weights: [], waists: [], settings: [], tombstones: [] };
let tab = 'home';
let rows = [];
let goal = { id: M.GOAL_ID };
let sum = M.summary([], goal);

function derive() {
  rows = M.series(state.weights);
  goal = M.goalOf(state);
  sum = M.summary(rows, goal);
}

async function refresh() {
  state = await db.loadAll();
  derive();
  render();
  refreshSheets();
}

const kg = (v, d = 1) => `${fmt.fix(v, d)} ${t('кг')}`;
/** Зміна зі знаком: «−0,70 кг». */
const kgd = (v, d = 1) => `${fmt.signed(v, d)} ${t('кг')}`;
const numStr = (v) => (Number.isFinite(v) ? String(v).replace('.', ',') : '');
const findWeight = (date) => state.weights.find((w) => w.id === date);
const appUrl = () => location.href.split('#')[0];

function empty(name, title, text, ...actions) {
  return h('div', { class: 'empty' }, icon(name, 'empty-ico'), h('h3', {}, title), h('p', { class: 'muted' }, text),
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
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'big-input', autocomplete: 'off', 'aria-label': t('Вес, кг') });
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
    await db.write({ weights: { put: [{ id: date, kg: Math.round(v * 100) / 100, note: note.value.trim() }] } });
    undoToast(t('Записано {kg} за {date}', { kg: kg(v), date: fmt.date(date) }), 'weights', snap);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const panel = h('section', { class: 'panel quick' },
    h('div', { class: 'quick-head' }, h('h3', {}, withIcon('scale', t('Сегодня ещё не взвешивались'))),
      lastKg ? h('span', { class: 'muted small' }, t('прошлый раз {kg}', { kg: kg(lastKg) })) : null),
    field,
    h('label', { class: 'field' }, note),
    h('div', { class: 'btn-row' }, btn(t('Записать'), save, 'primary')));
  stepper(input, lastKg);
  return panel;
}

function todayDone(row) {
  const prev = rows[rows.indexOf(row) - 1];
  return h('button', { type: 'button', class: 'panel today-done', onclick: () => weightForm(row.date) },
    h('span', { class: 'today-label' }, icon('check'), t('Сегодня')),
    h('span', { class: 'today-kg' }, kg(row.kg)),
    prev ? h('span', { class: `today-delta ${trendClass(row.day)}` }, t('{d} к {date}', { d: fmt.signed(row.day), date: fmt.short(prev.date) })) : null,
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

function hero() {
  const s = sum;
  if (!s.hasAvg) {
    const left = 7 - (M.daysBetween(rows[0].date, M.today()) + 1);
    return h('section', { class: 'hero' },
      h('div', { class: 'hero-label' }, t('Последний вес')),
      h('div', { class: 'hero-value' }, fmt.fix(s.last.kg), h('span', { class: 'hero-unit' }, t('кг'))),
      h('div', { class: 'hero-sub' }, left > 0
        ? t('Среднее за 7 дней появится через {n} {days}', { n: left, days: plural(left, [t('день'), t('дня'), t('дней')]) })
        : t('Для среднего нужно хотя бы {n} взвешивания за неделю', { n: M.AVG_MIN })));
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
      h('div', { class: 'goal-ends' }, h('span', {}, fmt.fix(s.base.avg, 2)), h('span', {}, t('цель {kg}', { kg: fmt.fix(s.target) })))) : null);
}

function statsGrid() {
  const s = sum;
  const g = s.goal;
  const tiles = [];
  if (s.toGo !== null) tiles.push(stat('target', t('До цели'), kg(Math.max(0, s.toGo), 2), t('цель {kg}', { kg: kg(s.target) })));
  if (s.rate !== null) {
    tiles.push(stat('speed', t('Темп'), `${fmt.fix(s.rate, 2)} ${t('кг/нед')}`,
      [s.recent !== null ? t('за 4 нед. {r}', { r: fmt.fix(s.recent, 2) }) : null,
        Number.isFinite(g.planRate) ? t('план {r}', { r: fmt.fix(g.planRate, 2) }) : null].filter(Boolean).join(' · ') || null,
      Number.isFinite(g.planRate) && s.rate >= g.planRate ? 'good' : ''));
  }
  if (s.weekDelta !== null) tiles.push(stat('trend', t('За неделю'), kgd(s.weekDelta, 2), t('среднее к прошлой неделе'), trendClass(s.weekDelta)));
  if (s.planDiff !== null) {
    tiles.push(stat('route', t('От плана'), kgd(s.planDiff, 2),
      s.planDiff < -0.005 ? t('опережаете') : s.planDiff > 0.005 ? t('отстаёте') : t('точно по плану'), trendClass(s.planDiff)));
  }
  const pace = s.recent !== null ? t('темпом за 4 нед.') : t('темпом с начала');
  if (s.finish) tiles.push(stat('flag', t('Прогноз финиша'), fmt.date(s.finish), `${t('≈ {n} нед.', { n: s.weeksLeft })} · ${pace}`));
  else if (s.toGo !== null && s.toGo <= 0) tiles.push(stat('trophy', t('Цель'), t('достигнута'), null, 'good'));
  else if (s.toGo !== null && s.rate !== null) {
    tiles.push(stat('flag', t('Прогноз финиша'), '—', s.recent !== null ? t('за 4 нед. вес не снижается') : t('вес не снижается'), 'bad'));
  }
  tiles.push(stat('calendar-check', t('Дней записано'), fmt.int(s.days), g.startDate ? t('с {date}', { date: fmt.date(g.startDate) }) : null));
  return h('div', { class: 'stats' }, tiles);
}

/** Плашка «Плато»: середнє давно не оновлює мінімум. */
function plateauNote() {
  const p = M.plateau(rows);
  if (!p || (sum.toGo !== null && sum.toGo <= 0)) return null;
  return h('section', { class: 'plateau' },
    h('div', { class: 'plateau-head' }, icon('warning'),
      h('b', {}, t('Плато {n} {days}', { n: p.days, days: plural(p.days, [t('день'), t('дня'), t('дней')]) }))),
    h('p', { class: 'small' }, t('Среднее с {date} не опускается ниже {kg}. Обычно это вода и соль, а не жир: проверьте порции и сладкое, добавьте шагов — и подождите ещё неделю.',
      { date: fmt.date(p.since), kg: kg(p.low, 2) })));
}

function checkpointsBox() {
  const list = M.checkpoints(rows, goal, sum);
  if (!list.length) return null;
  return box(withIcon('flag', t('Контрольные точки')), h('div', { class: 'rows' }, list.map((c) => h('div', { class: `row cp ${c.reached ? 'done' : ''}` },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, kg(c.kg), c.isTarget ? h('span', { class: 'cp-target' }, t('цель')) : null),
      c.note ? h('span', { class: 'muted small' }, c.note) : null),
    h('div', { class: 'row-side' },
      c.reached ? h('span', { class: 'good cp-done' }, icon('check'), fmt.date(c.reached))
        : c.eta ? [h('span', {}, `≈ ${fmt.date(c.eta)}`), h('span', { class: 'muted small' }, weeksText(M.daysBetween(sum.currentDate, c.eta)))]
          : h('span', { class: 'muted' }, '—'))))),
  { tools: [toolBtn('edit', t('Изменить'), () => { location.hash = '#settings'; })] });
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
      btn(t('Указать рост'), () => { location.hash = '#settings'; })));
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
    return h('div', {}, quickEntry(), empty('scale', t('Начнём'),
      t('Записывайте вес каждое утро — среднее за 7 дней, темп и прогноз посчитаются сами. Историю из Google-таблицы можно загрузить в настройках.'),
      btn(withIcon('table', t('Загрузить из таблицы')), () => { location.hash = '#settings'; })));
  }
  const todayRow = rows.find((r) => r.date === M.today());
  return h('div', {},
    todayRow ? todayDone(todayRow) : quickEntry(),
    hero(),
    plateauNote(),
    statsGrid(),
    checkpointsBox(),
    bmiBox(),
    box(withIcon('leaf', t('Питание при диабете')), dietMemo(), { fold: 'diet' }));
}

// ---------- графік ----------

const PERIODS = [['30', 'Месяц'], ['90', '3 месяца'], ['all', 'Всё']];
/** Лінію прогнозу до фінішу, дальшого за стільки днів, не малюємо. */
const FORECAST_MAX_DAYS = 365;
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
  ].filter(Boolean);
}

function dayDetails(date) {
  const r = rows.find((x) => x.date === date);
  if (!r) return h('p', { class: 'muted small' }, t('Нажмите на точку графика — здесь появится этот день.'));
  const plan = M.planAt(sum.goal, date);
  const item = (label, value, cls = '') => [h('dt', {}, label), h('dd', { class: cls }, value)];
  return h('div', {},
    h('dl', { class: 'kv' },
      item(t('Дата'), `${fmt.date(date)}, ${fmt.weekday(date)}`),
      item(t('Вес'), kg(r.kg)),
      r.day !== null ? item(t('К прошлому'), kgd(r.day), trendClass(r.day)) : null,
      item(t('Среднее 7 дн'), r.avg !== null ? kg(r.avg, 2) : '—'),
      r.delta !== null ? item(t('За неделю'), kgd(r.delta, 2), trendClass(r.delta)) : null,
      plan !== null ? item(t('План'), kg(plan, 2)) : null,
      plan !== null && r.avg !== null ? item(t('От плана'), kgd(r.avg - plan, 2), trendClass(r.avg - plan)) : null,
      r.note ? item(t('Заметка'), r.note) : null),
    btn(t('Изменить'), () => weightForm(date)));
}

function renderChart() {
  if (!rows.length) return empty('chart', t('Пока нечего показать'), t('Запишите вес — и здесь появится график.'));
  const seg = segmented(PERIODS.map(([k, l]) => [k, t(l)]), period, (v) => { period = v; chartView = null; remember('weight-log:period', v); render(); });
  const lastDate = rows.at(-1).date;
  const from = period === 'all' ? rows[0].date : M.addDays(lastDate, -(Number(period) - 1));
  const vis = rows.filter((r) => r.date >= from);
  const showRange = (a, b) => { $('subtitle').textContent = `${fmt.date(a)} — ${fmt.date(b)}`; };
  // Прогноз — пунктир від поточного середнього до цілі; фініш далі за рік не малюємо — стиснув би графік
  const finish = sum.finish && M.daysBetween(sum.currentDate, sum.finish) <= FORECAST_MAX_DAYS ? sum.finish : null;
  const forecast = finish ? [{ date: sum.currentDate, v: sum.current }, { date: finish, v: sum.target }] : [];
  // Місяць і 3 місяці заглядають уперед на п'яту частину періоду, «усе» — до самого фінішу
  const viewEnd = finish ? (period === 'all' ? finish : [finish, M.addDays(lastDate, Math.round(Number(period) / 5))].sort()[0]) : lastDate;
  const view = chartView ?? [vis[0].date, viewEnd];
  showRange(...view);
  const g = sum.goal;
  const plan = rows.map((r) => ({ date: r.date, v: M.planAt(g, r.date) })).filter((p) => p.v !== null);
  const marks = M.checkpoints(rows, goal, sum).map((c) => ({ v: c.kg, label: c.isTarget ? t('цель') : fmt.int(c.kg), cls: c.isTarget ? 'target' : 'cp' }));
  const details = h('div', {}, dayDetails(picked));
  // Заливка між середнім і планом: зелена — середнє нижче плану (випереджаєте), червона — вище
  const planOn = new Map(plan.map((p) => [p.date, p.v]));
  const ahead = rows.filter((r) => r.avg !== null && planOn.has(r.date)).map((r) => ({ date: r.date, a: r.avg, b: planOn.get(r.date) }));
  const chart = lineChart({
    series: [
      { key: 'gap', kind: 'band', cls: 's-gap', points: ahead },
      { key: 'plan', kind: 'line', cls: 's-plan', points: plan },
      { key: 'kg', kind: 'dots', cls: 's-kg', points: rows.map((r, i) => ({ date: r.date, v: r.kg, ring: Boolean(r.note), last: i === rows.length - 1 })) },
      { key: 'avg', kind: 'line', cls: 's-avg', points: rows.filter((r) => r.avg !== null).map((r) => ({ date: r.date, v: r.avg })), endLabel: true },
      { key: 'forecast', kind: 'line', cls: 's-forecast', points: forecast, aside: true },
    ],
    height: 260,
    zoom: true,
    view,
    onView: (a, b) => { chartView = [a, b]; showRange(a, b); },
    fullLabel: t('Весь график'),
    onFull: () => { period = 'all'; chartView = null; remember('weight-log:period', period); render(); },
    hlines: marks,
    legend: [
      { label: t('Вес'), kind: 'dot', cls: 's-kg' },
      { label: t('Среднее 7 дн'), kind: 'line', cls: 's-avg' },
      plan.length ? { label: t('План'), kind: 'line dash', cls: 's-plan' } : null,
      finish ? { label: t('прогноз → {date}', { date: fmt.date(finish) }), kind: 'line dash', cls: 's-forecast' } : null,
      vis.some((r) => r.note) ? { label: t('с заметкой'), kind: 'ring', cls: 's-kg' } : null,
      ahead.length ? { label: t('опережаете'), kind: 'area', cls: 'good' } : null,
      ahead.length ? { label: t('отстаёте'), kind: 'area', cls: 'bad' } : null,
    ].filter(Boolean),
    digits: 2,
    selected: picked,
    tip: dayTip,
    onPick: (date) => { picked = date; details.replaceChildren(dayDetails(date)); },
  });
  const below = sum.target !== null && vis.every((r) => r.kg > sum.target + 1)
    ? h('p', { class: 'muted small chart-note' }, t('Цель {kg} — ниже шкалы графика: до неё ещё {d}.', { kg: kg(sum.target), d: kg(Math.max(0, sum.toGo ?? 0), 2) }))
    : null;
  return h('div', {}, seg,
    h('section', { class: 'panel chart-panel' }, chart, below,
      h('p', { class: 'muted small chart-note chart-hint mouse' }, t('Колесо мыши — масштаб, перетаскивание — сдвиг, двойной клик — приблизить или сбросить.')),
      h('p', { class: 'muted small chart-note chart-hint touch' }, t('Касание — выбрать день, палец вбок — сдвиг. Два пальца вширь — масштаб дат, вверх-вниз — масштаб веса. Двойной тап — приблизить или сбросить.'))),
    box(withIcon('calendar', t('Выбранный день')), details),
    waistBox());
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

const LOG_SEGS = [['weight', 'Вес'], ['waist', 'Талия'], ['sizes', 'Размеры']];
let logSeg = LOG_SEGS.some(([k]) => k === recall('weight-log:log-seg')) ? recall('weight-log:log-seg') : 'weight';

const sizesText = () => state.settings.find((s) => s.id === M.SIZES_ID)?.text ?? '';

/** Розміри — одним текстом, рядок на розмір: так список можна вставити цілком. */
function sizesForm() {
  const input = h('textarea', { rows: 12, placeholder: t('Перчатки L\nОбувь 43/44, стелька 28,5 см\nГолова 59 см'), autocomplete: 'off' });
  input.value = sizesText();
  const save = async () => {
    sync.renewOnGesture();
    close();
    const text = input.value.split('\n').map((s) => s.trimEnd()).join('\n').trim();
    await db.write({ settings: { put: [{ id: M.SIZES_ID, text }] } });
    toast(t('Размеры сохранены'));
  };
  const close = sheet(t('Мои размеры'), h('div', { class: 'form' },
    h('label', { class: 'field' }, input,
      h('small', { class: 'muted' }, t('Строка — один размер: название, потом значение. Можно вставить список целиком.')))), {
    actions: [btn(t('Сохранить'), save, 'primary')],
  });
}

function renderSizes(seg) {
  const list = M.parseSizes(sizesText());
  $('subtitle').textContent = t('размеров: {n}', { n: list.length });
  if (!list.length) {
    return h('div', {}, seg, empty('tape', t('Размеров нет'),
      t('Перчатки, обувь, одежда, кольцо — чтобы всегда были под рукой в магазине.'),
      btn(withIcon('plus', t('Указать размеры')), sizesForm)));
  }
  return h('div', {}, seg, h('div', { class: 'rows sizes' }, list.map((s) => h('button', { type: 'button', class: 'row log-row', onclick: sizesForm },
    h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, s.label)),
    s.value ? h('div', { class: 'row-side' }, h('span', { class: 'size-value' }, s.value)) : null))));
}

function weightRow(r) {
  return h('button', { type: 'button', class: 'row log-row', onclick: () => weightForm(r.date) },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, fmt.short(r.date), h('span', { class: 'muted' }, ` · ${fmt.weekday(r.date)}`)),
      h('span', { class: 'muted small' }, [
        r.avg !== null ? t('сред. {v}', { v: fmt.fix(r.avg, 2) }) : null,
        r.delta !== null ? t('нед. {v}', { v: fmt.signed(r.delta, 2) }) : null,
      ].filter(Boolean).join(' · ')),
      r.note ? h('span', { class: 'row-note' }, icon('note'), h('span', {}, r.note)) : null),
    h('div', { class: 'row-side' },
      h('span', { class: 'row-kg' }, fmt.fix(r.kg)),
      r.day !== null ? h('span', { class: `small ${trendClass(r.day)}` }, fmt.signed(r.day)) : null));
}

function renderLog() {
  const seg = segmented(LOG_SEGS.map(([k, l]) => [k, t(l)]), logSeg, (v) => { logSeg = v; remember('weight-log:log-seg', v); render(); });
  if (logSeg === 'sizes') return renderSizes(seg);
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
  const months = new Map();
  for (const r of [...rows].reverse()) {
    const ym = r.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym).push(r);
  }
  return h('div', {}, seg, [...months].map(([ym, list]) => {
    const avg = list.reduce((s, r) => s + r.kg, 0) / list.length;
    const change = list.length > 1 ? list[0].kg - list.at(-1).kg : null;
    return fold(`log:${ym}`, [
      h('span', { class: 'fold-stack' }, h('span', { class: 'fold-title' }, fmt.month(ym)),
        h('span', { class: 'fold-meta' }, t('{n} взв. · сред. {v}', { n: list.length, v: fmt.fix(avg, 1) }))),
      change !== null ? h('span', { class: `fold-sum ${trendClass(change)}` }, fmt.signed(change)) : null,
    ], h('div', { class: 'rows' }, list.map(weightRow)));
  }));
}

// ---------- налаштування ----------

async function saveGoal(patch) {
  await db.write({ settings: { put: [{ ...goal, ...patch, id: M.GOAL_ID }] } });
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
  return h('section', { class: 'panel' }, h('h3', {}, withIcon('target', t('Цель'))),
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
  return h('section', { class: 'panel' }, h('h3', {}, withIcon('flag', t('Контрольные точки'))),
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
  return h('section', { class: 'panel' }, h('h3', {}, withIcon('bell', t('Напоминание'))),
    h('p', { class: 'muted small' }, t('Само приложение без сервера не может разбудить телефон в нужный час, поэтому будильник ставит календарь: ежедневное событие «Взвеситься» с уведомлением. А на главной, пока вес за сегодня не записан, сверху стоит поле записи и горит точка на вкладке.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Время')), time),
    h('div', { class: 'btn-row' },
      btn(withIcon('calendar', t('Google Календарь')), () => { setRemindTime(time.value); window.open(googleCalendarUrl(remindTime(), appUrl()), '_blank', 'noopener'); }, 'primary'),
      btn(withIcon('download', t('Файл .ics')), () => { setRemindTime(time.value); saveFile(icsFile(remindTime(), appUrl()), true); })),
    h('p', { class: 'muted small' }, t('В Google Календаре проверьте, что у события включено уведомление «в момент начала». Файл .ics открывают календари Samsung, iPhone и Outlook.')));
}

// ---------- Telegram-бот ----------

let botError = '';

/** Обмін з ботом; записане ботом — коротке повідомлення. Без мережі тихо: спробуємо наступного разу. */
async function runBot() {
  try {
    const { got } = await bot.syncBot();
    botError = '';
    if (got?.length === 1) toast(t('Из Telegram: {kg} за {date}', { kg: kg(got[0].kg), date: fmt.date(got[0].date) }));
    else if (got?.length) toast(t('Из Telegram: записей {n}', { n: got.length }));
  } catch (err) {
    // fetch без мережі падає з «Failed to fetch» — людині зрозуміліше своїми словами
    botError = err.message === 'key' || err.message.startsWith('HTTP') ? err.message : t('сеть недоступна');
  }
  // Статус у налаштуваннях — свіжий, але не під пальцями, що саме вводять адресу чи ключ
  if (tab === 'settings' && !document.activeElement?.matches('input')) render();
}

function botStatus(cfg) {
  if (!cfg.from) return t('Не подключён. Проще всего — подключить бота в Хобі-плане на этом же телефоне: адрес и ключ подхватятся сами. Или укажите их ниже.');
  if (botError === 'key') return t('Бот не принял ключ — возьмите новый командой /key и укажите его здесь и в Хобі-плане.');
  if (botError) return t('Нет связи с ботом: {e}', { e: botError });
  const via = cfg.from === 'hobby' ? t('Подключён через Хобі-план.') : t('Подключён.');
  return `${via} ${t('Последний обмен: {time}', { time: syncTime(bot.lastSync()) })}`;
}

function telegramPanel() {
  const cfg = bot.botConfig();
  const f = form([
    { name: 'url', label: t('Адрес бота'), value: cfg.from === 'own' ? cfg.url : '', placeholder: 'https://….workers.dev' },
    { name: 'key', label: t('Ключ — команда /key в боте'), type: 'password', value: cfg.from === 'own' ? cfg.key : '' },
  ]);
  const save = async () => {
    const v = f.values();
    if (!v.url.startsWith('https://') || !v.key) { toast(t('Укажите адрес https://… и ключ')); return; }
    bot.setBotConfig(v.url, v.key);
    await runBot();
    render();
    toast(botError ? botStatus(bot.botConfig()) : t('Бот подключён'));
  };
  const own = h('div', {}, f.el, h('div', { class: 'btn-row' },
    btn(t('Сохранить'), save, cfg.from ? '' : 'primary'),
    cfg.from === 'own' ? btn(t('Отключить'), () => { bot.setBotConfig('', ''); botError = ''; render(); }) : null));
  return h('section', { class: 'panel' }, h('h3', {}, withIcon('bell', 'Telegram')),
    h('p', { class: 'muted small' }, t('Бот Хобі-плана во время напоминания пишет «пора взвеситься» и принимает вес сообщением — числом, например 82,4, можно с заметкой. Запись сама появится в журнале, когда откроете приложение.')),
    h('p', { class: `small ${botError ? 'error-text' : 'muted'}` }, botStatus(cfg)),
    cfg.from ? [
      segmented([['on', t('Напоминать в {time}', { time: remindTime() })], ['off', t('Не напоминать')]],
        bot.remindOn() ? 'on' : 'off', (v) => { bot.setRemindOn(v === 'on'); bot.scheduleBot(300); }),
      h('div', { class: 'btn-row' }, btn(withIcon('sync', t('Проверить связь')), async () => {
        await runBot();
        render();
        if (!botError) toast(t('Связь с ботом есть'));
      }, 'primary')),
    ] : null,
    cfg.from === 'hobby' ? fold('bot-own', t('Свой адрес и ключ'), own) : own);
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

function renderSyncChip(s) {
  const chip = $('sync-chip');
  chip.hidden = !CHIP[s.state];
  if (CHIP[s.state]) {
    chip.replaceChildren(avatar(s.photo), CHIP[s.state]());
    chip.className = `sync-chip ${s.state}`;
    chip.title = s.message || t('Синхронизация с Google Диском');
  }
  if (tab === 'settings') render();
}

function onSyncChip() {
  const { state: st, message } = sync.status;
  if (st === 'auth') connectGoogle();
  else if (st === 'offline') toast(t('Нет интернета — синхронизация произойдёт, когда появится связь'));
  else if (st === 'error') { toast(message || t('Ошибка синхронизации')); sync.syncNow(); } else sync.syncNow();
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

function syncPanel() {
  const s = sync.status;
  const panel = h('section', { class: 'panel' }, h('h3', {}, withIcon('cloud', t('Синхронизация · Google Диск'))));
  if (!sync.configured()) {
    panel.append(h('p', { class: 'muted small' }, t('Не настроена: в js/config.js не указан Google Client ID.')));
  } else if (!sync.enabled()) {
    panel.append(
      h('p', { class: 'muted small' }, t('Данные будут храниться в файле weight-log.json на вашем Google Диске и совпадать на телефоне и компьютере. Приложение видит только свои файлы, остальной Диск ему недоступен.')),
      h('div', { class: 'btn-row' }, btn(withIcon('cloud', t('Подключить Google Диск')), connectGoogle, 'primary')));
  } else {
    panel.append(
      h('div', { class: 'account' }, avatar(s.photo, 'big'),
        h('div', { class: 'account-text' }, h('b', {}, s.name ?? s.email ?? '—'), s.name && s.email ? h('span', { class: 'muted small' }, s.email) : null)),
      h('dl', { class: 'kv' },
        h('dt', {}, t('Последняя')), h('dd', {}, syncTime(s.lastSync)),
        s.message ? [h('dt', {}, t('Статус')), h('dd', {}, s.message)] : null),
      h('div', { class: 'btn-row' },
        s.state === 'auth' ? btn(t('Войти в Google'), connectGoogle, 'primary') : btn(withIcon('sync', t('Синхронизировать')), () => sync.syncNow(), 'primary'),
        btn(t('Отключить'), () => confirmSheet(t('Отключить синхронизацию?'), t('Данные останутся и на устройстве, и на Google Диске, просто перестанут обмениваться.'), t('Отключить'), () => sync.disconnect()))));
  }
  return panel;
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
  const data = parsed?.data;
  if (parsed?.app !== 'weight-log' || !data || !db.STORES.every((s) => !data[s] || Array.isArray(data[s]))) {
    toast(t('Это не резервная копия Weight Log'));
    return;
  }
  const count = db.STORES.reduce((s, k) => s + (data[k]?.length ?? 0), 0);
  const changes = Object.fromEntries(db.STORES.map((s) => [s, { put: (data[s] ?? []).filter((x) => x && x.id) }]));
  const close = sheet(t('Импорт копии'), h('div', {},
    h('p', {}, t('В файле {n} записей.', { n: count })),
    h('p', { class: 'muted small' }, t('«Объединить» — добавит новые записи и обновит те, что в файле новее: более поздние правки на устройстве останутся. «Заменить всё» — сначала удалит текущие данные.')),
    sync.enabled() ? h('p', { class: 'muted small' }, t('Включена синхронизация: «Заменить всё» заменит данные и на Google Диске, и на других устройствах. «Объединить» не откатит более новые данные с Диска.')) : null), {
    actions: [
      btn(t('Отмена'), () => close()),
      btn(t('Объединить'), async () => { close(); await db.mergeImport(changes); toast(t('Импортировано')); }, 'primary'),
      btn(t('Заменить всё'), () => {
        close();
        confirmSheet(t('Заменить все данные?'), t('Текущие данные будут удалены. Сначала сделайте экспорт, если они нужны.'), t('Заменить'), async () => {
          sync.markRestore(await db.replaceAll(changes)); toast(t('Данные заменены'));
        });
      }, 'danger'),
    ],
  });
}

/**
 * Імпорт CSV з таблиці. Дні, яких у застосунку нема, додаються; однакові пропускаються;
 * де вага різна — лишається своя, а замінити значеннями з таблиці можна окремою кнопкою.
 */
async function importSheet(file) {
  const parsed = fromSheet(parseCsv(await readText(file)));
  if (!parsed.weights.length && !parsed.waists.length) {
    toast(t('В файле не найдено ни одного взвешивания — нужен CSV листа «Вес» или «Графики»'));
    return;
  }
  const add = [];
  const fill = [];
  const diff = [];
  let same = 0;
  for (const w of parsed.weights) {
    const mine = findWeight(w.date);
    const rec = { id: w.date, kg: w.kg, note: w.note };
    if (!mine) add.push(rec);
    else if (Math.abs(mine.kg - w.kg) > 0.001) diff.push({ rec, mine });
    else {
      same += 1;
      // Нотатка з таблиці — лише якщо своєї нема (на аркуші «Графики» нотатки обрізані)
      if (!mine.note && w.note) fill.push({ ...mine, note: w.note });
    }
  }
  const waistAdd = [];
  const waistDiff = [];
  for (const w of parsed.waists) {
    const mine = state.waists.find((x) => x.id === M.waistId(w.date));
    const rec = { id: M.waistId(w.date), date: w.date, cm: w.cm };
    if (!mine) waistAdd.push(rec);
    else if (Math.abs(mine.cm - w.cm) > 0.001) waistDiff.push({ rec, mine });
  }
  const goalPatch = {};
  for (const k of ['start', 'startDate', 'target', 'planRate']) {
    if (parsed.goal[k] !== undefined && (goal[k] === undefined || goal[k] === null || goal[k] === '')) goalPatch[k] = parsed.goal[k];
  }
  if (parsed.goal.checkpoints && !(goal.checkpoints ?? []).length) goalPatch.checkpoints = parsed.goal.checkpoints.map((c) => ({ id: db.uid(), ...c }));
  const goalKeys = Object.keys(goalPatch);
  const apply = async (replace) => {
    close();
    const changes = {
      weights: { put: [...add, ...fill.map(({ updated, ...r }) => r), ...(replace ? diff.map((d) => ({ ...d.rec, note: d.rec.note || d.mine.note })) : [])] },
      waists: { put: [...waistAdd, ...(replace ? waistDiff.map((d) => d.rec) : [])] },
    };
    if (goalKeys.length) changes.settings = { put: [{ ...goal, ...goalPatch, id: M.GOAL_ID }] };
    await db.write(changes);
    toast(t('Из таблицы загружено'));
  };
  const lines = [
    t('Новых дней: {n}', { n: add.length }),
    t('Уже есть, совпадают: {n}', { n: same }),
    fill.length ? t('Добавится заметок к имеющимся дням: {n}', { n: fill.length }) : null,
    diff.length ? t('Вес отличается: {n}', { n: diff.length }) : null,
    parsed.waists.length ? t('Замеров талии: новых {n}, отличаются {d}', { n: waistAdd.length, d: waistDiff.length }) : null,
    goalKeys.length ? t('Цель и контрольные точки: возьмутся из таблицы (в приложении не заданы)') : null,
  ].filter(Boolean);
  const anything = add.length || fill.length || waistAdd.length || goalKeys.length;
  const close = sheet(t('Импорт из таблицы'), h('div', {},
    h('ul', { class: 'import-sum' }, lines.map((l) => h('li', {}, l))),
    diff.length ? box(t('Расхождения'), h('div', { class: 'rows' }, diff.slice(0, 20).map((d) => h('div', { class: 'row' },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, fmt.date(d.rec.id))),
      h('div', { class: 'row-side' }, h('span', {}, t('в приложении {a}', { a: fmt.fix(d.mine.kg) })), h('span', { class: 'muted small' }, t('в таблице {b}', { b: fmt.fix(d.rec.kg) }))))))) : null,
    h('p', { class: 'muted small' }, t('«Добавить» не трогает уже записанные дни. «Заменить расхождения» возьмёт вес из таблицы там, где он отличается.'))), {
    actions: [
      btn(t('Отмена'), () => close()),
      anything ? btn(t('Добавить'), () => apply(false), 'primary') : null,
      diff.length || waistDiff.length ? btn(t('Заменить расхождения'), () => apply(true), 'danger') : null,
    ].filter(Boolean),
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f2f7' : '#121019');
}

lightScheme.addEventListener('change', applyTheme);

function switchLang(code) {
  setLang(code);
  applyStatic();
  renderSyncChip(sync.status);
  render();
}

/** «Про застосунок», як у shooting-log: аватар автора, що це таке, де дані, з чого почати. */
function aboutPanel() {
  const more = (title, node) => h('details', { class: 'about-more' }, h('summary', {}, title), node);
  return h('section', { class: 'panel about' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-avatar', src: './icons/author.jpg', alt: '', width: 64, height: 64, loading: 'lazy' }),
      h('div', {},
        h('h3', {}, t('О приложении')),
        h('p', { class: 'muted small' }, t('Weight Log — ежедневный вес, среднее за 7 дней, темп и прогноз цели. Работает без интернета: всё считается на устройстве.')))),
    more(t('Где мои данные'), h('div', { class: 'muted small' },
      h('p', {}, t('Записи лежат в браузере на этом устройстве. Сервера у приложения нет, автор не получает ни данных, ни статистики.')),
      h('p', {}, t('Google Диск подключается по желанию: копия ложится в файл weight-log.json на вашем Диске, приложение видит только свои файлы.')),
      h('p', {}, t('Резервная копия — «Поделиться копией» ниже. Она же переносит данные на другое устройство через «Импорт копии».')))),
    more(t('С чего начать'), h('ol', { class: 'about-steps' },
      h('li', {}, t('Задайте цель: стартовый вес, целевой и план, кг в неделю.')),
      h('li', {}, t('Взвешивайтесь каждое утро и записывайте вес на главной — поле само предложит прошлое значение.')),
      h('li', {}, t('Историю из Google-таблицы загрузите через «Импорт из Google-таблицы».')),
      h('li', {}, t('Поставьте напоминание в календаре, чтобы не пропускать дни.')))),
    h('p', { class: 'muted small' },
      h('a', { href: 'https://github.com/VitaliyLobko/weight-log', target: '_blank', rel: 'noopener' }, t('Исходный код'))));
}

function renderSettings() {
  $('subtitle').textContent = t('версия {v}', { v: self.APP_VERSION });
  const backupInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; } });
  const csvInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: (e) => { if (e.target.files[0]) importSheet(e.target.files[0]); e.target.value = ''; } });
  return h('div', {},
    aboutPanel(),
    goalPanel(),
    checkpointsPanel(),
    remindPanel(),
    telegramPanel(),
    h('section', { class: 'panel' }, h('h3', {}, withIcon('globe', 'Язык · Мова')), segmented(Object.entries(LANGS), lang(), switchLang)),
    h('section', { class: 'panel' }, h('h3', {}, withIcon('theme', t('Тема'))),
      segmented(THEMES.map(([k, label]) => [k, t(label)]), themePref(), (v) => { remember('weight-log:theme', v); applyTheme(); })),
    syncPanel(),
    h('section', { class: 'panel' }, h('h3', {}, withIcon('table', t('Импорт из Google-таблицы'))),
      h('p', { class: 'muted small' }, t('В таблице: Файл → Скачать → CSV (текущий лист). Лист «Вес» даёт взвешивания, заметки, цель и контрольные точки; лист «Графики» — ещё и замеры талии. Повторный импорт ничего не задваивает: дни сверяются по дате.')),
      h('div', { class: 'btn-row' }, btn(withIcon('table', t('Выбрать CSV')), () => csvInput.click(), 'primary')), csvInput),
    h('section', { class: 'panel' },
      h('h3', {}, withIcon('archive', t('Резервная копия'))),
      h('p', { class: 'muted small' }, sync.enabled()
        ? t('Основная копия — на Google Диске. Файл ниже — дополнительный снимок на всякий случай.')
        : t('Без синхронизации данные хранятся только на этом устройстве. Время от времени сохраняйте копию — например, «Поделиться» → Google Диск или Telegram «Избранное».')),
      h('div', { class: 'btn-row' },
        btn(withIcon('share', t('Поделиться копией')), () => exportData(true), 'primary'),
        btn(withIcon('download', t('Скачать файл')), () => exportData(false)),
        btn(withIcon('upload', t('Импорт копии')), () => backupInput.click())),
      h('p', { class: 'muted small' }, t('Взвешиваний: {w} · замеров талии: {c}', { w: state.weights.length, c: state.waists.length })),
      backupInput),
    h('section', { class: 'panel' },
      h('h3', {}, withIcon('phone', t('Установка на телефон'))),
      h('p', { class: 'muted small' }, t('Chrome → меню ⋮ → «Добавить на главный экран» / «Установить приложение». После установки работает без интернета.'))),
    h('section', { class: 'panel' },
      h('h3', {}, withIcon('warning', t('Опасная зона'))),
      btn(t('Удалить данные с устройства'), () => confirmSheet(t('Удалить данные с устройства?'), sync.enabled()
        ? t('Данные будут удалены с этого устройства. Копия на Google Диске останется и вернётся при следующей синхронизации — чтобы этого не было, сначала отключите синхронизацию.')
        : t('Все взвешивания, замеры и цель будут удалены с этого устройства. Отменить нельзя.'), t('Удалить'), async () => {
        await db.clearAll(); await refresh(); toast(t('Данные удалены'));
      }), 'danger')));
}

// ---------- навігація ----------

const VIEWS = {
  home: { title: 'Вес', render: renderHome, fab: () => weightForm() },
  chart: { title: 'График', render: renderChart, fab: () => weightForm() },
  log: { title: 'Журнал', render: renderLog, fab: () => ({ waist: waistForm, sizes: sizesForm }[logSeg] ?? weightForm)() },
  settings: { title: 'Настройки', render: renderSettings },
};

function render() {
  const view = VIEWS[tab];
  $('title').textContent = t(view.title);
  $('subtitle').textContent = '';
  if (tab === 'home') $('subtitle').textContent = new Date().toLocaleDateString(lang() === 'uk' ? 'uk-UA' : 'ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('view').replaceChildren(view.render());
  // На головній поле запису вже стоїть угорі — друга кнопка «+» там лише заважала б
  $('fab').hidden = !view.fab || (tab === 'home' && !rows.some((r) => r.date === M.today()));
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && M.today() !== shownDay) { shownDay = M.today(); render(); }
  // Відкрили застосунок — забрати вагу, надіслану боту, поки його не було на екрані
  if (document.visibilityState === 'visible') runBot();
});
window.addEventListener('online', () => runBot());
// Записали вагу тут — бот має знати, щоб не нагадувати
window.addEventListener('db-change', () => bot.scheduleBot());
window.addEventListener('sync-applied', () => bot.scheduleBot());

applyStatic();
applyTheme();
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
sync.onStatus(renderSyncChip);
sync.preload();
sync.syncNow();
runBot();

