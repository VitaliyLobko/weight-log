// Раціон на день з ШІ: ціль (ккал і БЖВ) рахує застосунок, страви добирає модель через бота,
// порції під ціль підганяє застосунок; невдалу страву можна перекинути, готовий день — раціон з сьогодні.
import * as M from './model.js';
import * as bot from './bot.js';
import { h, fmt, sheet, toast, btn, segmented, confirmSheet, parseNum } from './ui.js';
import { t } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { fromModel, fromPer100 } from './foods.js';
import { planOf, mealsToday, fixedToday, totals, replaceRation, revertRation, lastReplace, undoToast, proteinWarnings, NO_CALC_TEXT } from './nutrition.js';
import { foodsOf, voiceControl } from './daylog.js';

const DRAFT_KEY = 'weight-log:ai-ration';
const MODES = [['loss', 'Схуднення'], ['hold', 'Утримання'], ['custom', 'Свої ккал']];
const RATE_KEY = 'weight-log:ai-rate';
// Темп схуднення, кг на тиждень
export const RATES = [[0.25, 'Легко'], [0.5, 'Помірно'], [0.75, 'Активно'], [1, 'Інтенсивно']];
const r10 = (v) => Math.round(v / 10) * 10;

/** Темп за замовчуванням: останній вибраний, інакше найближчий до плану з «Цілі», інакше «Помірно». */
function defaultRate(planRate) {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    if (RATES.some(([r]) => r === v)) return v;
  } catch { /* приватне вікно */ }
  if (!(planRate > 0)) return 0.5;
  return RATES.reduce((best, [r]) => (Math.abs(r - planRate) < Math.abs(best - planRate) ? r : best), RATES[0][0]);
}

/**
 * Ціль дня: a — { burn, base, bmr, sex, planRate, kg, target, protein } з app.js (null — даних для норми нема); mode — loss | hold | custom;
 * rate — темп схуднення, кг/тиж. Дефіцит = темп × 7700 / 7, не більше 1000 ккал і не нижче 1500 ккал чоловікам (1200 — жінкам).
 * Понад чверть витрати чи нижче базового обміну — лише попередження (limits 'hard', 'bmr'), рішення за людиною.
 * Білок: налаштовано «Мінімум білка» — саме мінімум (prot), стеля 35 % його не зрізає; лікар обмежив — звичайні 15 % ккал;
 * не налаштовано — як раніше: на кг цільової ваги 1,8 г при схудненні, 1,4 — на утриманні (не більше 35 % ккал).
 * Жири — 28 %; решта — вуглеводи.
 */
export function rationTarget(a, mode, custom, rate = 0.5) {
  const burn = Math.round(a?.burn ?? 0);
  const floor = M.kcalFloor(a?.sex);
  const limits = [];
  let kcal;
  if (mode === 'custom' || !burn) kcal = custom;
  else if (mode === 'hold') kcal = burn;
  else {
    const l = M.lossKcal(burn, rate, a.sex);
    kcal = l.kcal;
    if (l.capped) limits.push('cap');
    if (l.floored) limits.push('floor');
    if (burn - kcal > burn * 0.25) limits.push('hard');
    if (a.bmr && kcal < a.bmr) limits.push('bmr');
  }
  kcal = r10(Number(kcal) || 0);
  const deficit = burn ? burn - kcal : null;
  // Сценарій білка — від стабільної витрати: прогулянка дня не перекидає норму через межу 25 %
  const base = a?.base > 0 ? a.base : burn;
  const prot = a?.protein ? M.proteinFor(a.protein, { hold: mode === 'hold', burn: base, kcal: deficit !== null ? base - deficit : null }) : null;
  const ref = mode !== 'hold' && a?.target > 0 && a.target < a.kg ? a.target : (a?.kg || 70);
  let p;
  if (prot?.g) p = prot.g;
  else if (prot?.g === null) p = Math.round((kcal * 0.15) / 4);
  else p = Math.min(Math.round((mode === 'hold' ? 1.4 : 1.8) * ref), Math.round((kcal * 0.35) / 4));
  const f = Math.round((kcal * 0.28) / 9);
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  return { kcal, p, f, c, burn, floor, bmr: Math.round(a?.bmr ?? 0), deficit, weekKg: deficit !== null ? (deficit * 7) / M.KCAL_PER_KG : null, limits, ref, prot };
}

