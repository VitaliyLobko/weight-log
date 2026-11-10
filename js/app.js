import * as db from './db.js';
import * as sync from './sync.js';
import * as bot from './bot.js';
import * as BK from './bot-key.js';
import * as M from './model.js';
import {
  h, fmt, sheet, toast, form, btn, toolBtn, confirmSheet, fold, box, unfold, segmented,
  remember, recall, refreshSheets, saveFile, parseNum, wheelStrip,
} from './ui.js';
import { t, plural } from './i18n.js';
import { initLock, lockOn, lockDelay, lockAvailable, enableLock, disableLock, setLockDelay, LOCK_DELAYS } from './lock.js';
import { lineChart } from './chart.js';
import { icon, withIcon } from './icons.js';
import { remindTime, setRemindTime, googleCalendarUrl, icsFile } from './remind.js';
import { renderRation, homeLine, noteTags, tickWindow, planOf, energy, calories, energyLeft, dayKcal, walkOf } from './nutrition.js';
import {
  weightHint, afterStatus, STATUS, yesterdayText, weekMarks, periodFood, streakMilestones, journalDay, dayDates, streak, dayOf,
  unrecorded, daySheet, rationStart, setWalkBase, setDayState,
} from './daylog.js';
import { oink, oinkOn, setOinkOn } from './oink.js';
import * as party from './celebrate.js';

const $ = (id) => document.getElementById(id);

let state = { weights: [], waists: [], settings: [], tombstones: [] };
let tab = 'home';
let rows = [];
// Дата, яку щойно записали з «Сьогодні»: галочка в картці середнього домалюється один раз
let justSaved = '';
let goal = { id: M.GOAL_ID };
let sum = M.summary([], goal);
// Перший позначений день «Як день?» і темп від нього: старий темп за 4 тижні тягне за собою дні до раціону
let rationFrom = null;
let rationRate = null;

function derive() {
  rows = M.series(state.weights);
  // Паузи на підтриманні з раціону: у них лінія плану стоїть, прогноз відсувається, плато мовчить
  goal = { ...M.goalOf(state), pauses: planOf(state)?.pauses ?? [] };
  sum = M.summary(rows, goal);
  // Живі шторки дня й «Моїх продуктів» будуються з цього стану, хоч би який екран був під ними
  setDayState(state);
  rationFrom = planOf(state) ? rationStart(state) : null;
  rationRate = rationFrom && sum.base && rationFrom > sum.base.date ? M.rateSince(rows, rationFrom, goal.pauses) : null;
  // Прогулянки додаються до норми лише за формулою: у реальній витраті вони вже є
  setWalkBase(sum.current, calories(state, rows, sum.goal, sum.current)?.source === 'formula');
}

/** Норма для днів журналу й «Раціону»: { kcal, hold, walk, kg } — walk: додавати прогулянку дня. */
function normOf() {
  const c = calories(state, rows, sum.goal, sum.current);
  return c ? { kcal: c.burn, hold: sum.hold, walk: c.source === 'formula', kg: sum.current } : null;
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
  toast(message, { action: t('Скасувати'), onAction: () => restore(store, snap) });
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
    { name: 'kg', label: t('Вага, кг'), type: 'number', value: existing ? fmt.fix(existing.kg) : (lastKg ? fmt.fix(lastKg) : ''), required: true, min: 20, max: 400, big: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: date, required: true },
    { name: 'note', label: t('Нотатка'), value: existing?.note ?? '', placeholder: t('що їв, самопочуття…') },
  ]);
  stepper(f.inputs.kg, lastKg);
  const tags = noteTags(state, f.inputs.note);
  if (tags) f.inputs.note.parentElement.after(tags);
  const save = () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
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
      confirmSheet(t('Замінити запис?'), t('За {date} уже записано {kg}.', { date: fmt.date(v.date), kg: kg(clash.kg) }), t('Замінити'), write);
    } else write();
  };
  const remove = async () => {
    close();
    const snap = snapshot('weights', [existing.id]);
    await db.write({ weights: { del: [existing.id] } });
    undoToast(t('Запис за {date} видалено', { date: fmt.date(existing.id) }), 'weights', snap);
  };
  const close = sheet(existing ? t('Вага за {date}', { date: fmt.date(date) }) : t('Записати вагу'), f.el, {
    tools: existing ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
  if (!existing) setTimeout(() => f.inputs.kg.select(), 250);
}

function waistForm(record) {
  const last = M.waistSeries(state.waists).at(-1);
  const f = form([
    { name: 'cm', label: t('Талія, см'), type: 'number', value: record ? fmt.fix(record.cm) : (last ? fmt.fix(last.cm) : ''), required: true, min: 20, max: 300, big: true },
    { name: 'date', label: t('Дата'), type: 'dmy', value: record?.date ?? M.today(), required: true },
  ]);
  stepper(f.inputs.cm, last?.cm);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
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
    undoToast(t('Замір за {date} видалено', { date: fmt.date(record.date) }), 'waists', snap);
  };
  const close = sheet(record ? t('Талія за {date}', { date: fmt.date(record.date) }) : t('Замір талії'), f.el, {
    tools: record ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

// ---------- «Сьогодні» ----------

/** Швидкий запис просто на головній: відкрив, поправив останню цифру, зберіг. */
function quickEntry() {
  const lastKg = rows.at(-1)?.kg;
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'big-input', autocomplete: 'off', 'aria-label': t('Вага, кг'), placeholder: t('Вага, кг') });
  input.value = lastKg ? fmt.fix(lastKg) : '';
  const note = h('input', { type: 'text', autocomplete: 'off', placeholder: t('Нотатка (необов’язково)') });
  const field = h('div', { class: 'quick-kg' }, input);
  const save = async () => {
    const v = parseNum(input.value);
    if (!Number.isFinite(v) || v < 20 || v > 400) { toast(t('Введіть вагу в кілограмах')); input.focus(); return; }
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
    h('div', { class: 'quick-head' }, h('h3', {}, withIcon('scale', t('Сьогодні ще не зважувались'))),
      lastKg ? h('span', { class: 'muted small' }, t('минулого разу {kg}', { kg: kg(lastKg) })) : null),
    field,
    h('label', { class: 'field' }, note),
    noteTags(state, note),
    h('div', { class: 'btn-row' }, btn(t('Записати'), save, 'primary')));
  stepper(input, lastKg);
  return panel;
}

/** Сьогоднішня вага рядком усередині картки середнього: головне число одне — середнє. */
function todayLine(row) {
  const prev = rows[rows.indexOf(row) - 1];
  const just = justSaved === row.date;
  justSaved = '';
  return h('button', { type: 'button', class: 'today-line', onclick: () => weightForm(row.date) },
    h('span', { class: `today-label${just ? ' just' : ''}` }, icon('check'), t('Сьогодні')),
    h('b', { class: 'today-kg' }, kg(row.kg)),
    prev ? h('span', { class: `today-delta ${trendClass(row.day)}` }, t('{d} кг від {date}', { d: fmt.signed(row.day), date: fmt.short(prev.date) })) : null,
    icon('edit'),
    row.note ? h('span', { class: 'today-note muted small' }, row.note) : null);
}

/** Знижується — добре (зелене), росте — погано: ціль — схуднути. */
function trendClass(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return 'flat';
  return v < 0 ? 'good' : 'bad';
}

function stat(name, label, value, sub, cls = '', extra = null) {
  return h('div', { class: `stat ${cls}` },
    h('div', { class: 'stat-label' }, icon(name), label),
    h('div', { class: 'stat-value' }, value),
    extra,
    sub ? h('div', { class: 'stat-sub muted' }, sub) : null);
}

/** Шкала «скільки днів із 14 без нового мінімуму»: заповнені — минули, порожні — лишилось до плато. */
function plateauSteps(days, total) {
  return h('div', { class: 'stat-steps', role: 'img', 'aria-label': t('До плато лишилось {n} дн.', { n: total - days }) },
    Array.from({ length: total }, (_, i) => h('span', { class: i < days ? 'on' : '' })));
}

function hero(todayRow) {
  const s = sum;
  if (!s.hasAvg) {
    const left = 7 - (M.daysBetween(rows[0].date, M.today()) + 1);
    return h('section', { class: 'hero' },
      h('div', { class: 'hero-label' }, t('Остання вага')),
      h('div', { class: 'hero-value' }, fmt.fix(s.last.kg), h('span', { class: 'hero-unit' }, t('кг'))),
      h('div', { class: 'hero-sub' }, left > 0
        ? t('Середнє за 7 днів з’явиться через {n} {days}', { n: left, days: plural(left, [t('день'), t('дні'), t('днів')]) })
        : t('Для середнього потрібно хоча б {n} зважування за тиждень', { n: M.AVG_MIN })),
      todayRow ? todayLine(todayRow) : null);
  }
  const span = s.base && s.target !== null ? s.base.avg - s.target : null;
  const pos = (k) => `${Math.min(100, Math.max(0, ((s.base.avg - k) / span) * 100))}%`;
  return h('section', { class: 'hero accent' },
    h('div', { class: 'hero-label' }, t('Середнє за 7 днів')),
    h('div', { class: 'hero-value' }, fmt.fix(s.current, 2), h('span', { class: 'hero-unit' }, t('кг'))),
    h('div', { class: 'hero-sub' }, s.hold ? holdText() : [
      s.lost !== null ? t('{d} кг від початку', { d: fmt.signed(-s.lost, 2) }) : null,
      s.progress !== null ? ` · ${t('{p} % шляху', { p: fmt.int(s.progress * 100) })}` : null]),
    !s.hold && span > 0 ? h('div', { class: 'goal-track', 'aria-hidden': 'true' },
      h('div', { class: 'goal-bar' },
        h('div', { class: 'goal-fill', style: `width:${pos(s.current)}` }),
        M.checkpoints(rows, goal, s).filter((c) => !c.isTarget).map((c) => h('span', { class: `goal-tick ${c.reached ? 'done' : ''}`, style: `left:${pos(c.kg)}` }))),
      h('div', { class: 'goal-ends' }, h('span', {}, t('старт {kg}', { kg: fmt.fix(s.base.avg, 2) })), h('span', {}, s.toGo > 0
        ? t('ціль {kg} · ще {d}', { kg: fmt.fix(s.target), d: fmt.fix(s.toGo, 1) })
        : t('ціль {kg}', { kg: fmt.fix(s.target) })))) : null,
    todayRow ? todayLine(todayRow) : null);
}

/** «Утримання 95 ± 1 кг · у коридорі» — для картки середнього. */
function holdText() {
  const d = sum.toGo;
  const where = Math.abs(d) <= sum.band ? t('у коридорі')
    : d > 0 ? t('вище на {d}', { d: kg(d - sum.band, 1) }) : t('нижче на {d}', { d: kg(-d - sum.band, 1) });
  return t('Утримання {kg} ± {b} кг · {where}', { kg: fmt.fix(sum.target), b: fmt.fix(sum.band), where });
}

function statsGrid() {
  const s = sum;
  const g = s.goal;
  const tiles = [];
  // «До цілі» — уже в картці середнього (смужка і «ще …»), тут не повторюємо
  if (s.rate !== null) {
    // Крупно — темп за 4 тижні: ним рахується прогноз, і на плато він не хвалить загальним темпом
    const rate = s.recent ?? s.rate;
    const planOk = !s.hold && Number.isFinite(g.planRate) && rate >= g.planRate;
    // Зі знаком, як «За тиждень» і прогноз у калоріях: «−0,77» — худнете
    tiles.push(stat('speed', s.recent !== null ? t('Темп за 4 тиж.') : t('Темп'), `${fmt.signed(-rate, 2)} ${t('кг/тиж')}`,
      [rationRate !== null ? t('з раціону {r}', { r: fmt.signed(-rationRate, 2) }) : null,
        s.recent !== null ? t('від початку {r}', { r: fmt.signed(-s.rate, 2) }) : null,
        !s.hold && Number.isFinite(g.planRate) ? t('план {r}', { r: fmt.signed(-g.planRate, 2) }) : null].filter(Boolean).join(' · ') || null,
      planOk ? 'good' : !s.hold && rate <= 0 ? 'bad' : ''));
  }
  if (s.weekDelta !== null) {
    tiles.push(stat('trend', t('За тиждень'), kgd(s.weekDelta, 2), t('середнє до минулого тижня'), s.hold ? '' : trendClass(s.weekDelta)));
  }
  if (s.hold) {
    // На утриманні «від плану» — це від ваги цілі; добре — бути в коридорі, а не нижче
    tiles.push(stat('target', t('Від цілі'), kgd(s.toGo, 2), t('коридор ± {b} кг', { b: fmt.fix(s.band) }),
      Math.abs(s.toGo) <= s.band ? 'good' : 'bad'));
  } else if (s.planDiff !== null) {
    tiles.push(stat('route', t('Від плану'), kgd(s.planDiff, 2),
      s.planDiff < -0.005 ? t('випереджаєте') : s.planDiff > 0.005 ? t('відстаєте') : t('точно за планом'), trendClass(s.planDiff)));
  }
  // Скільки днів без нового мінімуму — щоб плато було видно заздалегідь, а не лише на 14-й день
  const low = !s.hold && !M.plateau(rows, goal.pauses) ? M.lastLow(rows, goal.pauses) : null;
  if (low) {
    tiles.push(stat('flag', t('Мінімум середнього'), kg(low.low, 2), low.days
      ? t('{n} з {p} дн. без нового', { n: low.days, p: M.PLATEAU_DAYS })
      : t('новий — сьогодні'), low.days ? '' : 'good', low.days ? plateauSteps(low.days, M.PLATEAU_DAYS) : null));
  }
  // Дата фінішу з прогнозом — у «Контрольних точках» рядком цілі; плитка лишається для «ціль досягнута» і «не знижується».
  // На утриманні фінішу немає
  if (!s.hold && s.toGo !== null && s.toGo <= 0) tiles.push(stat('trophy', t('Ціль'), t('досягнуто'), null, 'good'));
  else if (!s.hold && !s.finish && s.toGo !== null && s.rate !== null) {
    tiles.push(stat('flag', t('Прогноз фінішу'), '—', s.recent !== null ? t('за 4 тиж. вага не знижується') : t('вага не знижується'), 'bad'));
  }
  // Тиждень за раціоном — у рядку їжі (rationBadge); без позначених днів — «Днів записано»
  if (!rationWeek()) {
    tiles.push(stat('calendar-check', t('Днів записано'), fmt.int(s.days), g.startDate ? t('з {date}', { date: fmt.date(g.startDate) }) : null));
  }
  return h('div', { class: 'stats' }, tiles);
}

/** Тиждень за раціоном: скільки з позначених за 7 днів — за планом; без плану чи позначок — null. */
function rationWeek() {
  const wk = planOf(state) ? weekMarks(state, M.addDays(M.today(), -6), M.today()) : null;
  return wk?.marked ? wk : null;
}

/** «5 з 7 · 3 дн. без зриву» праворуч у рядку їжі: про харчування — поруч із харчуванням, а не окремою плиткою. */
function rationBadge() {
  const wk = rationWeek();
  if (!wk) return null;
  const n = streak(state);
  const note = wk.slip ? t('зривів: {n}', { n: wk.slip }) : n >= 2 ? t('{n} дн. без зриву', { n }) : t('за планом');
  const cls = wk.slip ? 'bad' : wk.ok === wk.marked ? 'good' : '';
  return h('span', { class: `food-week ${cls}`, 'aria-label': t('За раціоном за 7 днів: {a} з {b}, {note}', { a: wk.ok, b: wk.marked, note }) },
    h('b', { 'aria-hidden': 'true' }, t('{a} з {b}', { a: wk.ok, b: wk.marked })),
    h('span', { class: 'muted small', 'aria-hidden': 'true' }, note));
}

/** Плашка «Плато»: середнє давно не оновлює мінімум. */
/** Бот відкидає ключ — на головній, а не лише в налаштуваннях: інакше записи тихо не їдуть на інші пристрої. */
function keyNote() {
  if (!bot.keyProblem()) return null;
  return h('section', { class: 'plateau key-note' },
    h('div', { class: 'plateau-head' }, icon('warning'), h('b', {}, t('Ключ доступу не підходить'))),
    h('p', { class: 'small' }, t('Записи не йдуть на інші пристрої. Візьміть новий ключ командою /key у Telegram-боті й вставте в будь-якому застосунку — Хобі-план, Вага чи Марнотрат: решта на цьому пристрої візьмуть його самі, інші — з Google Диска.')),
    h('div', { class: 'btn-row' }, btn(t('Вставити ключ'), () => openSettings('sync'), 'primary')));
}

function plateauNote() {
  const p = M.plateau(rows, goal.pauses);
  if (!p || (sum.toGo !== null && sum.toGo <= 0)) return null;
  // На виду — що сталося, порада — по тапу
  return h('details', { class: 'plateau' },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon('warning'),
        h('b', {}, t('Плато {n} {days}', { n: p.days, days: plural(p.days, [t('день'), t('дні'), t('днів')]) }))),
      h('p', { class: 'small' }, t('Середнє з {date} не опускається нижче {kg}.', { date: fmt.date(p.since), kg: kg(p.low, 2) }))),
    h('p', { class: 'small' }, plateauAdvice(p)));
}

