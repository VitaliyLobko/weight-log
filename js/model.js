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

/** Скільки днів із [a, b) припадає на паузи на підтриманні ({ from, to } включно). */
export function pauseDays(pauses, a, b) {
  let n = 0;
  for (const p of pauses ?? []) {
    const from = p.from > a ? p.from : a;
    const end = addDays(p.to, 1);
    const to = end < b ? end : b;
    if (from < to) n += daysBetween(from, to);
  }
  return n;
}

const inPause = (pauses, date) => (pauses ?? []).some((p) => p.from <= date && date <= p.to);

/** Дні схуднення між a і b: календарні мінус паузи. */
const activeDays = (pauses, a, b) => daysBetween(a, b) - pauseDays(pauses, a, b);

/**
 * Дата через n днів схуднення: дні пауз не рахуються. Стрибком: кінець відсувається на дні пауз,
 * що в нього потрапили, — а не перебором день за днем (на 250 днів до цілі це сотні дат на кожну точку).
 */
function addActiveDays(pauses, from, n) {
  if (n <= 0) return from;
  const list = (pauses ?? []).filter((p) => p.to > from).sort((a, b) => (a.from < b.from ? -1 : 1));
  let end = addDays(from, n);
  let covered = from;
  for (const p of list) {
    if (p.from > end) break;
    const start = p.from > covered ? p.from : addDays(covered, 1);
    if (start > p.to) continue;
    // Днів паузи, що лягли у (from, end], — на стільки ж відсувається кінець
    end = addDays(end, daysBetween(start, p.to) + 1);
    covered = p.to;
  }
  return end;
}

/** Режим «Утримання»: ціль — вага, якої тримаємося в коридорі ±holdBand, а не точка фінішу. */
export const isHold = (goal) => goal?.mode === 'hold' && Number.isFinite(goal.target);
const HOLD_BAND = 1;
export const holdBand = (goal) => (goal?.holdBand > 0 ? goal.holdBand : HOLD_BAND);

/**
 * План з таблиці: від стартової ваги рівно planRate кг на тиждень; у паузи на підтриманні лінія стоїть.
 * На утриманні, від дня переходу, план — рівна лінія на вазі цілі.
 */