// Частки дня, коли в плані прийоми без калорій
const SHARES = { 1: [1], 2: [0.45, 0.55], 3: [0.3, 0.4, 0.3], 4: [0.25, 0.35, 0.1, 0.3] };

/**
 * Ккал на кожен прийом: у пропорціях вашого плану, порожній план — звичайні частки дня.
 * fixed — { day, pause } з fixedToday: добавка в паузу знімається з усього дня, продукт дня — зі свого прийому.
 */
export function mealBudgets(meals, kcal, fixed = { day: null, pause: 0 }) {
  const sum = meals.reduce((a, m) => a + m.kcal, 0);
  const def = SHARES[meals.length] ?? meals.map(() => 1 / meals.length);
  const rest = kcal - (fixed.pause || 0);
  return meals.map((m, i) => {
    const share = rest * (sum > 0 ? m.kcal / sum : def[i]);
    return { ...m, kcal: Math.max(0, r10(share - (fixed.day?.meal === m.id ? fixed.day.kcal : 0))) };
  });
}

const fixedKcal = (fixed) => (fixed.day?.kcal || 0) + (fixed.pause || 0);

const GRAM_QTY = /^\s*\d+(?:[.,]\d+)?\s*(г|гр|грам\S*|мл)\.?\s*$/i;
// Підганяти можна лише страву в грамах: «2 яйця» лишаються двома
const scalable = (x) => x.per100 && x.grams > 0 && (!x.qty || GRAM_QTY.test(x.qty));
const roundGrams = (g) => (g < 60 ? Math.max(5, Math.round(g / 5) * 5) : Math.round(g / 10) * 10);
const regram = (x, g) => ({ ...x, grams: g, qty: `${fmt.int(g)} ${/мл/i.test(x.qty ?? '') ? t('мл') : t('г')}`, ...fromPer100(x.per100, g) });

/** Порції прийому під його ккал: міняються лише страви в грамах і не більш ніж у 0,6–1,6 раза. */
export function fitMeal(items, kcal) {
  const all = totals(items).kcal;
  const free = items.filter(scalable);
  const fixed = all - totals(free).kcal;
  const base = all - fixed;
  if (!free.length || base <= 0) return items;
  const k = Math.min(1.6, Math.max(0.6, (kcal - fixed) / base));
  if (Math.abs(k - 1) < 0.03) return items;
  return items.map((x) => (scalable(x) ? regram(x, roundGrams(x.grams * k)) : x));
}

/** Від моделі → продукт застосунку: значення з довідника, якщо він знає цю їжу. */
const toItem = (raw) => {
  const x = fromModel(raw);
  return { ...x, qty: x.qty || (x.grams ? `${fmt.int(x.grams)} ${t('г')}` : '') };
};

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return d?.date === M.today() ? d : null;
  } catch { return null; }
}
function saveDraft(d) {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* приватне вікно */ }
}

/** Що людина зазвичай їсть: продукти плану й «Мої продукти» (частіші — першими). */
function usualFoods(state) {
  const plan = planOf(state);
  const mine = [...foodsOf(state)].sort((a, b) => (b.used || 0) - (a.used || 0));
  return [...new Set([...mealsToday(state).flatMap((m) => m.items), ...(plan?.day?.items ?? []), ...mine]
    .map((x) => String(x.name ?? '').trim()).filter(Boolean))].slice(0, 60);
}

const ERRORS = {
  'no-bot': 'Раціон з ШІ працює через Telegram-бота — підключіть його в «Даних».',
  offline: 'Нема мережі — спробуйте пізніше.',
  limit: 'Ліміт запитів до ШІ на сьогодні вичерпано — спробуйте завтра.',
  'no-ai': 'У бота не підключено ШІ.',
  'old-bot': 'Бот ще не вміє складати раціон — його треба оновити.',
  busy: 'ШІ зараз перевантажений — спробуйте за хвилину.',
};
const errorText = (err) => t(ERRORS[err?.message] ?? 'Не вдалося скласти раціон — спробуйте ще раз.');

const macroLine = (x) => t('Б {p} · Ж {f} · В {c}', { p: fmt.int(x.p), f: fmt.int(x.f), c: fmt.int(x.c) });