/** Порада на плато — з позначок раціону за час плато, а без них — загальна. */
function plateauAdvice(p) {
  const general = t('Зазвичай це вода й сіль, а не жир: перевірте порції й солодке, додайте кроків — і зачекайте ще тиждень.');
  if (!planOf(state)) return general;
  const f = periodFood(state, p.since, M.today());
  if (f.marked < f.days / 2) return [t('Позначено лише {n} з {d} днів за раціоном — причини з них не видно.', { n: f.marked, d: f.days }), ' ', general];
  // Вага стоїть — отже, з'їдене дорівнює витраті: це і є норма підтримки
  const en = energy(state, rows);
  const norm = en ? [' ', t('Зараз ви їсте ≈{k} ккал на день — на плато це і є ваша норма утримання.', { k: fmt.int(round10(en.intake)) })] : [];
  if (f.slip || f.extra > 0) {
    return [t('За час плато: зривів {s}, поза планом {k} ккал (≈{kg} кг). Схоже, річ у них — поверніться до плану.',
      { s: f.slip, k: fmt.int(f.extra), kg: fmt.fix(f.extra / 7700, 2) }), ...norm];
  }
  return [t('За час плато все за планом ({n} з {d} днів) — це вода, не жир. Нічого не урізайте, зачекайте ще тиждень.', { n: f.ok, d: f.days }), ...norm];
}

const round10 = (v) => Math.round(v / 10) * 10;
const round50 = (v) => Math.round(v / 50) * 50;
const kcalText = (v) => t('{n} ккал', { n: fmt.int(round10(v)) });

/** Ціль досягнута — запропонувати режим «Утримання» замість фінішу. */
function holdOffer() {
  if (sum.hold || sum.toGo === null || sum.toGo > 0) return null;
  return h('section', { class: 'plateau hold good' },
    h('div', { class: 'plateau-head' }, icon('trophy'), h('b', {}, t('Ціль досягнуто — тепер утримання?'))),
    h('p', { class: 'small' }, t('Вага цілі стане коридором ± {b} кг, а застосунок підказуватиме, коли додати чи прибрати калорії.', { b: fmt.fix(M.holdBand(goal)) })),
    h('div', { class: 'btn-row' }, btn(t('Перейти на утримання'), () => saveGoal({ mode: 'hold', holdFrom: M.today() }), 'primary')));
}

/**
 * Утримання: що з вагою за 14 днів і що робити з їжею. Скільки ккал додати чи прибрати — щоб зупинити
 * дрейф середнього і за 4 тижні повернутися в коридор.
 */
function holdNote() {
  if (!sum.hold || !sum.hasAvg) return null;
  const d = M.drift(rows);
  const over = sum.toGo - sum.band;
  const under = -sum.toGo - sum.band;
  const change = d?.change ?? 0;
  let kind = 'ok';
  if (over > 0) kind = change < -0.1 ? 'back' : 'up';
  else if (under > 0) kind = change > 0.1 ? 'back' : 'down';
  else if (change > M.DRIFT_KG) kind = 'up';
  else if (change < -M.DRIFT_KG) kind = 'down';
  const back = (gap) => (Math.max(0, gap) * M.KCAL_PER_KG) / 28;
  const fix = Math.max(100, round50(kind === 'up' ? Math.max(0, d?.kcal ?? 0) + back(over) : Math.max(0, -(d?.kcal ?? 0)) + back(under)));
  const moved = d ? t('За {n} дн. середнє {d} кг', { n: d.days, d: fmt.signed(d.change, 2) }) : t('Для тренду потрібно 2 тижні зважувань');
  const head = {
    ok: ['check', t('Вага тримається')],
    up: ['warning', t('Вага повзе вгору')],
    down: ['trend', t('Вага йде вниз')],
    back: ['trend', t('Повертаєтесь у коридор')],
  }[kind];
  const c = calories(state, rows, sum.goal, sum.current);
  const extra = planOf(state) && d ? periodFood(state, M.addDays(M.today(), -(d.days - 1)), M.today()).extra : 0;
  const advice = {
    ok: c?.intake ? t('Їжте як зараз: ≈{k} на день — це ваша норма утримання.', { k: kcalText(c.intake) })
      : t('Їжте як зараз — змінювати нічого не треба.'),
    up: [t('Приберіть ≈{k} на день: спершу їжу поза планом, солодке й соуси, далі — менше крупи чи хліба. Білок не урізайте.', { k: kcalText(fix) }),
      extra ? [' ', t('Поза планом за {n} дн.: {k} (≈{d} на день).', { n: d.days, k: kcalText(extra), d: kcalText(extra / d.days) })] : null],
    down: t('Можна додати ≈{k} на день: фрукт, порцію крупи чи білка — і подивитися тиждень.', { k: kcalText(fix) }),
    back: t('Так тримати — нічого не змінюйте, поки середнє не повернеться в коридор.'),
  }[kind];
  return h('details', { class: `plateau hold ${kind === 'ok' ? 'good' : ''}` },
    h('summary', {},
      h('div', { class: 'plateau-head' }, icon(head[0]), h('b', {}, head[1])),
      h('p', { class: 'small' }, moved)),
    h('p', { class: 'small' }, advice));
}

/** Дефіцит зі знаком, як на плитці: «760» — їсте менше норми, «+120» — більше. */
const deficitText = (d) => (d > 0 ? fmt.int(round10(d)) : fmt.signed(round10(d), 0));

const kcalFact = (label, value, sub, cls = '') => h('div', { class: `kcal-fact ${cls}` },
  h('span', { class: 'muted small' }, label), h('b', {}, value), sub ? h('span', { class: 'muted small' }, sub) : null);
const rateText = (r) => t('{d} кг/тиж', { d: fmt.signed(-r, 2) });

/** «поки за формулою · ще 4 дні» — скільки позначених днів лишилось до норми за вашими даними. */
function formulaSummary() {
  const n = energyLeft(state, rows);
  return n ? t('Як рахується норма · за формулою, ще {n} {d} «Як день?»', { n, d: plural(n, [t('день'), t('дні'), t('днів')]) })
    : t('Як рахується норма · поки за формулою');
}

/** Контрольні точки з датою «до», ще не пройдені: [{ c, d }] — від найближчої дати. */
function deadlines() {
  if (sum.hold) return [];
  return M.checkpoints(rows, goal, sum).map((c) => ({ c, d: M.deadline(sum, c) })).filter((x) => x.d)
    .sort((a, b) => (a.c.by < b.c.by ? -1 : 1));
}

const nextDeadline = () => deadlines().find((x) => !x.d.late) ?? null;

/** good — встигаєте темпом прогнозу; mid — лише темпом від початку раціону; bad — ні тим, ні тим. */
function deadlineKind({ c, d }) {
  const f = d.at(sum.forecastRate);
  const r = d.at(rationRate);
  if (f !== null && f <= c.kg) return 'good';
  return r !== null && r <= c.kg ? 'mid' : 'bad';
}

/**
 * «Встигаю до дати?» — найближча контрольна точка з датою: скільки треба на тиждень, де буде середнє
 * поточним темпом і темпом раціону, і скільки їсти, щоб встигнути.
 */
function deadlineBox() {
  const x = nextDeadline();
  if (!x) return null;
  const { c, d } = x;
  const kind = deadlineKind(x);
  const days = M.daysBetween(M.today(), c.by);
  const at = (r) => d.at(r);
  const head = {
    good: ['check', t('Встигаєте'), t('встигаєте')],
    mid: ['trend', t('Встигаєте, якщо тримати темп раціону'), t('з темпом раціону')],
    bad: ['warning', t('Поки не встигаєте'), t('не встигаєте')],
  }[kind];
  const atText = (v) => (v !== null ? t('≈{kg} на {date}', { kg: fmt.fix(v, 1), date: fmt.short(c.by) }) : null);
  const okCls = (v) => (v !== null && v <= c.kg ? 'good' : 'bad');
  const facts = h('div', { class: 'kcal-facts' },
    kcalFact(t('Потрібно'), rateText(d.need), t('{kg} кг за {n} {d}', { kg: fmt.fix(d.left, 1), n: days, d: plural(days, [t('день'), t('дні'), t('днів')]) })),
    sum.forecastRate !== null ? kcalFact(sum.recent !== null ? t('Темп за 4 тиж.') : t('Темп'), rateText(sum.forecastRate), atText(at(sum.forecastRate)), okCls(at(sum.forecastRate))) : null,
    rationRate !== null ? kcalFact(t('З раціону, з {date}', { date: fmt.short(rationFrom) }), rateText(rationRate), atText(at(rationRate)), okCls(at(rationRate))) : null);
  const cal = calories(state, rows, sum.goal, sum.current);
  const needKcal = (d.need * M.KCAL_PER_KG) / 7;
  const eat = cal ? cal.burn - needKcal : null;
  const walk = M.walkKcal(45, sum.current);
  const advice = [];
  if (eat !== null) {
    advice.push(t('Щоб встигнути: дефіцит ≈{d} на день — їсти ≈{e} при нормі {n}.', { d: kcalText(needKcal), e: kcalText(eat), n: kcalText(cal.burn) }),
      ' ', t('З прогулянкою 45 хв щодня (≈{w}) — ≈{e}.', { w: kcalText(walk), e: kcalText(eat + walk) }));
  }
  // Межі безпеки: понад 1 % ваги на тиждень чи їжа нижче 1500 (чоловіки) / 1200 (жінки) — краще відсунути дату чи ходити
  const floor = sum.goal.sex === 'f' ? 1200 : 1500;
  const warn = d.need > sum.current * 0.01 ? t('Це понад 1 % ваги на тиждень — швидше вже ризиковано. Краще відсунути дату.')
    : eat !== null && eat < floor ? t('Це менше {k} на день — так худнуть лише під наглядом лікаря. Краще додати ходьби або відсунути дату.', { k: kcalText(floor) }) : null;
  return box(withIcon('flag', c.isTarget ? t('Ціль {kg} до {date}', { kg: kg(c.kg), date: fmt.date(c.by) })
    : t('{kg} до {date}', { kg: kg(c.kg), date: fmt.date(c.by) })), h('div', { class: 'deadline' },
    h('div', { class: `deadline-head ${kind}` }, icon(head[0]), h('b', {}, head[1])),
    facts,
    advice.length ? h('p', { class: 'small deadline-advice' }, advice) : null,
    warn ? h('p', { class: 'small deadline-warn' }, warn) : null),
  {
    fold: 'deadline',
    count: h('span', { class: `deadline-badge ${kind}` }, head[2]),
    tools: [toolBtn('edit', t('Змінити'), () => openSettings(c.isTarget ? 'goal' : 'checkpoints'))],
  });
}