export function planAt(goal, date) {
  if (isHold(goal) && goal.holdFrom && date >= goal.holdFrom) return goal.target;
  if (!Number.isFinite(goal.start) || !goal.startDate || !Number.isFinite(goal.planRate)) return null;
  return r2(goal.start - (goal.planRate * activeDays(goal.pauses, goal.startDate, date)) / 7);
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
  [18.5, 'Недостатня маса'],
  [25, 'Норма'],
  [30, 'Надмірна маса'],
  [35, 'Ожиріння I ступеня'],
  [40, 'Ожиріння II ступеня'],
  [Infinity, 'Ожиріння III ступеня'],
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

/** Недавній темп — за стільки днів; коротша історія середніх — темп від початку. */
export const RECENT_DAYS = 28;
const RECENT_MIN = 21;

/** Темп, кг/тиж, за останні RECENT_DAYS днів: середнє тоді мінус середнє зараз; дні пауз не рахуються. */
export function recentRate(rows, pauses = []) {
  const withAvg = rows.filter((r) => r.avg !== null);
  const cur = withAvg.at(-1);
  if (!cur) return null;
  const from = addDays(cur.date, -RECENT_DAYS);
  const then = withAvg.findLast((r) => r.date <= from) ?? withAvg[0];
  const days = daysBetween(then.date, cur.date);
  const active = activeDays(pauses, then.date, cur.date);
  return days >= RECENT_MIN && active > 0 ? ((then.avg - cur.avg) / active) * 7 : null;
}

/** Темп від дати менше за стільки днів — ще шум, не показуємо. */
const SINCE_MIN = 7;

/** Темп, кг/тиж, від дати from (середнє того дня чи найближче перед ним) до поточного середнього; без днів пауз. */
export function rateSince(rows, from, pauses = []) {
  const withAvg = rows.filter((r) => r.avg !== null);
  const cur = withAvg.at(-1);
  if (!cur || !from) return null;
  const then = withAvg.findLast((r) => r.date <= from) ?? withAvg.find((r) => r.date >= from);
  if (!then) return null;
  const active = activeDays(pauses, then.date, cur.date);
  return daysBetween(then.date, cur.date) >= SINCE_MIN && active > 0 ? ((then.avg - cur.avg) / active) * 7 : null;
}

/**
 * Чи встигаю до дати cp.by дійти середнім до cp.kg: { left, days, need, at(rate) } — need кг/тиж,
 * at — середнє на ту дату заданим темпом. Без дати, пройдена точка чи нема середнього — null.
 */
export function deadline(sum, cp) {
  if (!cp.by || cp.reached || !sum.hasAvg) return null;
  const left = r2(sum.current - cp.kg);
  if (left <= 0) return null;
  const days = activeDays(sum.goal.pauses, sum.currentDate, cp.by);
  return {
    left,
    days,
    late: days <= 0,
    need: days > 0 ? (left / days) * 7 : null,
    at: (rate) => (Number.isFinite(rate) && days > 0 ? r2(sum.current - (rate * days) / 7) : null),
  };
}

/** Швидкий крок ≈ 4,3 MET; понад спокій, що вже є в нормі, — (MET − 1) × кг × год. */
const WALK_MET = 4.3;
export const walkKcal = (min, kg) => (min > 0 && kg > 0 ? (WALK_MET - 1) * kg * (min / 60) : 0);

/** Плато — середнє стільки днів не опускається нижче свого мінімуму більш ніж на PLATEAU_KG. */
export const PLATEAU_DAYS = 14;
const PLATEAU_KG = 0.1;

/** { days, since, low, last } — останній мінімум середнього і скільки днів без нового (без днів пауз). */
export function lastLow(rows, pauses = []) {
  const withAvg = rows.filter((r) => r.avg !== null);
  if (!withAvg.length) return null;
  let low = withAvg[0];
  for (const r of withAvg) if (r.avg <= low.avg - PLATEAU_KG) low = r;
  const last = withAvg.at(-1).date;
  return { days: activeDays(pauses, low.date, last), since: low.date, low: low.avg, last };
}

/** { days, since, low } — скільки днів середнє не оновлює мінімум (без днів пауз); null — плато немає. */
export function plateau(rows, pauses = []) {
  const l = lastLow(rows, pauses);
  // У паузу вага стоїть навмисно — не плато
  if (!l || inPause(pauses, l.last)) return null;
  return l.days >= PLATEAU_DAYS ? { days: l.days, since: l.since, low: l.low } : null;
}

export const KCAL_PER_KG = 7700;
/** Утримання: зміна середнього за стільки днів, менша за DRIFT_KG, — вага стоїть. */
export const DRIFT_KG = 0.3;

/** Зміна середнього за останні days днів: { change, days, kcal } — kcal на день, плюс — їсте понад витрату. */
export function drift(rows, days = PLATEAU_DAYS) {
  const withAvg = rows.filter((r) => r.avg !== null);
  const cur = withAvg.at(-1);
  if (!cur) return null;
  const then = withAvg.findLast((r) => r.date <= addDays(cur.date, -days));
  if (!then) return null;
  const n = daysBetween(then.date, cur.date);
  const change = r2(cur.avg - then.avg);
  return { change, days: n, kcal: (change * KCAL_PER_KG) / n };
}

/** Рівні активності: коефіцієнт до базового обміну. */
export const ACTIVITY = [
  [1.2, 'Сидячий спосіб життя'],
  [1.375, 'Легка: 1–3 тренування на тиждень або 6–8 тис. кроків'],
  [1.55, 'Середня: 3–5 тренувань або 10 тис. кроків'],
  [1.725, 'Висока: тренування щодня'],
];

/** Витрата за Міффліном–Сан Жеором: базовий обмін × активність; бракує зросту, статі чи року народження — null. */
export function formulaBurn(goal, kg, date) {
  const age = Number(date.slice(0, 4)) - goal.birthYear;
  if (!Number.isFinite(kg) || !(goal.height > 0) || !(age > 0) || !['m', 'f'].includes(goal.sex)) return null;
  const bmr = 10 * kg + 6.25 * goal.height - 5 * age + (goal.sex === 'm' ? 5 : -161);
  const activity = Number(goal.activity) || ACTIVITY[0][0];
  return { bmr, burn: bmr * activity, age, activity, kg };
}

/** Дефіцит на день не більше за стільки ккал; ккал на день не нижче підлоги (чоловіки / жінки). */
export const MAX_DEFICIT = 1000;
export const kcalFloor = (sex) => (sex === 'f' ? 1200 : 1500);

/** План калорій на схуднення темпом rate кг/тиж від витрати burn: { kcal, capped, floored } — до округлення. */
export function lossKcal(burn, rate, sex) {
  const want = (rate * KCAL_PER_KG) / 7;
  const kcal = burn - Math.min(want, MAX_DEFICIT);
  const floor = kcalFloor(sex);
  return { kcal: Math.max(kcal, floor), capped: want > MAX_DEFICIT, floored: kcal < floor };
}

// ---------- мінімум білка ----------

/** Пороги % жиру: «сухий» і «не ожиріння»; стать невідома — чоловічі. */
const LEAN_BF = { m: 15, f: 23 };
const OBESE_BF = { m: 25, f: 32 };
/** Плавна опорна вага: понад вагу при ІМТ 25 рахується лише ця частка надлишку. */
export const REF_EXCESS = 0.4;
/** Дефіцит менше за стільки % — як утримання: похибка оцінки витрати не перекидає норму. */
export const DEFICIT_NOISE = 5;
/** Витрата невідома (нема статі), а мета — схуднення: беремо помірний дефіцит. */
export const GUESS_DEFICIT = 15;

const ceil5 = (v) => Math.ceil(Number(v.toFixed(6)) / 5) * 5;
const round5 = (v) => Math.round(v / 5) * 5;
const floor5 = (v) => Math.floor(Number(v.toFixed(6)) / 5) * 5;

/**
 * Мінімум білка на день: { g, mult, ref, scenario, warnings, perMeal }; вік < 18 чи обмеження від лікаря — { g: null, warnings: ['NO_CALC'] }.
 * deficit — % від витрати (≤ 0 — утримання чи профіцит). refMode 'spec' — від ІМТ 30 вага при ІМТ 25;
 * 'smooth' — від ІМТ 25 рахується REF_EXCESS надлишку, без стрибка норми на межі.
 */
export function proteinMin({ kg, height, age, deficit, strength, medical = false, sex = null, bodyFat = null, refMode = 'smooth' }) {
  if (!(kg > 0) || !(height > 0) || !Number.isFinite(age)) return null;
  if (age < 18 || medical) return { g: null, warnings: ['NO_CALC'] };
  if (!Number.isFinite(deficit)) return null;
  const h2 = (height / 100) ** 2;
  const s = sex === 'f' ? 'f' : 'm';
  const fat = Number.isFinite(bodyFat) ? bodyFat : null;
  // Низький % жиру при високому ІМТ — вага від м'язів, рахуємо від фактичної
  const muscular = fat !== null && fat < OBESE_BF[s];
  const w25 = 25 * h2;
  let ref = kg;
  if (!muscular) {
    if (refMode === 'spec') { if (kg / h2 >= 30) ref = w25; } else if (kg > w25) ref = w25 + REF_EXCESS * (kg - w25);
  }
  const warnings = ref < kg ? ['BMI_ADJUSTED'] : [];
  let scenario;
  let mult;
  if (deficit <= 0) { scenario = 'maintenance'; mult = strength ? 1.6 : 0.8; } else if (deficit < 25) { scenario = 'moderate'; mult = strength ? 1.6 : 1.3; } else {
    scenario = 'large';
    mult = strength && fat !== null && fat < LEAN_BF[s] ? 1.9 : 1.6;
  }
  if (age >= 65) mult = Math.max(mult, 1.2);
  if (deficit > 40) warnings.push('EXTREME_DEFICIT');
  else if (deficit >= 25) warnings.push('BIG_DEFICIT');
  if (!strength) warnings.push('NO_TRAINING');
  const g = ceil5(mult * ref);
  // На прийом — щонайменше 0,3 г/кг опорної ваги (65+ — 0,4), але три прийоми не більше за норму
  const perMeal = Math.max(5, Math.min(round5(Math.max(g / 4, (age >= 65 ? 0.4 : 0.3) * ref)), floor5(g / 3)));
  return { g, mult, ref: Math.round(ref * 10) / 10, scenario, warnings, perMeal };
}

/** Дефіцит, цілі % від стабільної витрати burn для плану kcal; менше DEFICIT_NOISE — 0; витрата невідома — null. */
export function deficitPct(burn, kcal) {
  if (!(burn > 0) || !Number.isFinite(kcal)) return null;
  const d = Math.round(((burn - kcal) / burn) * 100);
  return d < DEFICIT_NOISE ? Math.min(d, 0) : d;
}

/** Вхід для proteinMin з цілі: null — мінімум не налаштовано чи вимкнено; { missing: true } — бракує зросту чи року народження. */
export function proteinInput(goal, kg, date) {
  const p = goal?.protein;
  if (!p || p.off || !['yes', 'no'].includes(p.strength)) return null;
  const age = Number(date.slice(0, 4)) - goal.birthYear;
  if (!(goal.height > 0) || !(age > 0) || !(kg > 0)) return { missing: true };
  return {
    kg, height: goal.height, age, sex: goal.sex ?? null,
    strength: p.strength === 'yes', medical: Boolean(p.medical),
    bodyFat: Number.isFinite(p.bodyFat) ? p.bodyFat : null, refMode: p.ref === 'spec' ? 'spec' : 'smooth', mealTip: Boolean(p.mealTip),
  };
}

/**
 * Мінімум білка для плану калорій: hold — утримання (дефіцит 0); burn — стабільна витрата; kcal — план.
 * Без витрати на схудненні — GUESS_DEFICIT і guessed. Повертає результат proteinMin з deficit і guessed або вхід як є (null, missing).
 */
export function proteinFor(input, { hold = false, burn = null, kcal = null } = {}) {
  if (!input || input.missing) return input;
  let deficit = hold ? 0 : deficitPct(burn, kcal);
  const guessed = deficit === null;
  if (guessed) deficit = GUESS_DEFICIT;
  const r = proteinMin({ ...input, deficit });
  return r && { ...r, deficit, guessed, hold, mealTip: input.mealTip };
}

/**
 * Зведення як у блоці «СВОДКА» таблиці.
 * База втрати й темпу — перше середнє за 7 днів (а не перше зважування): так у таблиці.
 * Прогноз іде недавнім темпом (за 4 тижні), а поки історії менше — темпом від початку.
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
  const weeks = base && cur ? activeDays(g.pauses, base.date, cur.date) / 7 : 0;
  const rate = weeks > 0 ? lost / weeks : null;
  const recent = recentRate(rows, g.pauses);
  const forecastRate = recent ?? rate;
  const target = Number.isFinite(g.target) ? g.target : null;
  const toGo = target !== null && current !== null ? r2(current - target) : null;
  const hold = isHold(g);
  /** Дата, коли середнє дійде до kg темпом прогнозу (паузи попереду відсувають); null — темп не на зниження. */
  const eta = (kg) => (!hold && forecastRate > 0 && current > kg
    ? addActiveDays(g.pauses, currentDate, Math.round(((current - kg) / forecastRate) * 7)) : null);
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
    recent,
    forecastRate,
    target,
    toGo,
    hold,
    band: holdBand(g),
    days: rows.length,
    weeksLeft: !hold && forecastRate > 0 && toGo > 0 ? Math.ceil(toGo / forecastRate) : null,
    finish: target !== null ? eta(target) : null,
    eta,
    plan,
    planDiff: plan !== null && current !== null ? r2(current - plan) : null,
    progress: !hold && span > 0 ? Math.min(1, Math.max(0, lost / span)) : null,
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
 * Кожна: { kg, note, by, isTarget, reached, eta } — by: до якої дати хочеться дійти (необов'язково).
 */
export function checkpoints(rows, goal, sum) {
  const list = (goal.checkpoints ?? []).filter((c) => Number.isFinite(c.kg) && c.kg !== sum.target)
    .map((c) => ({ ...c, isTarget: false }));
  if (sum.target !== null) list.push({ id: 'target', kg: sum.target, note: '', isTarget: true, by: goal.targetBy || null });
  return list.sort((a, b) => b.kg - a.kg).map((c) => {
    const reached = reachedOn(rows, c.kg);
    return { ...c, reached, eta: reached ? null : sum.eta(c.kg) };
  });
}

/** Понеділок тижня, до якого належить дата. */
export const weekStart = (iso) => addDays(iso, -((new Date(utc(iso)).getUTCDay() + 6) % 7));

/**
 * Зміна середнього за кожен тиждень (пн–нд): останнє середнє тижня мінус останнє середнє попереднього тижня
 * з даними. Перший тиждень із середнім порівняти нема з чим — його немає. [{ from, to, v }]
 */
export function weeklyChanges(rows) {
  const ends = new Map();
  for (const r of rows) if (r.avg !== null) ends.set(weekStart(r.date), r.avg);
  const weeks = [...ends].sort(([a], [b]) => (a < b ? -1 : 1));
  return weeks.slice(1).map(([from, avg], i) => ({ from, to: addDays(from, 6), v: r2(avg - weeks[i][1]) }));
}

/** Зведення за дні [a, b]: зміна (за середнім, а де його ще нема — за вагою), мінімум і максимум ваги. */
export function periodStats(rows, a, b) {
  const list = rows.filter((r) => r.date >= a && r.date <= b);
  if (!list.length) return null;
  const avgs = list.filter((r) => r.avg !== null);
  const by = avgs.length >= 2 ? avgs.map((r) => r.avg) : list.map((r) => r.kg);
  const kgs = list.map((r) => r.kg);
  return { change: by.length >= 2 ? r2(by.at(-1) - by[0]) : null, min: Math.min(...kgs), max: Math.max(...kgs) };
}

export const SIZES_ID = 'sizes';
export const HEALTH_ID = 'health';
const SIZE_LETTERS = /^(\d?X{0,3}[SML]|X{1,3}L|\d?XL)$/i;

/**
 * Розміри з тексту, рядок — один розмір: { label, value }. Назву від значення відділяє «:», « — »,
 * табуляція, а без них — перше слово, що починається з цифри чи є літерним розміром (S…XXL).
 * Рядок, що починається з числа («58/4 форма»), — навпаки: число — значення, решта — назва.
 */
export function parseSizes(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const split = line.match(/^(.+?)\s*(?::|\t|\s[—–-]\s)\s*(.+)$/);
    if (split) return { label: split[1], value: split[2] };
    const lead = line.match(/^(\d\S*?)[.,;]?\s+(.+)$/);
    if (lead) return { label: lead[2], value: lead[1] };
    const words = line.split(/\s+/);
    const at = words.findIndex((w, i) => i > 0 && (/^\d/.test(w) || SIZE_LETTERS.test(w)));
    return at > 0 ? { label: words.slice(0, at).join(' '), value: words.slice(at).join(' ') } : { label: line, value: '' };
  });
}