/** Шторка «Раціон з ШІ»: ціль, побажання, складений день з «🔄» на кожній страві, «Замінити раціон з сьогодні». */
export function aiRationSheet(state, aim) {
  const a = aim?.() ?? null;
  const meals = mealsToday(state);
  const fixed = fixedToday(state);
  let draft = loadDraft();
  const form = {
    mode: draft?.mode ?? (a?.hold ? 'hold' : 'loss'),
    custom: draft?.custom ?? (a ? r10(a.burn - 500) : 2000),
    wishes: draft?.wishes ?? '',
    diet: draft?.diet ?? true,
    rate: draft?.rate ?? defaultRate(a?.planRate),
  };
  if (!a) form.mode = 'custom';
  const target = () => rationTarget(a, form.mode, form.custom, form.rate);

  // Ціль — пояснення розрахунку
  const targetEl = h('div', { class: 'ai-target' });
  const paintTarget = () => {
    const tg = target();
    const src = a?.source === 'real' ? t('за вашими даними') : t('за формулою');
    const lines = [];
    // З мінімумом білка попередження про дефіцит — його (25 % / 40 % від стабільної витрати), а не загальне «понад чверть»
    const protWarn = tg.prot?.g ? proteinWarnings(tg.prot).filter((w) => w.code.endsWith('DEFICIT')).map((w) => w.text) : null;
    if (!a) lines.push(t('Для норми бракує зросту, статі чи року народження — їх вказують у «Цілі». Поки — свої ккал.'));
    else if (form.mode === 'hold') lines.push(t('Витрата {b} ({s}) — без дефіциту.', { b: fmt.int(tg.burn), s: src }));
    else if (form.mode === 'loss') {
      lines.push(t('Витрата {b} ({s}) − дефіцит {d} ≈ {w} кг на тиждень.', { b: fmt.int(tg.burn), s: src, d: fmt.int(tg.deficit), w: fmt.fix(tg.weekKg, 2) }));
      if (tg.limits.includes('cap')) lines.push(t('Дефіцит обмежено {m} ккал на день.', { m: fmt.int(M.MAX_DEFICIT) }));
      if (tg.limits.includes('floor')) lines.push(t('Не нижче {f} ккал на день — менше не варто навіть для швидкого схуднення.', { f: fmt.int(tg.floor) }));
      // Лікар обмежив білок — без «білок обов'язково»
      const hardText = tg.prot?.g === null ? t('Дефіцит понад чверть витрати: важче втримати, частина втрати — м\'язи.')
        : t('Дефіцит понад чверть витрати: важче втримати, частина втрати — м\'язи. Білок — обов\'язково.');
      if (protWarn ? protWarn.length : tg.limits.includes('hard')) lines.push(...(protWarn ?? [hardText]));
      else if (tg.limits.includes('bmr')) lines.push(t('Нижче базового обміну ({b}) — при дефіциті це нормально.', { b: fmt.int(tg.bmr) }));
    } else if (tg.burn && tg.kcal) {
      lines.push(tg.deficit >= 0 ? t('Витрата {b}: дефіцит {d} ≈ {w} кг на тиждень.', { b: fmt.int(tg.burn), d: fmt.int(tg.deficit), w: fmt.fix(tg.weekKg, 2) })
        : t('Витрата {b}: профіцит {d}.', { b: fmt.int(tg.burn), d: fmt.int(-tg.deficit) }));
      if (tg.kcal < tg.floor) lines.push(t('Менше {f} ккал на день — так довго не варто.', { f: fmt.int(tg.floor) }));
      else if (tg.bmr && tg.kcal < tg.bmr) lines.push(t('Нижче базового обміну ({b}) — при дефіциті це нормально.', { b: fmt.int(tg.bmr) }));
      if (protWarn) lines.push(...protWarn);
    }
    // Продукт дня й добавка в паузу лишаються — ШІ добирає решту
    if (fixed.day) lines.push(t('Продукт дня «{n}» ({k} ккал) лишається — ШІ добере решту.', { n: fixed.day.name, k: fmt.int(fixed.day.kcal) }));
    if (fixed.pause) lines.push(t('Добавка в паузу ({k} ккал) лишається — ШІ добере решту.', { k: fmt.int(fixed.pause) }));
    const rest = { f: fmt.int(tg.f), c: fmt.int(tg.c) };
    const pr = tg.prot;
    let macro;
    if (pr?.g) {
      macro = pr.warnings.includes('BMI_ADJUSTED')
        ? t('Білки {p} г — мінімум для м\'язів, {k} г на кг опорної ваги {w} кг · жири {f} г · вуглеводи {c} г', { p: fmt.int(tg.p), k: fmt.fix(pr.mult, 1), w: fmt.fix(pr.ref, 1), ...rest })
        : t('Білки {p} г — мінімум для м\'язів, {k} г на кг ваги · жири {f} г · вуглеводи {c} г', { p: fmt.int(tg.p), k: fmt.fix(pr.mult, 1), ...rest });
    } else if (pr?.g === null) {
      macro = t('Білки {p} г — звичайна частка, без акценту на білок · жири {f} г · вуглеводи {c} г', { p: fmt.int(tg.p), ...rest });
    } else {
      macro = t('Білки {p} г ({k} г на кг ваги {w}) · жири {f} г · вуглеводи {c} г', {
        p: fmt.int(tg.p), k: form.mode === 'hold' ? '1,4' : '1,8', w: fmt.fix(tg.ref, 0), ...rest,
      });
    }
    // Мінімум білка не налаштовано — підказка, де це зробити
    const setup = a?.setupProtein && !pr ? h('button', {
      type: 'button', class: 'link-btn small ai-protein-setup', onclick: () => { close(); a.setupProtein(); },
    }, t('Точніше — «Мінімум білка» в налаштуваннях: силові, обмеження від лікаря')) : null;
    targetEl.replaceChildren(...[
      h('div', { class: 'ai-target-kcal' }, h('b', {}, fmt.int(tg.kcal)), ` ${t('ккал на день')}`),
      ...lines.map((l) => h('p', { class: 'small muted' }, l)),
      pr?.g === null ? h('p', { class: 'small food-check' }, icon('warning'), h('span', {}, t(NO_CALC_TEXT))) : null,
      h('p', { class: 'small' }, macro),
      setup,
    ].filter(Boolean));
  };

  const customInput = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', name: 'kcal', value: String(form.custom) });
  customInput.addEventListener('input', () => { form.custom = parseNum(customInput.value) || 0; paintTarget(); });
  const customField = h('label', { class: 'field', hidden: form.mode !== 'custom' }, h('span', { class: 'field-label' }, t('Ккал на день')), customInput);
  // Темп схуднення: тягнеш — ціль одразу перераховується
  const rateIdx = () => Math.max(0, RATES.findIndex(([r]) => r === form.rate));
  const rateValue = h('b', { class: 'ai-rate-value' });
  const paintRate = () => {
    const [r, label] = RATES[rateIdx()];
    rateValue.textContent = t('{l} · {r} кг на тиждень', { l: t(label), r: fmt.fix(r, r % 0.5 ? 2 : 1) });
  };
  const rateInput = h('input', {
    type: 'range', min: '0', max: String(RATES.length - 1), step: '1', value: String(rateIdx()), name: 'rate',
    'aria-label': t('Темп схуднення'),
    oninput: (e) => {
      form.rate = RATES[Number(e.target.value)][0];
      try { localStorage.setItem(RATE_KEY, String(form.rate)); } catch { /* приватне вікно */ }
      paintRate();
      paintTarget();
    },
  });
  const rateField = h('div', { class: 'field ai-rate', hidden: form.mode !== 'loss' },
    h('div', { class: 'ai-rate-head' }, h('span', { class: 'field-label' }, t('Темп')), rateValue),
    rateInput,
    h('div', { class: 'ai-rate-ticks', 'aria-hidden': 'true' }, RATES.map(([, l], i) => h('span', { style: `left: ${(i / (RATES.length - 1)) * 100}%` }, t(l)))));
  paintRate();
  const modes = segmented(MODES.filter(([k]) => a || k === 'custom').map(([k, l]) => [k, t(l)]), form.mode, (v) => {
    form.mode = v;
    customField.hidden = v !== 'custom';
    rateField.hidden = v !== 'loss';
    paintTarget();
  });

  const wishes = h('textarea', { rows: 2, maxlength: 300, placeholder: t('Побажання: без риби, швидко, з того, що є вдома…') });
  wishes.value = form.wishes;
  wishes.addEventListener('input', () => { form.wishes = wishes.value.trim(); });
  let said = '';
  const voice = voiceControl({
    label: t('Сказати побажання'),
    onStart: () => { said = wishes.value.trim(); },
    onText: (s) => { wishes.value = [said, s].filter(Boolean).join(', '); },
    onDone: (s) => { wishes.value = [said, s].filter(Boolean).join(', '); form.wishes = wishes.value.trim(); },
  });
  const diet = h('input', { type: 'checkbox', checked: form.diet });
  diet.addEventListener('change', () => { form.diet = diet.checked; });

  // Модель добирає лише прийоми: ккал і БЖВ — без продукту дня й добавки в паузу
  const askBody = (tg, budgets, f, swap) => {
    const k = tg.kcal > 0 ? Math.max(0, tg.kcal - fixedKcal(fixed)) / tg.kcal : 1;
    return {
      goal: f.mode === 'hold' ? 'hold' : 'loss', kcal: Math.round(tg.kcal * k), p: Math.round(tg.p * k), f: Math.round(tg.f * k), c: Math.round(tg.c * k),
    // Лікар обмежив білок — першим у побажаннях (бот їх обрізає до 300 знаків): інакше «схуднення» в боті додасть білка
    diet: f.diet ? 'diabetes' : '', foods: usualFoods(state),
    wishes: [tg.prot?.g === null ? t('Лікар обмежив білок: не більше {p} г білка за день, без акценту на білкові страви', { p: Math.round(tg.p * k) }) : '', f.wishes]
      .filter(Boolean).join('. '),
      meals: budgets.map(({ id, name, time, kcal }) => ({ id, name, time, kcal })),
      ...(swap ? { swap } : {}),
    };
  };

  const goLabel = () => withIcon('spark', draft ? t('Інший варіант') : t('Підібрати раціон'));
  const go = btn(goLabel(), () => generate(), 'primary ai-go');
  const generate = async () => {
    const tg = target();
    if (!(tg.kcal >= 800)) { toast(t('Вкажіть ккал на день — від 800')); customInput.focus(); return; }
    const budgets = mealBudgets(meals, tg.kcal, fixed).filter((m) => m.kcal >= 50);
    if (!budgets.length) { toast(t('Спершу додайте прийоми їжі')); return; }
    go.disabled = true;
    go.replaceChildren(...withIcon('spark', t('Складаю раціон…')));
    try {
      const r = await bot.askRation(askBody(tg, budgets, form));
      const got = budgets.map((b) => {
        const m = (r.meals ?? []).find((x) => x.id === b.id);
        return m?.items?.length ? { id: b.id, name: b.name, time: b.time, kcal: b.kcal, items: fitMeal(m.items.map(toItem), b.kcal) } : null;
      }).filter(Boolean);
      if (!got.length) { toast(r.note || t('ШІ не склав раціон — спробуйте ще раз.')); return; }
      draft = { date: M.today(), ...form, target: tg, meals: got, rejected: {}, note: r.note ?? '' };
      saveDraft(draft);
      paintDraft();
      // Складений день — нижче форми: одразу до нього
      draftEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(errorText(err));
    } finally {
      go.disabled = false;
      go.replaceChildren(...goLabel());
    }
  };

  // Інша страва замість однієї: ті ж ккал, не з уже відкинутих і не з решти прийому
  const reroll = async (meal, i, b) => {
    const old = meal.items[i];
    const rejected = [...(draft.rejected[meal.id] ?? []), old.name];
    b.disabled = true;
    b.classList.add('busy');
    try {
      const r = await bot.askRation(askBody(draft.target, draft.meals, draft, {
        meal: meal.id, kcal: Math.max(10, Math.round(old.kcal)), keep: meal.items.filter((_, j) => j !== i).map((x) => x.name), reject: rejected,
      }));
      const raw = (r.meals ?? []).find((x) => x.id === meal.id)?.items?.[0];
      if (!raw || rejected.some((n) => n.toLowerCase() === String(raw.name).toLowerCase())) { toast(t('Не знайшов заміни — спробуйте ще раз.')); return; }
      meal.items[i] = fitMeal([toItem(raw)], old.kcal)[0];
      draft.rejected[meal.id] = rejected;
      saveDraft(draft);
      paintDraft();
    } catch (err) {
      toast(errorText(err));
    } finally {
      b.disabled = false;
      b.classList.remove('busy');
    }
  };

  const draftEl = h('div', { class: 'ai-draft' });
  const apply = btn(t('Замінити раціон з сьогодні'), () => applyDraft(), 'primary ai-apply');
  const itemRow = (meal, x, i) => {
    const re = h('button', { type: 'button', class: 'icon-btn tool ai-reroll', 'aria-label': t('Інша страва'), title: t('Інша страва') }, icon('sync'));
    re.addEventListener('click', () => reroll(meal, i, re));
    return h('div', { class: 'row ai-item' },
      h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.name),
        h('span', { class: 'row-sub muted small' }, [x.qty, macroLine(x)].filter(Boolean).join(' · '))),
      h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(x.kcal))),
      re);
  };
  const paintDraft = () => {
    go.replaceChildren(...goLabel());
    apply.hidden = !draft;
    if (!draft) { draftEl.replaceChildren(); return; }
    const all = totals(draft.meals.flatMap((m) => m.items));
    // Разом за день — з продуктом дня й добавкою в паузу, як потім покаже «Сьогодні»
    const plus = fixedKcal(fixed);
    const day = all.kcal + plus;
    // Порції підганяються не більш ніж у 1,6 раза — великий промах ШІ видно й пояснено
    const miss = day - draft.target.kcal;
    draftEl.replaceChildren(...[
      h('div', { class: 'ai-total' }, h('b', {}, t('{n} ккал', { n: fmt.int(day) })),
        h('span', { class: 'muted' }, ` ${t('з {k}', { k: fmt.int(draft.target.kcal) })} · ${macroLine(all)}`),
        plus ? h('span', { class: 'muted small' }, ` · ${t('з них {k} — продукт дня й добавки', { k: fmt.int(plus) })}`) : null),
      Math.abs(miss) > draft.target.kcal * 0.1 ? h('p', { class: 'small food-check' }, icon('warning'), h('span', {},
        t(miss < 0 ? 'Менше цілі на {d} ккал — спробуйте «Інший варіант» або «🔄» на легких стравах.' : 'Більше цілі на {d} ккал — спробуйте «Інший варіант» або «🔄» на важких стравах.', { d: fmt.int(Math.abs(miss)) }))) : null,
      ...draft.meals.map((m) => h('section', { class: 'ai-meal' },
        h('div', { class: 'food-sub-head' }, h('h4', { class: 'food-sub' }, m.name),
          h('span', { class: 'muted small' }, t('{n} з {k} ккал', { n: fmt.int(totals(m.items).kcal), k: fmt.int(m.kcal) }))),
        h('div', { class: 'rows' }, m.items.map((x, i) => itemRow(m, x, i))))),
      draft.note ? h('p', { class: 'small muted ai-note' }, icon('spark'), ' ', draft.note) : null,
      h('p', { class: 'small muted' }, t('Не подобається страва — «🔄» дасть іншу на ті ж калорії.')),
    ].filter(Boolean));
  };

  const applyDraft = () => {
    const names = draft.meals.map((m) => m.name).join(', ');
    confirmSheet(t('Замінити раціон з сьогодні?'),
      t('Страви прийомів «{list}» зміняться з сьогодні — і в уже з\'їдених сьогодні прийомах теж. Минулі дні й норма лишаться як були; повернути можна тут же — «Повернути попередній раціон».', { list: names }),
      t('Замінити'), async () => {
        const before = await replaceRation(draft.meals.map((m) => ({ id: m.id, items: m.items })));
        draft = null;
        saveDraft(null);
        close();
        undoToast(t('Раціон замінено з сьогодні'), before);
      });
  };

  const since = lastReplace(planOf(state));
  const revert = since ? h('button', {
    type: 'button', class: 'link-btn ai-revert',
    onclick: () => confirmSheet(t('Повернути попередній раціон?'),
      t('Страви, які були до заміни {date}, повернуться з сьогодні; минулі дні лишаться як були.', { date: fmt.date(since) }), t('Повернути'), async () => {
        const before = await revertRation();
        close();
        undoToast(t('Попередній раціон повернуто'), before);
      }),
  }, t('Повернути попередній раціон (до {date})', { date: fmt.date(since) })) : null;

  const body = h('div', { class: 'ai-ration' }, ...[
    bot.botConfig().from ? null : h('p', { class: 'small food-check' }, icon('warning'), h('span', {}, t(ERRORS['no-bot']))),
    modes, customField, rateField, targetEl,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Побажання')), wishes),
    voice,
    h('label', { class: 'check-row' }, diet, h('span', {}, t('Як при діабеті: без цукру й швидких вуглеводів'))),
    go, draftEl, revert,
  ].filter(Boolean));
  paintTarget();
  paintDraft();
  const close = sheet(t('Раціон з ШІ'), body, {
    onClose: () => voice?.cancel(),
    actions: [btn(t('Закрити'), () => close()), apply],
  });
}