/**
 * Запас тижня (пн–нд): скільки ккал ще можна поза планом, щоб іти потрібним темпом — до найближчої дати,
 * а без неї — за планом. Дні тижня — з'їдене (минулі) чи план (решта); прогулянки — до норми свого дня.
 */
function weekBudget(c) {
  if (sum.hold || !planOf(state)) return null;
  const x = nextDeadline();
  const need = x ? x.d.need : sum.goal.planRate;
  if (!(need > 0)) return null;
  const daily = (need * M.KCAL_PER_KG) / 7;
  const from = M.weekStart(M.today());
  let room = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = M.addDays(from, i);
    const walk = c.source === 'formula' ? M.walkKcal(walkOf(state, d), sum.current) : 0;
    room += c.burn + walk - daily - (dayKcal(state, d) ?? 0);
  }
  const why = x ? t('{r} — щоб до {date} дійти до {kg}', { r: rateText(need), date: fmt.short(x.c.by), kg: kg(x.c.kg) })
    : t('{r} — за планом', { r: rateText(need) });
  // Понад 2 год ходьби до неділі — порада вже не до діла: тиждень не надолужити, з понеділка рахунок новий
  const minutes = room < 0 ? Math.ceil(-room / M.walkKcal(1, sum.current) / 5) * 5 : 0;
  const sunday = M.daysBetween(from, M.today()) === 6 || minutes > WALK_MAX;
  return h('div', { class: `kcal-week ${room >= 0 ? 'good' : 'bad'}` },
    h('div', { class: 'kcal-week-head' },
      h('span', { class: 'muted small' }, t('Запас тижня, пн–нд')),
      h('b', {}, room >= 0 ? t('+{k}', { k: kcalText(room) }) : t('перебір {k}', { k: kcalText(-room) }))),
    h('p', { class: 'muted small' }, room >= 0
      ? t('Стільки можна з\'їсти поза планом до неділі, і темп {why} збережеться.', { why })
      : sunday ? t('Цього тижня вже не надолужити — з понеділка рахунок новий. Не голодуйте. Темп {why}.', { why })
        : t('Надолужте прогулянками — ≈{m} хв до неділі, а не голодуванням. Темп {why}.', { m: minutes, why })));
}

const WALK_MAX = 120;

/** «Не так» без записаної їжі за 2 тижні — нагадати: такі дні рахуються як за планом. */
function missingNote() {
  if (!planOf(state)) return null;
  const list = unrecorded(state);
  if (!list.length) return null;
  return h('section', { class: 'plateau missing-note' },
    h('div', { class: 'plateau-head' }, icon('note'), h('b', {}, t('Не записано, що з\'їли'))),
    h('p', { class: 'small' }, t('Ці дні позначені «не так», але без продуктів — тому рахуються як за планом, і «Їсте» виходить менше, ніж насправді.')),
    h('div', { class: 'chips missing-days' }, list.map((d) => h('button', { type: 'button', onclick: () => daySheet(d) }, `${fmt.weekday(d)} ${fmt.short(d)}`))));
}

/** Талію міряємо раз на тиждень: минуло більше — нагадати на головній. */
const WAIST_EVERY = 7;
function waistNudge() {
  const last = M.waistSeries(state.waists).at(-1);
  if (!last) return null;
  const n = M.daysBetween(last.date, M.today());
  if (n < WAIST_EVERY) return null;
  return h('button', { type: 'button', class: 'panel kcal-prompt', onclick: () => waistForm() },
    icon('tape'),
    h('span', { class: 'food-line-main' }, h('b', {}, t('Пора виміряти талію')),
      h('span', { class: 'muted small' }, t('Останній замір {date} — {n} дн. тому. Раз на тиждень, уранці, по пупку.', { date: fmt.short(last.date), n }))),
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
}

/**
 * Плитки — за сьогодні: норма, скільки за планом сьогодні, дефіцит (на утриманні — баланс).
 * Під ними — середнє, з якого рахується прогноз: вага йде від того, що їсте в середньому, а не за один день.
 */
function caloriesBox() {
  if (!sum.hasAvg) return null;
  const c = calories(state, rows, sum.goal, sum.current);
  if (!c) {
    return h('button', { type: 'button', class: 'panel kcal-prompt', onclick: () => openSettings('body') },
      icon('speed'),
      h('span', { class: 'food-line-main' }, h('b', {}, t('Норма калорій')),
        h('span', { class: 'muted small' }, t('Вкажіть стать, рік народження й активність — порахую витрату і дефіцит'))),
      h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
  }
  const cell = (label, value, cls = '') => h('div', { class: `kcal-cell ${cls}` }, h('span', { class: 'muted small' }, label), h('b', {}, value));
  // Різниця — з показаних (округлених) чисел, щоб плитки сходилися: Сьогодні − Норма = Дефіцит
  const day = c.todayKcal !== null ? round10(c.todayKcal) - round10(c.burnToday) : null;
  const deficit = c.balance !== null ? -c.balance : null;
  const perWeek = deficit !== null ? (deficit * 7) / M.KCAL_PER_KG : null;
  const real = sum.recent ?? sum.rate;
  const cells = [
    cell(c.walkToday ? t('Норма з прогулянкою') : t('Норма'), fmt.int(round10(c.burnToday))),
    cell(t('Сьогодні'), c.todayKcal !== null ? fmt.int(round10(c.todayKcal)) : '—'),
    sum.hold
      ? cell(t('Баланс'), day !== null ? fmt.signed(round10(day), 0) : '—', day !== null && Math.abs(day) > 150 ? 'bad' : 'good')
      : cell(t('Дефіцит'), day !== null ? deficitText(-day) : '—', day !== null ? (day < 0 ? 'good' : 'bad') : ''),
  ];
  const f = c.f;
  const fact = kcalFact;
  // Зміна ваги зі знаком: «−0,63» — худнете, «+0,20» — набираєте
  const facts = perWeek === null ? null : h('div', { class: 'kcal-facts' },
    sum.hold
      ? fact(t('Баланс у середньому'), t('{d} кг/тиж', { d: fmt.signed(-perWeek, 2) }), t('мета — близько нуля'),
        Math.abs(perWeek) <= 0.1 ? 'good' : 'bad')
      : fact(t('Прогноз за калоріями'), t('{d} кг/тиж', { d: fmt.signed(-perWeek, 2) }), deficit >= 0 ? t('сер. дефіцит {k}', { k: fmt.int(round10(deficit)) }) : t('сер. понад норму {k}', { k: fmt.int(round10(-deficit)) })),
    real !== null ? fact(t('Насправді на вагах'), t('{d} кг/тиж', { d: fmt.signed(-real, 2) }),
      sum.recent !== null ? t('за останні 4 тижні') : t('за весь час')) : null);
  return box(withIcon('speed', t('Калорії на день')), h('div', { class: 'kcal' },
    h('div', { class: 'kcal-grid' }, cells),
    kcalBars(c),
    facts,
    weekBudget(c),
    c.intake === null ? h('p', { class: 'muted small' }, t('Скільки їсте — порахую за планом у «Раціоні».')) : null,
    // Як рахується норма — довідка, щодня не потрібна: згорнута, у заголовку лише звідки норма
    h('details', { class: 'about-more kcal-how' },
      h('summary', {}, c.source === 'real' ? t('Як рахується норма · за вашими даними') : formulaSummary()),
      h('p', { class: 'muted small' }, c.source === 'real'
        ? [t('Норма — за вашими даними: {n} позначених днів за {d} дн. і тренд ваги.', { n: c.en.marked, d: c.en.days }),
          f ? ` ${t('За формулою було б ≈{k}.', { k: kcalText(f.burn) })}` : null]
        : [t('Норма — за формулою Міффліна–Сан Жеора: вага {kg}, зріст {h} см, {a} р., активність {k}.',
          { kg: fmt.fix(f.kg, 1), h: fmt.int(sum.goal.height), a: f.age, k: numStr(f.activity) }),
        ' ', t('Коли за 4 тижні буде 14 позначених днів «Як день?», порахую за вашими даними.'),
        ' ', t('Прогулянки з «Як день?» додаються до норми свого дня; активність у налаштуваннях через них не міняйте — інакше порахуються двічі.')]))),
  { tools: [toolBtn('edit', t('Змінити'), () => openSettings('body'))] });
}

/**
 * Смужки «Сьогодні» і «Середнє» проти норми (bullet chart): довжина — скільки їсте, риска — норма,
 * понад норму — червоним. Числа поруч, тож колір не єдиний носій змісту.
 */
function kcalBars(c) {
  // Риска норми в кожної смужки своя: сьогодні — з сьогоднішньою прогулянкою, середнє — із середньою
  const list = [
    [t('Сьогодні'), c.todayKcal, c.burnToday],
    [c.source === 'real' ? t('Сер. 4 тиж.') : t('Сер. 7 дн.'), c.intake, c.burnWeek],
  ].filter(([, v]) => v !== null);
  if (!list.length) return null;
  const max = Math.max(...list.map(([, v, n]) => Math.max(v, n))) * 1.04;
  const pct = (v) => `${((v / max) * 100).toFixed(1)}%`;
  const bar = ([label, v, n]) => h('div', { class: 'kcal-bar' },
    h('span', { class: 'kcal-bar-label muted small' }, label),
    h('span', { class: 'kcal-track' },
      h('span', { class: `kcal-fill ${v > n ? 'to-norm' : ''}`, style: `width: ${pct(Math.min(v, n))}` }),
      v > n ? h('span', { class: 'kcal-over', style: `left: ${pct(n)}; width: ${pct(v - n)}` }) : null,
      h('span', { class: 'kcal-norm', style: `left: ${pct(n)}` })),
    h('b', { class: 'kcal-bar-value' }, fmt.int(round10(v))));
  const walks = c.walkToday || c.walkWeek;
  return h('div', {
    class: 'kcal-bars', role: 'img',
    'aria-label': [...list.map(([l, v, n]) => `${l}: ${kcalText(v)}, ${t('норма')} ${kcalText(n)}`)].join(', '),
  }, list.map(bar),
  h('div', { class: 'kcal-legend muted small', 'aria-hidden': 'true' }, h('span', { class: 'kcal-legend-norm' }),
    walks ? t('норма {k} + прогулянки', { k: kcalText(c.burn) }) : t('норма {k}', { k: kcalText(c.burn) })));
}

/** Тижневі стовпчики з підписом «5/7» — днів за планом із позначених. */
function weekBars() {
  // Тиждень, що ще триває, — напівпрозорий
  const last = rows.at(-1)?.date;
  const list = M.weeklyChanges(rows).map((b) => (b.to > last ? { ...b, partial: true } : b));
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
    h('span', {}, t('Тижні без зривів: {a} кг у середньому, зі зривами: {b} кг ({n1} і {n2} тиж.)', {
      a: fmt.signed(mean(clean), 2), b: fmt.signed(mean(slipped), 2), n1: clean.length, n2: slipped.length,
    })));
}

function checkpointsBox() {
  const list = M.checkpoints(rows, goal, sum);
  if (!list.length) return null;
  // Пройдену точку можна тапнути — святкування ще раз
  const won = new Map(milestones().map((m) => [m.id, m]));
  const replay = (c) => won.get(`${c.isTarget ? 'target' : 'cp'}:${c.kg}`);
  return box(withIcon('flag', t('Контрольні точки')), h('div', { class: 'rows' }, list.map((c) => h(replay(c) ? 'button' : 'div', {
    class: `row cp ${c.reached ? 'done' : ''}`,
    ...(replay(c) ? { type: 'button', onclick: () => party.play(replay(c)) } : {}),
  },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, kg(c.kg), c.isTarget ? h('span', { class: 'cp-target' }, t('ціль')) : null),
      c.note ? h('span', { class: 'muted small' }, c.note) : null,
      byLine(c)),
    h('div', { class: 'row-side' },
      c.reached ? h('span', { class: 'good cp-done' }, icon('check'), fmt.date(c.reached))
        : c.eta ? [h('span', {}, `≈ ${fmt.date(c.eta)}`), h('span', { class: 'muted small' }, weeksText(M.daysBetween(sum.currentDate, c.eta)))]
          : h('span', { class: 'muted' }, '—'))))),
  { tools: [toolBtn('edit', t('Змінити'), () => openSettings('checkpoints'))] });
}

/** «до 10.12 · треба −0,78 кг/тиж» під точкою з датою: зелене — встигаєте прогнозом, червоне — ні. */
function byLine(c) {
  if (!c.by) return null;
  if (c.reached) {
    return h('span', { class: `small ${c.reached <= c.by ? 'good' : 'muted'}` }, c.reached <= c.by ? t('до {date} — вчасно', { date: fmt.short(c.by) }) : t('планували до {date}', { date: fmt.short(c.by) }));
  }
  const d = M.deadline(sum, c);
  if (!d) return null;
  if (d.late) return h('span', { class: 'small bad' }, t('не встигли до {date}', { date: fmt.short(c.by) }));
  const kind = deadlineKind({ c, d });
  return h('span', { class: `small ${kind === 'good' ? 'good' : kind === 'bad' ? 'bad' : ''}` },
    t('до {date} · треба {r}', { date: fmt.short(c.by), r: rateText(d.need) }));
}

function weeksText(days) {
  if (days < 14) return t('через {n} {d}', { n: days, d: plural(days, [t('день'), t('дні'), t('днів')]) });
  const w = Math.round(days / 7);
  return t('через {n} тиж.', { n: w });
}

const BMI_MIN = 15;
const BMI_MAX = 45;