/** Знімок розмірів на дату — налаштування sizes:<дата> { text }; поточні розміри лишаються в sizes. */
export const SIZES_PREFIX = 'sizes:';
const isoOfMs = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Знімки розмірів від старого до нового: { id, date, text }. Поки знімків нема, поточний текст — єдиний
 * знімок із датою останнього збереження та id null (його ще не записано окремо).
 */
export function sizeSnapshots(settings) {
  const list = settings.filter((s) => s.id.startsWith(SIZES_PREFIX))
    .map((s) => ({ id: s.id, date: s.id.slice(SIZES_PREFIX.length), text: s.text ?? '' }));
  if (!list.length) {
    const cur = settings.find((s) => s.id === SIZES_ID);
    if (cur?.text?.trim() && cur.updated) list.push({ id: null, date: isoOfMs(cur.updated), text: cur.text });
  }
  return list.sort((a, b) => (a.date < b.date ? -1 : 1));
}

const sizeKey = (label) => label.trim().toLowerCase();

/** Значення розмірів тексту як { назва: значення } — порівняти два знімки. */
export function sizeValues(text) {
  return Object.fromEntries(parseSizes(text).map((s) => [sizeKey(s.label), s.value]));
}

export const sameSizes = (a, b) => JSON.stringify(Object.entries(sizeValues(a)).sort())
  === JSON.stringify(Object.entries(sizeValues(b)).sort());

/** Поточні розміри з історією змін: { label, value, history: [{ date, value }] } — history від нового до старого. */
export function sizeHistory(text, snaps) {
  const parsed = snaps.map((s) => ({ date: s.date, values: sizeValues(s.text) }));
  return parseSizes(text).map((s) => {
    const key = sizeKey(s.label);
    const history = [];
    for (const snap of parsed) {
      if (!(key in snap.values)) continue;
      if (history.at(-1)?.value !== snap.values[key]) history.push({ date: snap.date, value: snap.values[key] });
    }
    return { ...s, history: history.reverse() };
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
