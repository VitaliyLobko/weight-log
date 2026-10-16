// Розрахунки — ті самі формули, що в таблиці «контроль_веса»:
// середнє за 7 днів округлюється до сотих, і вже від округлених рахуються втрата, темп і прогноз.

const DAY = 86_400_000;
/** Середнє за 7 днів показується, лише коли у вікні щонайменше стільки зважувань. */
export const AVG_MIN = 4;
const r2 = (x) => Math.round(x * 100) / 100;

const utc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Сьогоднішня дата за місцевим часом (не UTC: о 01:00 за Києвом UTC ще «вчора»). */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
export const addDays = (iso, n) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);

export const waistId = (date) => `waist-${date}`;
export const GOAL_ID = 'goal';

export function goalOf(state) {
  return state.settings?.find((s) => s.id === GOAL_ID) ?? { id: GOAL_ID };
}

/**
 * Ряди зважувань за датою з похідними: avg — середнє за 7 календарних днів (поточний і 6 попередніх),
 * delta — avg мінус avg тижнем раніше, day — зміна до попереднього зважування.
 * Середнє з'являється на 7-й день від першого запису, як у таблиці.
 */
export function series(weights) {
  const rows = weights.filter((w) => Number.isFinite(w.kg))
    .map((w) => ({ date: w.id, kg: w.kg, note: w.note ?? '' }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return rows;
  const first = rows[0].date;
  const avgByDate = new Map();
  let from = 0;
  rows.forEach((row, i) => {
    while (daysBetween(rows[from].date, row.date) > 6) from += 1;
    const win = rows.slice(from, i + 1);
    row.avg = daysBetween(first, row.date) >= 6 && win.length >= AVG_MIN
      ? r2(win.reduce((s, r) => s + r.kg, 0) / win.length) : null;
    if (row.avg !== null) avgByDate.set(row.date, row.avg);
    row.day = i ? r2(row.kg - rows[i - 1].kg) : null;
  });
  for (const row of rows) {
    const prev = avgByDate.get(addDays(row.date, -7));
    row.delta = row.avg !== null && prev !== undefined ? r2(row.avg - prev) : null;
  }
  return rows;
}

/** План з таблиці: від стартової ваги рівно planRate кг на тиждень. */
export function planAt(goal, date) {
  if (!Number.isFinite(goal.start) || !goal.startDate || !Number.isFinite(goal.planRate)) return null;
  return r2(goal.start - (goal.planRate * daysBetween(goal.startDate, date)) / 7);
}

/** Стартові значення цілі: якщо не задані — перше зважування. */
export function effectiveGoal(goal, rows) {
  return {
    ...goal,
    start: Number.isFinite(goal.start) ? goal.start : rows[0]?.kg,
    startDate: goal.startDate || rows[0]?.date,
  };
}

/** Категорії ІМТ за ВООЗ; межі — верхні (не включно). */
export const BMI_CLASSES = [
  [18.5, 'Недостаточная масса'],
  [25, 'Норма'],
  [30, 'Избыточная масса'],
  [35, 'Ожирение I степени'],
  [40, 'Ожирение II степени'],
  [Infinity, 'Ожирение III степени'],
];

export function bmiOf(kg, heightCm) {
  if (!Number.isFinite(kg) || !(heightCm > 0)) return null;
  const value = kg / (heightCm / 100) ** 2;
  const idx = BMI_CLASSES.findIndex(([max]) => value < max);
  const below = idx > 0 ? BMI_CLASSES[idx - 1][0] : null;
  return {
    value,
    label: BMI_CLASSES[idx][1],
    // Скільки важити, щоб опуститися в попередню категорію (межа ІМТ × зріст²)
    nextKg: below ? Math.floor(below * (heightCm / 100) ** 2 * 10) / 10 : null,
    nextLabel: idx > 0 ? BMI_CLASSES[idx - 1][1] : null,
  };
}

/**
 * Зведення як у блоці «СВОДКА» таблиці.
 * База втрати й темпу — перше середнє за 7 днів (а не перше зважування): так у таблиці.
 */
export function summary(rows, goal) {
  const g = effectiveGoal(goal, rows);
  const last = rows.at(-1) ?? null;
  const withAvg = rows.filter((r) => r.avg !== null);
  const base = withAvg[0] ?? null;
  const cur = withAvg.at(-1) ?? null;
  const current = cur?.avg ?? last?.kg ?? null;
  const currentDate = cur?.date ?? last?.date ?? null;
  const lost = base && cur ? r2(base.avg - cur.avg) : null;
  const weeks = base && cur ? daysBetween(base.date, cur.date) / 7 : 0;
  const rate = weeks > 0 ? lost / weeks : null;
  const target = Number.isFinite(g.target) ? g.target : null;
  const toGo = target !== null && current !== null ? r2(current - target) : null;
  /** Дата, коли середнє дійде до kg при фактичному темпі; null — темп не на зниження. */
  const eta = (kg) => (rate > 0 && current > kg ? addDays(currentDate, Math.round(((current - kg) / rate) * 7)) : null);
  const plan = currentDate ? planAt(g, currentDate) : null;
  const span = base && target !== null ? base.avg - target : null;
  return {
    goal: g,
    last,
    current,
    currentDate,
    hasAvg: Boolean(cur),
    base,
    lost,
    rate,
    target,
    toGo,
    days: rows.length,
    weeksLeft: rate > 0 && toGo > 0 ? Math.ceil(toGo / rate) : null,
    finish: target !== null ? eta(target) : null,
    eta,
    plan,
    planDiff: plan !== null && current !== null ? r2(current - plan) : null,
    progress: span > 0 ? Math.min(1, Math.max(0, lost / span)) : null,
    weekDelta: cur?.delta ?? null,
    bmi: bmiOf(current, g.height),
  };
}

/** Дата, коли середнє вперше опустилося до kg (контрольну точку пройдено). */
export function reachedOn(rows, kg) {
  return rows.find((r) => r.avg !== null && r.avg <= kg)?.date ?? null;
}

/**
 * Контрольні точки з ціллю в кінці, від більшої ваги до меншої.
 * Кожна: { kg, note, isTarget, reached, eta }.
 */
export function checkpoints(rows, goal, sum) {
  const list = (goal.checkpoints ?? []).filter((c) => Number.isFinite(c.kg) && c.kg !== sum.target)
    .map((c) => ({ ...c, isTarget: false }));
  if (sum.target !== null) list.push({ id: 'target', kg: sum.target, note: '', isTarget: true });
  return list.sort((a, b) => b.kg - a.kg).map((c) => {
    const reached = reachedOn(rows, c.kg);
    return { ...c, reached, eta: reached ? null : sum.eta(c.kg) };
  });
}

/** Заміри талії за датою зі зміною від першого. */
export function waistSeries(waists) {
  const rows = waists.filter((w) => Number.isFinite(w.cm))
    .map((w) => ({ id: w.id, date: w.date, cm: w.cm }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  rows.forEach((r, i) => { r.change = i ? r2(r.cm - rows[0].cm) : null; r.prev = i ? r2(r.cm - rows[i - 1].cm) : null; });
  return rows;
}