function bmiBox() {
  const b = sum.bmi;
  if (!b) {
    return box(withIcon('person', t('ІМТ')), h('div', {},
      h('p', { class: 'muted small' }, t('Індекс маси тіла = вага ÷ зріст². Вкажіть зріст — і він рахуватиметься за середньою вагою.')),
      btn(t('Вказати зріст'), () => openSettings('body'))));
  }
  const at = (v) => `${((Math.min(BMI_MAX, Math.max(BMI_MIN, v)) - BMI_MIN) / (BMI_MAX - BMI_MIN)) * 100}%`;
  return box(withIcon('person', t('ІМТ')), h('div', { class: 'bmi' },
    h('div', { class: 'bmi-head' }, h('b', { class: 'bmi-value' }, fmt.fix(b.value, 1)), h('span', {}, t(b.label))),
    h('div', { class: 'bmi-scale', 'aria-hidden': 'true' },
      M.BMI_CLASSES.slice(0, -1).map(([v]) => h('span', { class: 'bmi-tick', style: `left:${at(v)}` }, h('i', {}, fmt.fix(v, v % 1 ? 1 : 0)))),
      h('span', { class: 'bmi-mark', style: `left:${at(b.value)}` })),
    b.nextKg ? h('p', { class: 'muted small' }, t('До «{label}» — {kg} ({d})', { label: t(b.nextLabel), kg: kg(b.nextKg), d: fmt.signed(b.nextKg - sum.current, 1) })) : null,
    h('p', { class: 'muted small' }, t('За середнім за 7 днів і зростом {h} см. Категорії ВООЗ; ІМТ не враховує м’язи й статуру.', { h: fmt.int(sum.goal.height) }))));
}

function renderHome() {
  if (!rows.length) {
    // Заголовок і значок уже є у формі запису вище — тут лише підказка
    return h('div', {}, keyNote(), quickEntry(), empty(null, null,
      t('Записуйте вагу щоранку — середнє за 7 днів, темп і прогноз порахуються самі. Уже вели облік на іншому пристрої — підключіть Google Диск у налаштуваннях.'),
      btn(withIcon('cloud', t('Підключити Google Диск')), () => openSettings('drive'))));
  }
  const todayRow = rows.find((r) => r.date === M.today());
  return h('div', {},
    keyNote(),
    todayRow ? null : quickEntry(),
    hero(todayRow),
    weightHint(state, todayRow),
    missingNote(),
    sum.hold ? holdNote() : [plateauNote(), holdOffer()],
    deadlineBox(),
    homeLine(state, rationBadge()),
    statsGrid(),
    caloriesBox(),
    sum.hold ? null : checkpointsBox(),
    waistNudge());
}

// ---------- графік ----------

const PERIODS = [['7', 'Тиждень'], ['30', 'Місяць'], ['90', '3 місяці'], ['all', 'Усе']];
/** Серії, вимкнені тапом по легенді, — пам'ятаються на пристрої. */
const HIDDEN_KEY = 'weight-log:hidden-series';
function hiddenSeries() {
  try {
    const v = JSON.parse(recall(HIDDEN_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    // До 0.1.12 заливка вимикалась окремо — тепер вона йде за планом
    return [...v.filter((k) => k !== 'gap' && k !== 'planAhead'), ...(v.includes('plan') ? ['gap', 'planAhead'] : [])];
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

/** День уже на утриманні: лінія плану там — вага цілі. */
const onHold = (date) => sum.hold && Boolean(sum.goal.holdFrom) && date >= sum.goal.holdFrom;

function dayTip(date) {
  const r = rows.find((x) => x.date === date);
  if (!r) return [];
  const plan = M.planAt(sum.goal, date);
  return [
    `${fmt.date(date)}, ${fmt.weekday(date)}`,
    `${t('Вага')}: ${kg(r.kg)}`,
    r.avg !== null ? `${t('Середнє')}: ${kg(r.avg, 2)}` : null,
    plan !== null ? `${onHold(date) ? t('Ціль') : t('План')}: ${kg(plan, 2)}` : null,
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
        r.day !== null ? [' ', h('span', { class: `small ${trendClass(r.day)}` }, t('за добу {d}', { d: fmt.signed(r.day) }))] : null),
      h('div', { class: 'chart-chips' },
        r.avg !== null ? h('span', { class: 'stat-chip' }, t('сер. {v}', { v: fmt.fix(r.avg, 2) })) : null,
        plan !== null && r.avg !== null ? h('span', { class: `stat-chip ${trendClass(r.avg - plan)}` },
          t(onHold(date) ? 'від цілі {d}' : 'план {d}', { d: fmt.signed(r.avg - plan, 2) })) : null),
      r.note ? h('div', { class: 'row-note' }, icon('note'), h('span', {}, r.note)) : null),
    toolBtn('edit', t('Змінити'), () => weightForm(date)));
}

/** Рядок над графіком: зміна за видимий період крупно, мінімум і максимум ваги. */
function periodLine(a, b) {
  const st = M.periodStats(rows, a, b);
  if (!st) return [];
  return [
    st.change !== null ? h('span', { class: `chart-change ${trendClass(st.change)}` }, kgd(st.change, Math.abs(st.change) < 1 ? 2 : 1)) : null,
    st.change !== null ? h('span', { class: 'muted small' }, t('за період')) : null,
    h('span', { class: 'muted small chart-range' }, `${t('мін {v}', { v: fmt.fix(st.min) })} · ${t('макс {v}', { v: fmt.fix(st.max) })}`),
  ].filter(Boolean);
}

/** Пігулки над графіком: скільки до цілі й наскільки середнє від плану. */
function chartChips() {
  const last = rows.at(-1);
  const plan = M.planAt(sum.goal, last.date);
  // На утриманні план — вага цілі, «від плану» = від цілі, і добре — бути в коридорі
  const chips = sum.hold ? [
    h('span', { class: 'stat-chip' }, t('утримання {kg} ± {b}', { kg: fmt.fix(sum.target), b: fmt.fix(sum.band) })),
    last.avg !== null ? h('span', { class: `stat-chip ${Math.abs(last.avg - sum.target) <= sum.band ? 'good' : 'bad'}` }, t('від цілі {d}', { d: fmt.signed(last.avg - sum.target, 2) })) : null,
  ] : [
    sum.target !== null ? h('span', { class: 'stat-chip' }, t('ціль {kg} · ще {d}', { kg: fmt.fix(sum.target), d: fmt.fix(Math.max(0, sum.toGo ?? 0), 1) })) : null,
    plan !== null && last.avg !== null ? h('span', { class: `stat-chip ${trendClass(last.avg - plan)}` }, t('від плану {d}', { d: fmt.signed(last.avg - plan, 2) })) : null,
    plan !== null && last.avg !== null ? catchUpChip(last.avg - plan, last.date) : null,
  ];
  const list = chips.filter(Boolean);
  return list.length ? h('div', { class: 'chart-chips' }, list) : null;
}

/**
 * Відстаєте від плану — коли середнє його наздожене темпом прогнозу (перетин двох прямих),
 * а якщо темп повільніший за план — який темп треба, щоб наздогнати за 4 тижні.
 * ponytail: паузи попереду не враховано — дата перетину з ними буде пізніша.
 */
function catchUpChip(gap, date) {
  const pr = sum.goal.planRate;
  if (!(gap > 0.05) || !Number.isFinite(pr)) return null;
  const closing = (sum.forecastRate ?? 0) - pr;
  const days = closing > 0 ? Math.round((gap / closing) * 7) : Infinity;
  if (days <= 180) return h('span', { class: 'stat-chip' }, t('у план ≈ {date}', { date: fmt.short(M.addDays(date, days)) }));
  return h('span', { class: 'stat-chip' }, t('наздогнати за міс. — {r} кг/тиж', { r: fmt.fix(pr + gap / 4, 1) }));
}

/** Зміна за кожен день — стовпчики під графіком на «Тиждень», де тижневих було б 1–2. */
function dayBars() {
  return rows.filter((r) => r.day !== null).map((r) => ({ from: r.date, to: r.date, v: r.day }));
}

function renderChart() {
  if (!rows.length) return empty('chart', t('Поки нічого показати'), t('Запишіть вагу — і тут з’явиться графік.'));
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
  // На утриманні лінія — лише вага цілі від дня переходу, без обриву зі старого плану
  const plan = rows.filter((r) => !sum.hold || onHold(r.date)).map((r) => ({ date: r.date, v: M.planAt(g, r.date) })).filter((p) => p.v !== null);
  // План далі за сьогодні — поруч із прогнозом, щоб видно, чи сходяться
  const planAhead = Array.from({ length: peek + 1 }, (_, i) => M.addDays(lastDate, i)).map((date) => ({ date, v: M.planAt(g, date) })).filter((p) => p.v !== null);
  const marks = M.checkpoints(rows, goal, sum).map((c) => ({ v: c.kg, label: c.isTarget ? t('ціль') : fmt.int(c.kg), cls: c.isTarget ? 'target' : 'cp' }));
  const day = picked && rows.some((r) => r.date === picked) ? picked : lastDate;
  // Точка зважування — кольором того, як минув учора раціон
  const after = afterStatus(state);
  const details = h('div', {}, dayLine(day));
  // Заливка між середнім і планом: зелена — середнє нижче плану (випереджаєте), червона — вище
  const planOn = new Map(plan.map((p) => [p.date, p.v]));
  const ahead = rows.filter((r) => r.avg !== null && planOn.has(r.date)).map((r) => ({ date: r.date, a: r.avg, b: planOn.get(r.date) }));
  const st = M.periodStats(rows, vis[0].date, lastDate);
  const lastAvg = rows.at(-1).avg;
  const summary = [
    t('Графік ваги'),
    st?.change != null ? `${t('за період')} ${kgd(st.change)}` : null,
    lastAvg !== null ? t('сер. {v}', { v: fmt.fix(lastAvg, 2) }) : null,
    lastAvg !== null && planOn.has(lastDate) ? t('від плану {d}', { d: fmt.signed(lastAvg - planOn.get(lastDate), 2) }) : null,
  ].filter(Boolean).join(', ');
  const chart = lineChart({
    series: [
      { key: 'gap', kind: 'band', cls: 's-gap', points: ahead },
      { key: 'plan', kind: 'line', cls: 's-plan', points: plan },
      { key: 'planAhead', kind: 'line', cls: 's-plan', points: plan.length > 1 ? planAhead : [], aside: true },
      { key: 'kg', kind: 'dots', cls: 's-kg', points: rows.map((r, i) => ({ date: r.date, v: r.kg, ring: Boolean(r.note), last: i === rows.length - 1, cls: after.get(r.date) ?? null })) },
      { key: 'avg', kind: 'line', cls: 's-avg', points: rows.filter((r) => r.avg !== null).map((r) => ({ date: r.date, v: r.avg })), endLabel: true },
      { key: 'forecast', kind: 'line', cls: 's-forecast', points: forecast, aside: true },
    ],
    height: 260,
    zoom: true,
    view,
    home,
    ahead: peek,
    onView: (a, b) => { chartView = [a, b]; showRange(a, b); },
    resetLabel: t('Скинути'),
    hlines: marks,
    gap: { of: 'avg', to: 'plan', label: sum.hold ? t('від цілі') : t('план') },
    summary,
    bars: period === '7' ? dayBars() : weekBars(),
    spans: (goal.pauses ?? []).map((p) => ({ from: p.from, to: p.to, label: t('пауза'), cls: 'pause' })),
    vlines: rationFrom ? [{ date: rationFrom, label: t('раціон'), cls: 'ration' }] : [],
    barsLabel: period === '7' ? t('доба') : t('тиж.'),
    legend: [
      { label: t('Вага'), kind: 'dot', cls: 's-kg', keys: ['kg'] },
      { label: t('Середнє'), kind: 'line', cls: 's-avg', keys: ['avg'] },
      // Заливка без плану сенсу не має — вмикається й вимикається разом із ним; дата фінішу — в «Контрольних точках»
      plan.length ? { label: sum.hold ? t('Ціль') : t('План'), kind: 'line dash', cls: 's-plan', keys: ['plan', 'gap', 'planAhead'] } : null,
      finish ? { label: t('прогноз'), kind: 'line dash', cls: 's-forecast', keys: ['forecast'] } : null,
      vis.some((r) => r.note) ? { label: t('нотатка'), kind: 'ring', cls: 's-kg' } : null,
      ...['ok', 'off', 'slip'].filter((k) => vis.some((r) => after.get(r.date) === k)).map((k) => ({ label: t(STATUS[k]), kind: 'dot', cls: `s-kg ${k}` })),
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
  const add = btn(withIcon('plus', t('Замір талії')), () => waistForm());
  if (!ws.length) {
    return box(withIcon('tape', t('Талія')), h('div', {}, h('p', { class: 'muted small' }, t('Талія йде разом з вагою — замір раз на тиждень, уранці, по пупку.')), add));
  }
  const last = ws.at(-1);
  return box(withIcon('tape', t('Талія')), h('div', {},
    h('div', { class: 'waist-head' }, h('b', {}, `${fmt.fix(last.cm)} ${t('см')}`),
      last.change !== null ? h('span', { class: trendClass(last.change) }, t('{d} см від {date}', { d: fmt.signed(last.change), date: fmt.date(ws[0].date) })) : null),
    ws.length > 1 ? lineChart({
      series: [{ key: 'cm', kind: 'line', cls: 's-waist', points: ws.map((w) => ({ date: w.date, v: w.cm })) },
        { key: 'cmd', kind: 'dots', cls: 's-waist', points: ws.map((w) => ({ date: w.date, v: w.cm })) }],
      height: 150,
      tip: (date) => { const w = ws.find((x) => x.date === date); return w ? [fmt.date(date), `${fmt.fix(w.cm)} ${t('см')}`] : []; },
    }) : null,
    add));
}

// ---------- журнал ----------

const LOG_SEGS = [['weight', 'Вага'], ['waist', 'Талія'], ['sizes', 'Розміри'], ['health', 'Здоров\'я']];
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
    actions: [btn(t('Зберегти'), save, 'primary')],
  });
}

/**
 * Розміри на дату. Без snap — нові розміри: змінилися проти попереднього знімка — лягає знімок sizes:<дата>,
 * а поточні (sizes) — завжди останній за датою. Зі snap — правка чи видалення знімка з історії.
 */
function sizesForm(snap = null) {
  const snaps = M.sizeSnapshots(state.settings);
  const f = form([{ name: 'date', label: t('На дату'), type: 'dmy', value: snap?.date ?? M.today(), required: true }]);
  const input = h('textarea', { rows: 12, autocomplete: 'off', placeholder: t('Рукавиці L\nВзуття 43/44, устілка 28,5 см\nГолова 59 см') });
  input.value = snap ? snap.text : settingText(M.SIZES_ID);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const { date } = f.values();
    const text = input.value.split('\n').map((s) => s.trimEnd()).join('\n').trim();
    sync.renewOnGesture();
    close();
    const others = snaps.filter((s) => s.id !== null && s.id !== snap?.id && s.date !== date);
    const put = [];
    // Перший запис із датою: старий текст без знімка стає першим знімком історії
    const legacy = snap ? null : snaps.find((s) => s.id === null);
    if (legacy && legacy.date < date) { put.push({ id: M.SIZES_PREFIX + legacy.date, text: legacy.text }); others.push(legacy); }
    const prev = others.filter((s) => s.date < date).at(-1);
    const keep = !prev || !M.sameSizes(prev.text, text) || snaps.some((s) => s.id && s.date === date) || snap;
    if (keep) put.push({ id: M.SIZES_PREFIX + date, text });
    const del = snap?.id && snap.date !== date ? [snap.id] : [];
    const latest = [...others, ...(keep ? [{ date, text }] : [])].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
    if (latest) put.push({ id: M.SIZES_ID, text: latest.text });
    await db.write({ settings: { put, del } });
    toast(t('Розміри збережено'));
  };
  const remove = async () => {
    close();
    const rest = snaps.filter((s) => s.id && s.id !== snap.id);
    const before = snapshot('settings', [snap.id, M.SIZES_ID]);
    await db.write({ settings: { put: rest.length ? [{ id: M.SIZES_ID, text: rest.at(-1).text }] : [], del: [snap.id] } });
    undoToast(t('Розміри на {date} видалено', { date: fmt.date(snap.date) }), 'settings', before);
  };
  const close = sheet(snap ? t('Розміри на {date}', { date: fmt.date(snap.date) }) : t('Мої розміри'), h('div', { class: 'form' },
    f.el,
    h('label', { class: 'field' }, input, h('small', { class: 'muted' },
      t('Рядок — один розмір: назва, потім значення. Змінилося — збережіть з новою датою, попереднє лишиться в історії.')))), {
    tools: snap?.id ? [toolBtn('delete', t('Видалити'), remove, 'danger')] : [],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

/** Історія одного розміру: коли яке значення. */
function sizeSheet(s) {
  sheet(s.label, h('div', { class: 'rows' }, s.history.map((x, i) => h('div', { class: 'row log-row' },
    h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.value)),
    h('div', { class: 'row-side' }, h('span', { class: i ? 'muted' : '' }, i ? t('з {date}', { date: fmt.date(x.date) }) : t('зараз, з {date}', { date: fmt.date(x.date) })))))), {
    actions: [btn(t('Змінити розміри'), () => sizesForm(), 'primary')],
  });
}

/** Усі знімки розмірів: тап — правка чи видалення. */
function sizeSnapsSheet() {
  const close = sheet(t('Історія розмірів'), h('div', { class: 'rows' }, M.sizeSnapshots(state.settings).reverse().map((s) => h('button', {
    type: 'button', class: 'row log-row', onclick: () => { close(); sizesForm(s); },
  },
    h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, fmt.date(s.date))),
    h('div', { class: 'row-side' }, h('span', { class: 'muted' }, t('розмірів: {n}', { n: M.parseSizes(s.text).length })))))));
}

const healthForm = () => textForm(M.HEALTH_ID, {
  title: t('Здоров\'я'),
  hint: t('Діагнози, операції, уколи — як зручно. Рядок з 🔹 або двокрапкою в кінці стане заголовком.'),
  placeholder: t('🔹 Хребет:\nГрижа L5–S1\nОперація 2010\n\nДіабет 2 типу'),
  saved: t('Збережено'),
  rows: 16,
});

/** Текст діагнозів як є: рядки з 🔹 чи двокрапкою в кінці — заголовки, порожній рядок — відступ. */
function renderHealth(seg) {
  const lines = settingText(M.HEALTH_ID).split('\n');
  $('subtitle').textContent = '';
  if (!lines.some((l) => l.trim())) {
    return h('div', {}, seg, empty('heart', t('Записів немає'),
      t('Діагнози, операції, хронічні болячки — щоб були під рукою в лікаря.'),
      btn(withIcon('plus', t('Записати')), healthForm)));
  }
  return h('div', {}, seg, h('button', { type: 'button', class: 'panel health', onclick: healthForm },
    lines.map((l) => {
      const s = l.trim();
      if (!s) return h('div', { class: 'health-gap' });
      return /^🔹|:$/u.test(s) ? h('h4', {}, s.replace(/^🔹\s*/u, '')) : h('p', {}, s);
    })));
}

function renderSizes(seg) {
  const snaps = M.sizeSnapshots(state.settings);
  const list = M.sizeHistory(settingText(M.SIZES_ID), snaps);
  $('subtitle').textContent = t('розмірів: {n}', { n: list.length });
  if (!list.length) {
    return h('div', {}, seg, empty('tape', t('Розмірів немає'),
      t('Рукавиці, взуття, одяг, каблучка — щоб завжди були під рукою в магазині.'),
      btn(withIcon('plus', t('Вказати розміри')), () => sizesForm())));
  }
  // Змінився — під значенням попереднє і з якої дати нове; тап — уся історія розміру
  const was = (s) => (s.history.length > 1 && s.history[0].value === s.value
    ? t('було {v} · з {date}', { v: s.history[1].value, date: fmt.date(s.history[0].date) }) : null);
  // Довге значення — під назвою на всю ширину, а не притиснуте вправо в кілька рядків
  return h('div', {}, seg,
    h('div', { class: 'rows sizes' }, list.map((s) => h('button', {
      type: 'button', class: `row log-row ${s.value?.length > 16 ? 'stacked' : ''}`,
      onclick: () => (s.history.length > 1 ? sizeSheet(s) : sizesForm()),
    },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, s.label), was(s) ? h('span', { class: 'muted small' }, was(s)) : null),
      s.value ? h('div', { class: 'row-side' }, h('span', { class: 'size-value' }, s.value)) : null))),
    snaps.length ? h('div', { class: 'btn-row' },
      btn(withIcon('calendar', t('Історія · {n}', { n: snaps.length })), sizeSnapsSheet),
      btn(withIcon('edit', t('Змінити розміри')), () => sizesForm())) : null);
}

/** Підсумок місяця за раціоном для заголовка: «✓ 18 · ✕ 2». */
function monthFood(list) {
  const marks = list.map((r) => dayOf(state, r.date)?.status).filter(Boolean);
  if (!marks.length) return null;
  const n = (k) => marks.filter((x) => x === k).length;
  return t('за планом {ok} · зривів {slip}', { ok: n('ok'), slip: n('slip') });
}

/** День у «Журналі»: зважування (чи «без зважування») і під ним — як минув день за раціоном. */
function weightRow(r, norm) {
  const weighed = r.kg !== null;
  const food = journalDay(state, r.date, norm);
  return h('div', { class: `log-day ${food ? 'has-food' : ''}` },
    h('button', { type: 'button', class: 'row log-row', onclick: () => weightForm(r.date) },
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, fmt.short(r.date), h('span', { class: 'muted' }, ` · ${fmt.weekday(r.date)}`)),
        weighed ? h('span', { class: 'muted small' }, [
          r.avg !== null ? t('сер. {v}', { v: fmt.fix(r.avg, 2) }) : null,
          r.delta !== null ? t('тиж. {v}', { v: fmt.signed(r.delta, 2) }) : null,
        ].filter(Boolean).join(' · ')) : null,
        r.note ? h('span', { class: 'row-note' }, icon('note'), h('span', {}, r.note)) : null),
      h('div', { class: 'row-side' },
        weighed ? h('span', { class: 'row-kg' }, fmt.fix(r.kg)) : h('span', { class: 'muted small' }, t('без зважування')),
        weighed && r.day !== null ? h('span', { class: `small ${trendClass(r.day)}` }, fmt.signed(r.day)) : null)),
    food);
}

function renderLog() {
  const seg = segmented(LOG_SEGS.map(([k, l]) => [k, t(l)]), logSeg, (v) => { logSeg = v; remember('weight-log:log-seg', v); render(); });
  if (logSeg === 'sizes') return renderSizes(seg);
  if (logSeg === 'health') return renderHealth(seg);
  if (logSeg === 'waist') {
    const ws = M.waistSeries(state.waists).reverse();
    $('subtitle').textContent = t('замірів: {n}', { n: ws.length });
    return h('div', {}, seg, ws.length
      ? h('div', { class: 'rows' }, ws.map((w) => h('button', { type: 'button', class: 'row log-row', onclick: () => waistForm(state.waists.find((x) => x.id === w.id)) },
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, fmt.date(w.date))),
        h('div', { class: 'row-side' }, h('span', { class: 'row-kg' }, `${fmt.fix(w.cm)} ${t('см')}`),
          w.prev !== null ? h('span', { class: `small ${trendClass(w.prev)}` }, fmt.signed(w.prev)) : null))))
      : empty('tape', t('Замірів немає'), t('Натисніть «+», щоб записати обхват талії.')));
  }
  $('subtitle').textContent = t('записів: {n}', { n: rows.length });
  if (!rows.length) return h('div', {}, seg, empty('journal', t('Журнал порожній'), t('Натисніть «+», щоб записати вагу.')));
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
  // Норма — та сама, що на головній; минулі дні міряються нинішньою нормою
  const norm = normOf();
  const normHint = norm ? h('p', { class: 'muted small log-norm' }, norm.walk
    ? t('Дефіцит дня — від норми {k} на день, як на головній, плюс прогулянка того дня.', { k: kcalText(norm.kcal) })
    : t('Дефіцит дня — від норми {k} на день, як на головній.', { k: kcalText(norm.kcal) })) : null;
  return h('div', {}, seg, normHint, [...months].map(([ym, list]) => {
    const ws = list.filter((r) => r.kg !== null);
    const avg = ws.length ? ws.reduce((s, r) => s + r.kg, 0) / ws.length : null;
    // Зміна за місяць — за середньою вагою: крайні зважування гуляють на ±1 кг через воду
    const avgs = ws.filter((r) => r.avg !== null);
    const change = avgs.length > 1 ? avgs[0].avg - avgs.at(-1).avg : null;
    return fold(`log:${ym}`, [
      h('span', { class: 'fold-stack' }, h('span', { class: 'fold-title' }, fmt.month(ym)),
        h('span', { class: 'fold-meta' }, [
          avg !== null ? t('{n} зваж. · сер. {v}', { n: ws.length, v: fmt.fix(avg, 1) }) : null,
          monthFood(list),
        ].filter(Boolean).join(' · '))),
      change !== null ? h('span', { class: `fold-sum ${trendClass(change)}` }, fmt.signed(change)) : null,
    ], () => h('div', { class: 'rows' }, list.map((r) => weightRow(r, norm))));
  }));
}

// ---------- налаштування ----------

async function saveGoal(patch) {
  const { pauses, ...g } = goal;
  await db.write({ settings: { put: [{ ...g, ...patch, id: M.GOAL_ID }] } });
}

function goalRow() {
  const g = M.effectiveGoal(goal, rows);
  const f = form([
    { name: 'mode', label: t('Режим'), type: 'select', value: M.isHold(g) ? 'hold' : 'lose', options: [['lose', t('Схуднення')], ['hold', t('Утримання')]] },
    { name: 'start', label: t('Стартова вага, кг'), type: 'number', value: numStr(g.start), half: true, min: 20, max: 400 },
    { name: 'startDate', label: t('Дата старту'), type: 'dmy', value: g.startDate ?? '', half: true },
    { name: 'target', label: t('Ціль, кг'), type: 'number', value: numStr(g.target), half: true, min: 20, max: 400 },
    { name: 'planRate', label: t('План, кг/тиж'), type: 'number', value: numStr(g.planRate), half: true, min: 0, max: 3 },
    { name: 'targetBy', label: t('Ціль до дати (необов’язково)'), type: 'dmy', value: g.targetBy ?? '' },
    { name: 'holdBand', label: t('Коридор утримання, ± кг'), type: 'number', value: numStr(M.holdBand(g)), min: 0.3, max: 5 },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    if (v.mode === 'hold' && v.target === null) { toast(t('Для утримання вкажіть ціль — вагу, якої триматися')); return; }
    // День переходу на утримання — з нього план стає рівною лінією на вазі цілі
    const holdFrom = v.mode === 'hold' ? (M.isHold(g) && g.holdFrom ? g.holdFrom : M.today()) : undefined;
    await saveGoal({
      mode: v.mode, holdFrom, holdBand: v.holdBand ?? undefined,
      start: v.start ?? undefined, startDate: v.startDate || undefined, target: v.target ?? undefined, planRate: v.planRate ?? undefined,
      targetBy: v.targetBy || undefined,
    });
    toast(t('Ціль збережено'));
  };
  return setRow('goal', 'target', t('Ціль'), !g.target ? t('Не задана')
    : M.isHold(g) ? t('утримання {kg} ± {b}', { kg: fmt.fix(g.target), b: fmt.fix(M.holdBand(g)) }) : kg(g.target), [
    h('p', { class: 'muted small' }, t('План — лінія на графіку: від стартової ваги рівно по «кг/тиж». Без стартової ваги береться перше зважування.')),
    h('p', { class: 'muted small' }, t('Утримання — коли ціль досягнуто: план стає рівною лінією на вазі цілі, а на головній — порада, додати чи прибрати калорії, щоб лишитися в коридорі.')),
    f.el, h('div', { class: 'btn-row' }, btn(t('Зберегти'), save, 'primary'))]);
}

/** Зріст, стать, рік народження й активність — для ІМТ і норми калорій за формулою. */
function bodyRow() {
  const g = goal;
  const f = form([
    { name: 'height', label: t('Зріст, см'), type: 'number', value: numStr(g.height), half: true, min: 100, max: 250 },
    { name: 'birthYear', label: t('Рік народження'), type: 'number', value: numStr(g.birthYear), half: true, min: 1900, max: Number(M.today().slice(0, 4)) - 10 },
    { name: 'sex', label: t('Стать'), type: 'select', value: g.sex ?? '', options: [['', '—'], ['m', t('Чоловіча')], ['f', t('Жіноча')]] },
    { name: 'activity', label: t('Активність'), type: 'select', value: g.activity ?? M.ACTIVITY[0][0], options: M.ACTIVITY.map(([k, l]) => {
      const [title, hint] = t(l).split(/:\s*/);
      return [k, `${numStr(k)} — ${title}`, hint];
    }) },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    await saveGoal({ height: v.height ?? undefined, birthYear: v.birthYear ?? undefined, sex: v.sex || undefined, activity: Number(v.activity) });
    toast(t('Збережено'));
  };
  const fb = M.formulaBurn(g, sum.current, M.today());
  return setRow('body', 'person', t('Норма калорій'), fb ? t('≈{k} на день', { k: kcalText(fb.burn) }) : t('Не задана'), [
    h('p', { class: 'muted small' }, t('Витрата за формулою Міффліна–Сан Жеора від середньої ваги за 7 днів. Коли за 4 тижні буде 14 позначених днів «Як день?», норма рахується за вашими даними: скільки з\'їли і як змінилася вага.')),
    f.el, h('div', { class: 'btn-row' }, btn(t('Зберегти'), save, 'primary'))]);
}

function checkpointsRow() {
  const list = [...(goal.checkpoints ?? [])].sort((a, b) => b.kg - a.kg);
  const kgInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: t('кг'), autocomplete: 'off', class: 'cp-kg' });
  const noteInput = h('input', { type: 'text', placeholder: t('що означає (необов’язково)'), autocomplete: 'off' });
  const add = async () => {
    const v = parseNum(kgInput.value);
    if (!Number.isFinite(v) || v < 20 || v > 400) { toast(t('Введіть вагу в кілограмах')); return; }
    await saveGoal({ checkpoints: [...(goal.checkpoints ?? []), { id: db.uid(), kg: v, note: noteInput.value.trim() }] });
  };
  const remove = (c) => saveGoal({ checkpoints: (goal.checkpoints ?? []).filter((x) => x.id !== c.id) });
  return setRow('checkpoints', 'flag', t('Контрольні точки'), list.length ? fmt.int(list.length) : '', [
    h('p', { class: 'muted small' }, t('Проміжні ваги на шляху до цілі: для кожної — прогнозна дата за фактичним темпом. Сама ціль додається до списку автоматично.')),
    h('p', { class: 'muted small' }, t('Натисніть на точку, щоб задати дату «до» — на головній з’явиться, чи встигаєте і скільки для цього їсти.')),
    list.length ? h('div', { class: 'rows cp-list' }, list.map((c) => h('div', { class: 'row' },
      h('button', { type: 'button', class: 'row-main cp-edit', onclick: () => checkpointForm(c) },
        h('span', { class: 'row-title' }, kg(c.kg)),
        c.note ? h('span', { class: 'muted small' }, c.note) : null,
        h('span', { class: 'muted small' }, c.by ? t('до {date}', { date: fmt.date(c.by) }) : t('без дати'))),
      toolBtn('delete', t('Видалити'), () => remove(c), 'danger')))) : null,
    h('div', { class: 'cp-add' }, kgInput, noteInput, btn(t('Додати'), add))]);
}

/** Контрольна точка: вага, що означає, і до якої дати хочеться дійти. */
function checkpointForm(c) {
  const f = form([
    { name: 'kg', label: t('Вага, кг'), type: 'number', value: numStr(c.kg), required: true, min: 20, max: 400, half: true },
    { name: 'by', label: t('До дати'), type: 'dmy', value: c.by ?? '', half: true },
    { name: 'note', label: t('Що означає'), value: c.note ?? '', placeholder: t('необов’язково') },
  ]);
  const save = async () => {
    const bad = f.invalid();
    if (bad) { toast(t('Перевірте поле «{f}»', { f: bad.label })); return; }
    const v = f.values();
    close();
    await saveGoal({ checkpoints: (goal.checkpoints ?? []).map((x) => (x.id === c.id ? { ...x, kg: v.kg, note: v.note.trim(), by: v.by || undefined } : x)) });
    toast(t('Збережено'));
  };
  const close = sheet(t('Контрольна точка'), h('div', {},
    f.el, h('p', { class: 'muted small' }, t('Дата — необов’язково: з нею на головній видно, чи встигаєте, який потрібен темп і скільки їсти.'))), {
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

function remindRow() {
  const time = h('input', {
    type: 'time', value: remindTime(), class: 'time-input',
    onchange: (e) => { setRemindTime(e.target.value); bot.scheduleBot(500); render(); },
  });
  const connected = Boolean(bot.botConfig().from);
  return setRow('remind', 'bell', t('Нагадування'), connected && bot.remindOn() ? `${remindTime()} · Telegram` : remindTime(), [
    h('p', { class: 'muted small' }, t('Поки вагу за сьогодні не записано, на головній угорі стоїть поле запису й горить крапка на вкладці. Щоб телефон сам нагадав у потрібну годину, потрібен Telegram-бот або подія в календарі.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Час')), time),
    h('h4', { class: 'sub-head' }, withIcon('bell', 'Telegram')),
    connected
      ? segmented([['on', t('Нагадувати')], ['off', t('Не нагадувати')]], bot.remindOn() ? 'on' : 'off',
        (v) => { bot.setRemindOn(v === 'on'); bot.scheduleBot(300); render(); })
      : h('p', { class: 'muted small' }, t('Синхронізацію не ввімкнено — це в групі «Дані» нижче.')),
    connected && planOf(state) ? dayAskPanel() : null,
    fold('remind-calendar', withIcon('calendar', t('Календар телефона')), h('div', {},
      h('p', { class: 'muted small' }, t('Запасний варіант без бота: щоденна подія «Зважитися» зі сповіщенням — будить телефон сам календар.')),
      h('div', { class: 'btn-row' },
        btn(withIcon('calendar', t('Google Календар')), () => { setRemindTime(time.value); window.open(googleCalendarUrl(remindTime(), appUrl()), '_blank', 'noopener'); }),
        btn(withIcon('download', t('Файл .ics')), () => { setRemindTime(time.value); saveFile(icsFile(remindTime(), appUrl()), true); })),
      h('p', { class: 'muted small' }, t('У Google Календарі перевірте, що в події ввімкнене сповіщення «у момент початку». Файл .ics відкривають календарі Samsung, iPhone і Outlook.'))))]);
}

/** Вечірнє «Як день за раціоном?» у Telegram: кнопки «За планом / Трохи не так / Зрив». */
function dayAskPanel() {
  const at = bot.dayAskTime();
  const time = h('input', {
    type: 'time', value: at ?? bot.DAY_ASK_DEFAULT, class: 'time-input', disabled: !at,
    onchange: (e) => { if (e.target.value) { bot.setDayAskTime(e.target.value); bot.scheduleBot(500); } },
  });
  return h('div', {},
    h('h4', { class: 'sub-head' }, withIcon('leaf', t('Питання про раціон'))),
    h('p', { class: 'muted small' }, t('Увечері бот спитає, як минув день: три кнопки, при зриві — причина. Позначка ляже в «Раціон». Якщо день уже позначено — не спитає.')),
    segmented([['on', t('Питати')], ['off', t('Не питати')]], at ? 'on' : 'off', (v) => {
      bot.setDayAskTime(v === 'on' ? (time.value || bot.DAY_ASK_DEFAULT) : null);
      time.disabled = v !== 'on';
      bot.scheduleBot(300);
    }),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('О котрій')), time));
}

// ---------- Telegram-бот ----------

let botError = '';

/** Синхронізація; нова вага з бази (з Telegram чи з іншого пристрою) — коротке повідомлення. Без мережі тихо: спробуємо наступного разу. */
async function runBot() {
  try {
    const { got } = await bot.syncBot();
    botError = '';
    if (got?.length === 1) toast(t('Нове зважування: {kg} за {date}', { kg: kg(got[0].kg), date: fmt.date(got[0].date) }));
    else if (got?.length) toast(t('Нових зважувань: {n}', { n: got.length }));
  } catch (err) {
    // fetch без мережі падає з «Failed to fetch» — людині зрозуміліше своїми словами
    botError = err.message === 'key' || err.message.startsWith('HTTP') ? err.message : t('мережа недоступна');
  }
  renderSyncChip();
  // Статус у налаштуваннях — свіжий, але не під пальцями, що саме вводять адресу чи ключ
  if (tab === 'settings' && !document.activeElement?.matches('input')) render();
}

function botStatus(cfg) {
  if (bot.keyProblem()) return t('Ключ доступу не підходить — візьміть новий командою /key у Telegram-боті й вставте нижче.');
  if (!cfg.from) return t('Не ввімкнено. Вставте адресу сервера й ключ доступу нижче — або ввімкніть синхронізацію в Хобі-плані на цьому пристрої, вона підхопиться сама.');
  if (botError === 'key') return t('Ключ доступу не підходить — візьміть новий командою /key у Telegram-боті й вставте нижче.');
  if (botError) return t('Немає зв’язку з сервером: {e}', { e: botError });
  return t('Обмін: {time}', { time: syncTime(bot.lastSync()) });
}

/** «Синхронізація»: стан обміну, адреса й ключ (спільні для застосунків на пристрої), обмін і від'єднання. */
function syncRow() {
  const cfg = bot.botConfig();
  const f = form([
    { name: 'url', label: t('Адреса сервера'), value: cfg.url, placeholder: 'https://….workers.dev' },
    { name: 'key', label: t('Ключ доступу'), type: 'password', value: cfg.key },
  ]);
  const save = async () => {
    const v = f.values();
    if (!v.url.startsWith('https://') || !v.key) { toast(t('Вкажіть адресу https://… і ключ')); return; }
    bot.setBotConfig(v.url, v.key);
    sync.botChanged();
    await runBot();
    render();
    toast(botError ? botStatus(bot.botConfig()) : t('Синхронізацію ввімкнено'));
  };
  const exchange = async () => {
    await runBot();
    render();
    if (!botError) toast(t('Обмін пройшов'));
  };
  const bad = Boolean(botError) || bot.keyProblem();
  const value = bot.keyProblem() || botError === 'key' ? t('Ключ не підходить') : !cfg.from ? t('Вимкнено')
    : botError ? t('Немає зв’язку') : bot.lastSync() ? shortWhen(bot.lastSync()) : t('Ще не було');
  return setRow('sync', 'sync', t('Синхронізація'), value, [
    h('p', { class: `small ${bad ? 'error-text' : 'muted'}` }, botStatus(cfg)),
    h('p', { class: 'muted small' }, t('Весь журнал (вага, талія, налаштування) лежить у спільній базі на сервері — однаковий на всіх пристроях; без інтернету все піде пізніше. Цю ж базу читає Telegram-бот: нагадує зважитись і приймає вагу повідомленням. Ключ доступу дає команда /key у боті; досить вставити в одному застосунку — Хобі-план, Вага чи Марнотрат.')),
    f.el,
    h('div', { class: 'btn-row' },
      btn(t('Зберегти'), save, cfg.from ? '' : 'primary'),
      cfg.from ? btn(withIcon('sync', t('Обмінятися зараз')), exchange, 'primary') : null,
      cfg.from ? btn(t('Вимкнути синхронізацію'), () => { bot.setBotConfig('', ''); botError = ''; render(); }) : null)],
  { tone: bad ? 'bad' : cfg.from ? 'ok' : '' });
}

const CHIP = {
  idle: () => `✓ ${fmt.time(sync.status.lastSync)}`,
  syncing: () => '…',
  offline: () => t('офлайн'),
  auth: () => t('увійти'),
  error: () => t('помилка'),
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
  if (bot.keyProblem() || botError === 'key') return { st: 'key', text: t('ключ'), title: t('Ключ доступу не підходить') };
  if (bot.botConfig().from) {
    if (!navigator.onLine) return { st: 'offline', text: t('офлайн'), title: t('Немає інтернету — синхронізація відбудеться, коли з’явиться зв’язок') };
    if (botError) return { st: 'error', text: t('помилка'), title: t('Немає зв’язку з сервером: {e}', { e: botError }) };
    const at = bot.lastSync();
    if (!at) return { st: 'syncing', text: '…', title: t('Синхронізація') };
    return { st: 'idle', text: `✓ ${fmt.time(at)}`, title: t('Обмін: {time}', { time: syncTime(at) }) };
  }
  const s = sync.status;
  if (!CHIP[s.state]) return null;
  return { st: s.state, text: CHIP[s.state](), title: s.message || t('Синхронізація з Google Диском'), drive: true, photo: s.photo };
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
  if (s?.st === 'key') { openSettings('sync'); return; }
  if (s?.st === 'offline') { toast(t('Немає інтернету — синхронізація відбудеться, коли з’явиться зв’язок')); return; }
  if (bot.botConfig().from) {
    runBot().then(() => toast(botError ? chipState()?.title ?? botError : t('Обмін пройшов')));
    return;
  }
  const { state: st, message } = sync.status;
  if (st === 'auth') connectGoogle();
  else if (st === 'offline') toast(t('Немає інтернету — синхронізація відбудеться, коли з’явиться зв’язок'));
  else if (st === 'error') { toast(message || t('Помилка синхронізації')); sync.syncNow({ force: true }); } else sync.syncNow({ force: true });
  runBot();
}

function syncTime(ms) {
  if (!ms) return t('ще не було');
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? t('сьогодні о {time}', { time: fmt.time(ms) })
    : `${fmt.date(new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10))} ${fmt.time(ms)}`;
}

function connectGoogle() {
  sync.connect().then(() => toast(t('Google Диск підключено'))).catch((err) => toast(err.message));
}

/** «Google Диск»: з ботом — щоденна копія, без бота — синхронізація між пристроями. */
function driveRow() {
  const s = sync.status;
  const daily = Boolean(bot.botConfig().from);
  const panel = h('div', { class: 'set-sub' });
  if (!sync.configured()) {
    panel.append(h('p', { class: 'muted small' }, t('Не налаштована: у js/config.js не вказано Google Client ID.')));
  } else if (!sync.enabled()) {
    panel.append(
      h('p', { class: 'muted small' }, t('Копія журналу — файл weight-log.json на вашому Google Диску; там же адреса сервера й ключ доступу для інших пристроїв. Застосунок бачить лише свої файли.')),
      h('div', { class: 'btn-row' }, btn(withIcon('cloud', t('Підключити Google Диск')), connectGoogle, 'primary')));
  } else {
    const restore = async () => {
      try {
        const parsed = await sync.fetchBackup();
        if (!parsed) { toast(t('На Диску ще немає копії')); return; }
        importParsed(parsed, t('Копія з Google Диска'));
      } catch (err) { toast(err.message); }
    };
    panel.append(
      h('div', { class: 'account' }, avatar(s.photo, 'big'),
        h('div', { class: 'account-text' }, h('b', {}, s.name ?? s.email ?? '—'), s.name && s.email ? h('span', { class: 'muted small' }, s.email) : null)),
      h('p', { class: `small ${s.state === 'error' ? 'error-text' : 'muted'}` },
        s.message || t('Остання копія: {time}', { time: syncTime(s.lastSync) })),
      h('div', { class: 'btn-row' },
        s.state === 'auth' ? btn(t('Увійти в Google'), connectGoogle, 'primary') : btn(withIcon('sync', t('Зберегти зараз')), () => sync.syncNow({ force: true }), 'primary'),
        btn(withIcon('download', t('Відновити з Диска')), restore),
        btn(t('Відключити'), () => confirmSheet(t('Відключити Google Диск?'), t('Копія на Диску лишиться, просто перестане оновлюватись. Вхід у Google в інших застосунках не чіпаємо.'), t('Відключити'), () => sync.disconnect()))));
  }
  const on = sync.configured() && sync.enabled();
  const bad = on && (s.state === 'auth' || s.state === 'error');
  const value = !sync.configured() ? t('Не налаштовано') : !on ? t('Вимкнено')
    : s.state === 'auth' ? t('Увійти') : s.state === 'error' ? t('Помилка') : s.state === 'offline' ? t('Офлайн')
      : s.lastSync ? shortWhen(s.lastSync) : t('Ще не було');
  return setRow('drive', 'cloud', daily ? t('Google Диск · копія') : t('Google Диск'), value, panel,
    { tone: bad ? 'bad' : on ? 'ok' : '' });
}

/** «Вхід за відбитком»: увімкнути, через скільки блокувати у фоні, вимкнути з підтвердженням. */
function lockRow() {
  const body = h('div', { class: 'set-sub' });
  const act = (fn, done) => async () => {
    try {
      await fn();
      toast(done);
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast(t('Помилка: {msg}', { msg: err?.message || String(err) }));
    }
    render();
  };
  if (lockOn()) {
    body.append(
      h('p', { class: 'muted small' }, t('Блокувати після згортання:')),
      segmented(LOCK_DELAYS.map((m) => [String(m), m ? t('{n} хв', { n: m }) : t('Одразу')]), String(lockDelay()), (v) => { setLockDelay(Number(v)); render(); }),
      h('div', { class: 'btn-row' }, btn(t('Вимкнути'), act(disableLock, t('Вхід за відбитком вимкнено')))));
  } else {
    lockAvailable().then((ok) => body.append(ok
      ? h('div', { class: 'btn-row' }, btn(t('Увімкнути'), act(enableLock, t('Вхід за відбитком увімкнено')), 'primary'))
      : h('p', { class: 'muted small' }, t('На цьому пристрої немає відбитка, обличчя чи PIN-коду, які браузер може перевірити.'))));
  }
  const value = !lockOn() ? t('Вимкнено') : lockDelay() ? t('Через {n} хв', { n: lockDelay() }) : t('Одразу');
  return setRow('lock', 'lock', t('Вхід за відбитком'), value, [
    h('p', { class: 'muted small' }, t('Застосунок відкривається відбитком, обличчям або PIN-кодом телефона — лише на цьому пристрої. Це захист від чужих очей, дані не шифруються.')),
    body]);
}

/** «Копія у файл»: зберегти (на телефоні — «Поділитися», на комп'ютері — завантажити) і відновити. */
function fileRow() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; } });
  return setRow('file', 'archive', t('Копія у файл'), '', [
    h('p', { class: 'muted small' }, t('Зважувань: {w} · замірів талії: {c}', { w: state.weights.length, c: state.waists.length })),
    h('div', { class: 'btn-row' },
      btn(withIcon('download', t('Зберегти копію')), () => exportData(true)),
      btn(withIcon('upload', t('Відновити з файлу')), () => input.click())),
    input]);
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
  try { parsed = JSON.parse(await readText(file)); } catch { toast(t('Файл не схожий на JSON')); return; }
  importParsed(parsed, t('Імпорт копії'));
}

/** Копія (з файлу чи з Диска): «Объединить» або «Заменить всё». */
function importParsed(parsed, title) {
  const data = parsed?.data;
  if (parsed?.app !== 'weight-log' || !data || !db.STORES.every((s) => !data[s] || Array.isArray(data[s]))) {
    toast(t('Це не резервна копія Weight Log'));
    return;
  }
  const count = db.STORES.reduce((s, k) => s + (data[k]?.length ?? 0), 0);
  const changes = Object.fromEntries(db.STORES.map((s) => [s, { put: (data[s] ?? []).filter((x) => x && x.id) }]));
  const close = sheet(title, h('div', {},
    h('p', {}, t('У файлі {n} записів.', { n: count })),
    h('p', { class: 'muted small' }, t('«Об’єднати» — додасть нові записи й оновить ті, що у файлі новіші: пізніші правки на пристрої залишаться. «Замінити все» — спершу видалить поточні дані.')),
    sync.enabled() || bot.botConfig().from ? h('p', { class: 'muted small' }, t('«Замінити все» замінить дані й на інших пристроях. «Об’єднати» не відкотить новіших правок з них.')) : null), {
    actions: [
      btn(t('Скасувати'), () => close()),
      btn(t('Об’єднати'), async () => { close(); await db.mergeImport(changes); bot.rewindPushed(); toast(t('Імпортовано')); }, 'primary'),
      btn(t('Замінити все'), () => {
        close();
        confirmSheet(t('Замінити всі дані?'), t('Поточні дані буде видалено. Спершу збережіть копію, якщо вони потрібні.'), t('Замінити'), async () => {
          const at = await db.replaceAll(changes);
          sync.markRestore(at);
          bot.markRestore(at);
          toast(t('Дані замінено'));
        });
      }, 'danger'),
    ],
  });
}

// Тема: auto — як у системі. Першу розстановку до малювання робить скрипт в index.html.
// Спецрежими — як у Shooter's Log: Нічна (усе червоним) і монітори-кінескопи; щоденні — Авто, Темна, Світла
const THEMES = [['auto', 'Авто'], ['dark', 'Темна'], ['light', 'Світла'], ['night', 'Нічна'], ['phosphor', 'Фосфор'], ['amber', 'Бурштин'], ['white', 'Білий фосфор']];
const SPECIAL_THEMES = ['night', 'phosphor', 'amber', 'white'];
const lightScheme = matchMedia('(prefers-color-scheme: light)');

function themePref() {
  const v = recall('weight-log:theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}

// Фон під картками (як у Shooter's Log, без камуфляжів) — свій набір для темної й світлої; перший — без малюнка, за замовчуванням
const BACKDROPS = {
  dark: [['plain', 'Без малюнка'], ['map', 'Карта'], ['olive', 'Олива'], ['carbon', 'Карбон'], ['coyote', 'Койот'], ['lines', 'Лінії'], ['lines-acc', 'Лінії з акцентом']],
  light: [['l-plain', 'Без малюнка'], ['l-map', 'Карта'], ['l-mm', 'Міліметрівка'], ['l-sand', 'Пісок'], ['l-sand-acc', 'Пісок з акцентом'], ['l-khaki', 'Хакі'], ['l-khaki-acc', 'Хакі з акцентом']],
};
const BG_KEY = { dark: 'weight-log:bg', light: 'weight-log:bg-light' };

function backdropPref(theme) {
  const list = BACKDROPS[theme];
  if (!list) return null;
  const v = recall(BG_KEY[theme]);
  return list.some(([k]) => k === v) ? v : list[0][0];
}

function applyTheme() {
  const pref = themePref();
  const theme = pref === 'auto' ? (lightScheme.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  const bg = backdropPref(theme);
  if (bg) document.documentElement.dataset.bg = bg; else delete document.documentElement.dataset.bg;
  const k = nightLevel() / 100;
  document.querySelector('#night-red feColorMatrix')?.setAttribute('values',
    `${(0.5 * k).toFixed(3)} ${(0.6 * k).toFixed(3)} ${(0.1 * k).toFixed(3)} 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0`);
  // Колір смуги браузера: у спецрежимах — їхнє тло, інакше — тло вибраного фону (--bg у CSS)
  const bar = { night: '#000000' }[theme] ?? (SPECIAL_THEMES.includes(theme) ? '#0b0d0b'
    : getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0c111a');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
}

/** Яскравість червоного в нічній темі, 20–100 %. */
function nightLevel() {
  const v = Number(recall('weight-log:night-level'));
  return v >= 20 && v <= 100 ? v : 80;
}

lightScheme.addEventListener('change', applyTheme);

// Аватар кліпає, як у Стрілецькому журналі — фото те саме, тож і контури очей ті самі (координати фото 233×233).
// Повіки — шар SVG поверх фото, обрізаний контуром білка; верхня з опуклою кромкою опускається, нижня підіймається
// назустріч. Праве око перше: ліве його перекриває.
const AVATAR_EYES = [
  { d: 'M114 63L114 65L117 71L117 78L121 78L122 77L126 77L127 76L132 76L135 79L137 79L139 77L140 72L141 71L141 68L140 67L140 64L135 59L131 57L122 57L118 59Z', box: [114, 57, 142, 80] },
  { d: 'M99 60L98 61L94 61L87 67L85 71L85 79L87 83L90 86L94 88L102 89L110 86L115 79L115 69L109 62Z', box: [85, 60, 116, 90] },
];
const AVATAR_SVG = '<svg viewBox="0 0 233 233" aria-hidden="true"><defs>'
  + AVATAR_EYES.map(({ d }, i) => `<clipPath id="av-eye${i}"><path d="${d}"/></clipPath>`).join('')
  + '</defs>'
  + AVATAR_EYES.map(({ box: [x0, y0, x1, y1] }, i) => {
    const hh = y1 - y0, e = y0 + hh * 0.6, k = hh * 0.26, cx = (x0 + x1) / 2, l = x0 - 3, r = x1 + 3;
    const edge = `M${l} ${e}Q${cx} ${e + k} ${r} ${e}`;
    return `<g clip-path="url(#av-eye${i})" fill="#fcd901">`
      + `<path class="av-lid low" style="--o:${(y1 - e + 3).toFixed(1)}px" d="${edge}V${y1 + 3}H${l}Z"/>`
      + `<g class="av-lid" style="--o:-${(e + k - y0 + 3).toFixed(1)}px"><path d="M${l} ${y0 - 3}H${r}V${e}Q${cx} ${e + k} ${l} ${e}Z"/>`
      + `<path d="${edge}" fill="none" stroke="#1d1d1d" stroke-width="2.6" stroke-linecap="round"/></g></g>`;
  }).join('')
  + '</svg>';

/** Тап по аватару — кліпнути одразу, не чекаючи свого часу. */
function avatarHi(e) {
  const el = e.currentTarget;
  el.classList.remove('hi');
  void el.offsetWidth;
  el.classList.add('hi');
  clearTimeout(el.hiTimer);
  el.hiTimer = setTimeout(() => el.classList.remove('hi'), 600);
}

const CUP_SVG = '<svg viewBox="0 0 16 20" aria-hidden="true">'
  + '<path class="st" d="M6 8.5c-2-2 2-3 0-6"/><path class="st" d="M10 8.5c-2-2 2-3 0-6"/>'
  + '<path d="M3 10h9v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#f4f1ea" stroke="#3a2a1c"/>'
  + '<path d="M12 11.5h1.2a2 2 0 0 1 0 4H12" fill="none" stroke="#3a2a1c"/><ellipse cx="7.5" cy="10.4" rx="4" ry=".9" fill="#6b3f1f"/></svg>';

/** «На каву автору», як у Shooter’s Log: банка Монобанку звичайним посиланням, без сторонніх скриптів. */
function donateCard() {
  return h('a', { class: 'donate-card', href: 'https://send.monobank.ua/jar/XJKDMyVfW', target: '_blank', rel: 'noopener' },
    h('span', { class: 'donate-art' },
      h('span', { class: 'donate-cat' }, h('img', { src: './icons/cat-portrait.png', alt: '', width: 50, height: 50 }),
        Object.assign(h('span', { class: 'donate-cup' }), { innerHTML: CUP_SVG })),
      // табличка під рамою, як підпис під картиною: чий це котик — банка monobank
      h('span', { class: 'donate-plate', 'aria-hidden': 'true' }, 'mono')),
    h('span', { class: 'donate-text' }, h('b', {}, t('На каву автору')), h('small', {}, t('Безкоштовно й без реклами — тримається на вашій підтримці'))),
    h('span', { class: 'donate-go', 'aria-hidden': 'true' }, '→'));
}

/** «Про застосунок», як у shooting-log: аватар автора, версія, що це таке, встановлення, де дані, з чого почати. */
function aboutPanel() {
  const more = (title, node) => h('details', { class: 'about-more' }, h('summary', {}, title), node);
  return h('section', { class: 'panel about' },
    h('div', { class: 'about-head' },
      h('span', { class: 'about-avatar', onclick: avatarHi },
        h('img', { src: './icons/author.jpg', alt: '', width: 64, height: 64, loading: 'lazy' }),
        Object.assign(h('span', { class: 'av-live' }), { innerHTML: AVATAR_SVG })),
      h('div', {},
        h('h3', {}, 'Weight Log'),
        h('p', { class: 'muted small' }, t('Версія {v} · збірка {b}', { v: self.APP_VERSION, b: self.APP_BUILD ?? '—' })))),
    h('p', { class: 'muted small' }, t('Weight Log — щоденна вага, середнє за 7 днів, темп і прогноз цілі. Працює без інтернету: усе рахується на пристрої.')),
    donateCard(),
    more(t('Встановлення на телефон'), h('div', { class: 'muted small' },
      h('p', {}, t('Chrome → меню ⋮ → «Додати на головний екран» / «Установити застосунок». Після встановлення працює без інтернету.')))),
    more(t('Де мої дані'), h('div', { class: 'muted small' },
      h('p', {}, t('Записи лежать у браузері на цьому пристрої. Сервера в застосунку немає, автор не отримує ні даних, ні статистики.')),
      h('p', {}, t('Google Диск підключається за бажанням: копія лягає у файл weight-log.json на вашому Диску, застосунок бачить лише свої файли.')),
      h('p', {}, t('Резервна копія — «Поділитися копією» нижче. Вона ж переносить дані на інший пристрій через «Імпорт копії».')))),
    more(t('З чого почати'), h('ol', { class: 'about-steps' },
      h('li', {}, t('Задайте ціль: стартову вагу, цільову й план, кг на тиждень.')),
      h('li', {}, t('Зважуйтеся щоранку й записуйте вагу на головній — поле саме запропонує минуле значення.')),
      h('li', {}, t('Підключіть Google Диск — записи будуть однакові на телефоні й комп\'ютері.')),
      h('li', {}, t('Увімкніть нагадування — Telegram-бот або подія в календарі, щоб не пропускати дні.')))),
    h('p', { class: 'muted small' },
      h('a', { href: 'https://github.com/VitaliyLobko/weight-log', target: '_blank', rel: 'noopener' }, t('Вихідний код'))),
    h('p', { class: 'muted small' }, t('Хрюк — '),
      h('a', { href: 'https://freesound.org/people/Erdie/sounds/44274/', target: '_blank', rel: 'noopener' }, '«Pig grunt», erdie'),
      ', ', h('a', { href: 'https://creativecommons.org/licenses/by/3.0/', target: '_blank', rel: 'noopener' }, 'CC BY 3.0')));
}

function renderSettings() {
  $('subtitle').textContent = t('версія {v}', { v: self.APP_VERSION });
  return h('div', {},
    settingsGroup(t('Про застосунок'), [aboutPanel()]),
    settingsGroup(withIcon('target', t('Ціль і нагадування')), [goalRow(), bodyRow(), checkpointsRow(), remindRow()]),
    settingsGroup(withIcon('cloud', t('Дані')), [syncRow(), driveRow(), lockRow(), fileRow(), wipeRow()]),
    settingsGroup(withIcon('theme', t('Зовнішній вигляд')), [themeRow(), backdropRow(), oinkRow()]));
}

/** Група налаштувань, як у Стрілецькому журналі: рамка з назвою на лінії, всередині — рядки через лінію. */
function settingsGroup(title, items) {
  return h('fieldset', { class: 'settings-group' }, h('legend', {}, title), items.filter(Boolean));
}

const SET_OPEN_KEY = 'weight-log:set-open';

/**
 * Рядок налаштувань: іконка, назва й поточне значення — видно, що де стоїть, нічого не відкриваючи.
 * Тап розгортає керування під рядком; відкритий завжди один, і його пам'ятаємо між перемальовуваннями.
 */
function setRow(key, ico, title, value, body, { tone = '', danger = false } = {}) {
  const open = recall(SET_OPEN_KEY) === key;
  const row = h('div', { class: `set-row${open ? ' open' : ''}${danger ? ' danger' : ''}`, dataset: { key } });
  const head = h('button', {
    type: 'button', class: 'set-head', 'aria-expanded': String(open), onclick: () => {
      const opening = !row.classList.contains('open');
      document.querySelectorAll('.set-row.open').forEach((r) => setOpen(r, false));
      setOpen(row, opening);
      remember(SET_OPEN_KEY, opening ? key : '');
    },
  }, h('span', { class: 'set-ico' }, icon(ico)), h('span', { class: 'set-title' }, title),
  h('span', { class: `set-val${tone ? ` ${tone}` : ''}` }, value), h('span', { class: 'set-chev', 'aria-hidden': 'true' }, '›'));
  row.append(head, h('div', { class: 'set-body', inert: !open }, h('div', { class: 'set-inner' }, h('div', { class: 'set-pane' }, body))));
  return row;
}

function setOpen(row, open) {
  row.classList.toggle('open', open);
  row.querySelector('.set-head').setAttribute('aria-expanded', String(open));
  row.querySelector('.set-body').inert = !open;
}

/** Час для рядка: сьогодні — година, раніше — дата. */
function shortWhen(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? fmt.time(ms)
    : fmt.date(new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10));
}

/** Видалення — останнім рядком «Даних» і згорнуте: небезпечна дія не має бути найпомітнішою на екрані. */
function wipeRow() {
  return setRow('wipe', 'trash', t('Видалити дані з пристрою'), '',
    h('div', { class: 'btn-row' }, btn(t('Видалити дані з пристрою'), () => confirmSheet(t('Видалити дані з пристрою?'), sync.enabled()
      ? t('Дані буде видалено з цього пристрою. Копія на Google Диску залишиться й повернеться під час наступної синхронізації — щоб цього не сталося, спершу відключіть синхронізацію.')
      : t('Усі зважування, заміри й ціль буде видалено з цього пристрою. Скасувати не можна.'), t('Видалити'), async () => {
      await db.clearAll(); await refresh(); toast(t('Дані видалено'));
    }), 'danger')),
    { danger: true });
}

/** Хрюк на кнопці «З'їв поза планом» — той самий перемикач, що й у шапці шторки «Поза планом». */
function oinkRow() {
  return setRow('oink', 'pig', t('Звук хрюку'), oinkOn() ? t('Увімкнено') : t('Вимкнено'), [
    segmented([['on', t('Увімкнено')], ['off', t('Вимкнено')]], oinkOn() ? 'on' : 'off', (v) => {
      setOinkOn(v === 'on');
      if (v === 'on') oink();
      render();
    }),
    h('p', { class: 'muted small' }, t('Хрюкає кнопка «З\'їв поза планом». Те саме перемикає динамік у шапці шторки «Поза планом». Діє на цьому пристрої.'))]);
}

function themeRow() {
  // Дві групи: щоденні теми й «Спецрежими»; вибрана підсвічується у своїй групі
  const pick = (special) => segmented(THEMES.filter(([k]) => SPECIAL_THEMES.includes(k) === special).map(([k, label]) => [k, t(label)]),
    themePref(), (v) => { remember('weight-log:theme', v); applyTheme(); render(); });
  const specials = pick(true);
  specials.classList.add('theme-special');
  return setRow('theme', 'theme', t('Тема'), t(THEMES.find(([k]) => k === themePref())[1]), [
    pick(false),
    h('div', { class: 'theme-group' }, t('Спецрежими')),
    specials,
    // Ніч буває різна: тягнеш — сторінка одразу темнішає чи світлішає
    themePref() === 'night' ? h('label', { class: 'night-level' }, h('span', {}, t('Яскравість червоного')),
      h('input', { type: 'range', min: '20', max: '100', step: '5', value: String(nightLevel()),
        oninput: (e) => { remember('weight-log:night-level', e.target.value); applyTheme(); } })) : null,
    h('p', { class: 'muted small' }, t('Нічна — усе червоним, щоб не збивати нічний зір. Фосфор, Бурштин і Білий фосфор — як старі монітори-кінескопи.'))]);
}

/** Фон під картками — плитки з самим фоном, щоб видно було до вибору; набір — для поточної теми, у спецрежимах рядка немає. */
function backdropRow() {
  const theme = document.documentElement.dataset.theme;
  const list = BACKDROPS[theme];
  if (!list) return null;
  let now = backdropPref(theme);
  const label = (k) => t(list.find(([x]) => x === k)[1]);
  const strip = h('div', { class: 'bg-picks', role: 'radiogroup', 'aria-label': t('Фон') }, list.map(([k, name]) => h('button', {
    type: 'button', class: 'bg-pick', role: 'radio', 'aria-checked': String(k === now), dataset: { bg: k },
    onclick: (e) => wheel.centerOn(e.currentTarget),
  }, h('span', { class: 'bg-sw', dataset: { bg: k } }), h('span', {}, t(name)))));
  // Фон посередині — вибраний і одразу під картками: гортаєш — бачиш наживо
  const wheel = wheelStrip(strip, (b) => {
    if (b.dataset.bg === now) return;
    now = b.dataset.bg;
    remember(BG_KEY[theme], now);
    strip.querySelectorAll('.bg-pick').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    applyTheme();
    // Без перемальовування — інакше стрічка злетіла б посеред гортання; назву в рядку міняємо на місці
    row.querySelector('.set-val').textContent = label(now);
  }, '.bg-pick');
  // «‹ ›» по краях — видно, що стрічку гортають
  const step = (dir) => {
    const on = strip.querySelector('[aria-checked="true"]');
    const to = dir < 0 ? on?.previousElementSibling : on?.nextElementSibling;
    if (to) wheel.centerOn(to);
  };
  const nav = (dir, text, name) => h('button', { type: 'button', class: 'bg-nav', 'aria-label': t(text), onclick: () => step(dir) }, name);
  // Поля й вибраний посередині рахуються від ширини стрічки: поки рядок згорнутий, досчитуємо, щойно з'явиться
  let width = 0;
  new ResizeObserver(() => {
    if (!strip.clientWidth || strip.clientWidth === width) return;
    width = strip.clientWidth;
    wheel.settle(strip.querySelector('[aria-checked="true"]'));
  }).observe(strip);
  const row = setRow('backdrop', 'gallery', t('Фон'), label(now),
    h('div', { class: 'bg-wheel' }, nav(-1, 'Попередній', '‹'), strip, nav(1, 'Наступний', '›')));
  return row;
}

/** Перейти в налаштування з уже розгорнутим рядком key. */
function openSettings(key) {
  remember(SET_OPEN_KEY, key);
  location.hash = '#settings';
}

// ---------- навігація ----------

const VIEWS = {
  // Сьогоднішня вага пишеться формою вгорі головної, за інший день — у «Журналі»; «+» тут лише перекривав блоки
  home: { title: 'Вага', render: renderHome },
  // На графіку «+» перекривав блок талії, а запис дня там і так є — олівцем під графіком
  chart: { title: 'Графік', render: renderChart },
  ration: {
    title: 'Раціон',
    render: () => renderRation(state, {
      render,
      // Норма — та сама, що на головній: з ваших даних або за формулою; без зросту й віку — нема
      burn: () => normOf() ?? { kcal: null, hold: sum.hold },
      noPlan: () => empty('leaf', t('Плану харчування ще немає'),
        t('Завантажте файл із планом: Дані → Копія у файл → Відновити з файлу → Об’єднати.'),
        btn(withIcon('upload', t('Відкрити «Дані»')), () => openSettings('file'))),
    }),
  },
  log: { title: 'Журнал', render: renderLog, fab: () => ({ waist: waistForm, sizes: sizesForm, health: healthForm }[logSeg] ?? weightForm)() },
  settings: { title: 'Налаштування', render: renderSettings },
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
  if (tab === 'home' || tab === 'ration') $('subtitle').textContent = new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
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

applyTheme();
initLock({ key: 'weight-log:lock', name: t('Вага'), icon: 'icons/icon-192.png', text: () => ({
  locked: t('Застосунок заблоковано'), unlock: t('Розблокувати'), denied: t('Не підтверджено. Спробуйте ще раз.'),
  failed: t('Помилка: {msg}'), reset: t('Не виходить? Створити ключ наново') }) });
$('fab').addEventListener('click', () => VIEWS[tab].fab?.());
$('sync-chip').addEventListener('click', onSyncChip);
window.addEventListener('hashchange', route);
window.addEventListener('db-change', refresh);
window.addEventListener('sync-applied', refresh);
window.addEventListener('db-blocked', () => toast(t('Закрийте інші вкладки застосунку — база оновлюється')));
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

