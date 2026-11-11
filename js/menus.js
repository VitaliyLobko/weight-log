// Меню на день: збережені варіанти дня — з «Раціону з ШІ» чи копія дня з правкою. Вибране меню діє лише на свій день:
// у запис дня йде копія, тож пізніша правка чи видалення меню минулих днів не змінює.
import * as db from './db.js';
import * as M from './model.js';
import { h, fmt, sheet, toast, btn, toolBtn, confirmSheet } from './ui.js';
import { t } from './i18n.js';
import { icon, withIcon } from './icons.js';
import { planOf, mealsToday, totals } from './nutrition.js';
import { dayOf, dayState, setDayMenu, countFood, voiceControl } from './daylog.js';

export const MENUS_ID = 'nutrition-menus';
const KEYS = ['kcal', 'p', 'f', 'c'];
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const kcal = (v) => t('{n} ккал', { n: fmt.int(v) });
const macroLine = (x) => t('Б {p} · Ж {f} · В {c}', { p: fmt.int(x.p), f: fmt.int(x.f), c: fmt.int(x.c) });

export const menusOf = (state) => state?.settings.find((s) => s.id === MENUS_ID)?.items ?? [];

/** Меню, що стоїть у записі дня (копія); нема — null. */
export const dayMenu = (state, date) => {
  const m = dayOf(state, date)?.menu;
  return Array.isArray(m?.meals) ? m : null;
};

/** Страва для меню: лише їжа й числа, свій новий id — не з плану й не з чернетки ШІ. */
const dish = (x) => ({
  id: newId(), name: String(x.name ?? '').trim(), qty: x.qty ?? '',
  ...(x.grams > 0 ? { grams: x.grams } : {}), ...(x.per100 ? { per100: x.per100 } : {}),
  ...Object.fromEntries(KEYS.map((k) => [k, Math.round((Number(x[k]) || 0) * 10) / 10])),
});

const menuMeals = (meals) => meals.map((m) => ({ id: m.id, name: m.name, time: m.time ?? '', items: (m.items ?? []).map(dish) }));
export const menuTotals = (menu) => totals(menu.meals.flatMap((m) => m.items ?? []));
/** Копія меню для запису дня. */
const snapshot = (menu) => ({ id: menu.id, name: menu.name, meals: menu.meals });

async function writeMenus(change) {
  const before = menusOf(await db.loadAll());
  await db.write({ settings: { put: [{ id: MENUS_ID, items: change(JSON.parse(JSON.stringify(before))) }] } });
  return before;
}
const restoreMenus = (before) => db.write({ settings: { put: [{ id: MENUS_ID, items: before }] } });

/** Нове меню в бібліотеці: meals — [{ id, name, time, items }]; страви отримують нові id. → меню. */
export async function addMenu({ name, src, meals }) {
  const menu = { id: newId(), name, src, created: M.today(), meals: menuMeals(meals) };
  await writeMenus((list) => [menu, ...list]);
  return menu;
}

/** Шторка «Назва меню»: name підставлено й виділено — одразу пишеться своя; onSave(назва). */
export function nameSheet(name, meals, onSave) {
  const input = h('input', { type: 'text', autocomplete: 'off', maxlength: 60, name: 'menu-name' });
  input.value = name;
  const s = totals(meals.flatMap((m) => m.items ?? []));
  const ok = btn(t('Зберегти'), () => {
    const v = input.value.trim();
    if (!v) { input.focus(); toast(t('Вкажіть назву меню')); return; }
    close();
    onSave(v);
  }, 'primary');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
  const close = sheet(t('Зберегти як меню'), h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Назва')), input),
    h('p', { class: 'small muted' }, `${kcal(s.kcal)} · ${macroLine(s)}`)), {
    actions: [btn(t('Скасувати'), () => close()), ok],
  });
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

/** Меню на день date. */
export const useMenu = (date, menu) => setDayMenu(date, snapshot(menu));

/**
 * Шторка страви: числа й «Перенести в: …» інші прийоми; extra — ще кнопки (видалити тощо).
 * meals — прийоми, серед яких переносимо; onMove(to) робить сам перенос.
 */
export function dishSheet(x, { meals, from, onMove, extra = null }) {
  const others = meals.filter((m) => m !== from);
  const close = sheet(x.name, h('div', { class: 'food-sheet' },
    h('div', { class: 'food-figures' }, x.qty ? h('b', {}, x.qty) : null, h('span', {}, kcal(x.kcal)), h('span', { class: 'muted' }, macroLine(x))),
    others.length ? h('div', { class: 'chips food-portion food-move', role: 'group', 'aria-label': t('Перенести в інший прийом') },
      h('span', { class: 'muted small' }, t('Перенести в:')),
      others.map((m) => h('button', { type: 'button', onclick: () => { close(); onMove(m); } }, m.name))) : null,
    extra ? h('div', { class: 'btn-row' }, extra(() => close())) : null));
  return close;
}

/** Рядок «Меню дня» в картці «Сьогодні»: за планом чи назва меню; тап — вибір. */
export function menuPicker(state, date = M.today()) {
  const cur = dayMenu(state, date);
  const n = menusOf(state).length;
  return h('button', { type: 'button', class: 'food-pick food-menu-pick', 'aria-haspopup': 'dialog', onclick: () => menuSheet(date) },
    h('span', { class: 'food-pick-main' },
      h('span', { class: 'food-pick-label' }, t('Меню дня')),
      h('b', {}, cur ? `${cur.name} · ${kcal(menuTotals(cur).kcal)}` : t('За планом')),
      !cur && n ? h('span', { class: 'food-pick-hint' }, t('збережених меню: {n}', { n })) : null),
    h('span', { class: 'chevron-right', 'aria-hidden': 'true' }, '›'));
}

/** Вибір меню на день date: «За планом», збережені меню (олівець — правка), «Зберегти день як меню». */
export function menuSheet(date) {
  const body = () => {
    const state = dayState();
    if (!state || !planOf(state)) return null;
    const cur = dayMenu(state, date);
    const list = menusOf(state);
    const row = (on, title, sub, onPick, tool = null) => h('div', { class: 'pick-item' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: `row pick-row ${on ? 'on' : ''}`, onclick: onPick },
        h('span', { class: 'pick-radio', 'aria-hidden': 'true' }),
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'muted small' }, sub) : null)),
      tool);
    const sub = (m) => {
      const s = menuTotals(m);
      return [m.src === 'ai' ? t('ШІ') : m.src === 'own' ? t('своє') : '', kcal(s.kcal), macroLine(s)].filter(Boolean).join(' · ');
    };
    const pick = (menu) => async () => {
      closeIt();
      if (menu ? cur?.id === menu.id : !cur) return;
      if (menu) await useMenu(date, menu); else await setDayMenu(date, null);
    };
    // Меню дня видалили з бібліотеки — день лишається на своїй копії
    const gone = cur && !list.some((m) => m.id === cur.id);
    return h('div', { class: 'pick-list' },
      h('div', { class: 'rows', role: 'radiogroup', 'aria-label': t('Меню дня') },
        row(!cur, t('За планом'), t('Прийоми з вкладки «Сьогодні»'), pick(null)),
        list.map((m) => row(cur?.id === m.id, m.name, sub(m), pick(m),
          toolBtn('edit', t('Змінити «{name}»', { name: m.name }), () => { closeIt(); menuEditor(m); }))),
        gone ? row(true, cur.name, t('видалене з меню — лишається на цей день'), () => closeIt()) : null),
      list.length ? null : h('p', { class: 'small muted' }, t('Збережених меню ще нема: збережіть день нижче або складіть у «Раціоні з ШІ» — «Зберегти як меню».')),
      h('div', { class: 'btn-row' }, btn(withIcon('plus', t('Зберегти день як меню')), async () => {
        closeIt();
        const meals = mealsToday(dayState(), date);
        const menu = await addMenu({ name: t('Мій день {d}', { d: fmt.date(date) }), src: 'own', meals });
        toast(t('Меню «{name}» збережено — змініть, що треба, і «Зберегти»', { name: menu.name }));
        menuEditor(menu);
      })),
      h('p', { class: 'small muted' }, t('Меню діє лише на цей день. Продукт дня й добавка в паузу лишаються.')));
  };
  const closeIt = sheet(t('Меню дня · {d}', { d: fmt.date(date) }), body(), { live: body });
}

/** Правка меню: назва, страви по прийомах — перенести, видалити, додати текстом чи голосом; видалити меню. */
export function menuEditor(menu) {
  const state = dayState();
  const work = JSON.parse(JSON.stringify(menu));
  const plan = (planOf(state)?.meals ?? []).map((m) => ({ id: m.id, name: m.name, time: m.time ?? '' }));
  // Прийоми — як у плані зараз, плюс прийоми меню, яких у плані вже нема
  const meals = [
    ...plan.map((pm) => ({ ...pm, items: work.meals.find((x) => x.id === pm.id)?.items ?? [] })),
    ...work.meals.filter((mm) => !plan.some((pm) => pm.id === mm.id)),
  ];
  const nameInput = h('input', { type: 'text', autocomplete: 'off', maxlength: 60, name: 'menu-name' });
  nameInput.value = work.name;
  const list = h('div', { class: 'menu-edit' });
  const paint = () => {
    const day = totals(meals.flatMap((m) => m.items));
    list.replaceChildren(
      h('p', { class: 'ai-total' }, h('b', {}, kcal(day.kcal)), h('span', { class: 'muted' }, ` · ${macroLine(day)}`)),
      ...meals.map((m) => h('section', { class: 'ai-meal' },
        h('div', { class: 'food-sub-head' }, h('h4', { class: 'food-sub' }, m.name), h('span', { class: 'muted small' }, kcal(totals(m.items).kcal))),
        m.items.length ? h('div', { class: 'rows' }, m.items.map((x) => h('button', {
          type: 'button', class: 'row food-row menu-dish',
          onclick: () => dishSheet(x, {
            meals, from: m,
            onMove: (to) => { m.items = m.items.filter((y) => y !== x); to.items = [...to.items, x]; paint(); },
            extra: (done) => btn(withIcon('trash', t('Прибрати з меню')), () => { done(); m.items = m.items.filter((y) => y !== x); paint(); }, 'danger'),
          }),
        },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, x.name),
            h('span', { class: 'muted small' }, [x.qty, macroLine(x)].filter(Boolean).join(' · '))),
          h('div', { class: 'row-side' }, h('span', { class: 'food-kcal' }, fmt.int(x.kcal))))))
          : h('p', { class: 'small muted ai-empty' }, t('Порожньо: цього дня в прийомі не буде страв.')),
        h('button', { type: 'button', class: 'link-btn small menu-add', onclick: () => addDish(m) }, t('+ Додати страву')))));
  };
  // Нова страва: що й скільки — текстом чи голосом, рахує «Порахувати» (свої продукти → довідник → ШІ)
  const addDish = (m) => {
    const input = h('input', { type: 'text', autocomplete: 'off', placeholder: t('гречка 150 г, 2 яйця…'), name: 'dish' });
    const note = h('p', { class: 'small muted' }, t('Що й скільки — «Додати» порахує ккал і БЖВ.'));
    const go = btn(withIcon('spark', t('Додати')), async () => {
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      go.disabled = true;
      try {
        const r = await countFood(q);
        if (!r.item) { note.textContent = r.note; return; }
        m.items = [...m.items, dish(r.item)];
        done();
        paint();
        toast(t('«{name}» — {k}', { name: r.item.name, k: kcal(r.item.kcal) }));
      } finally { go.disabled = false; }
    }, 'primary');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    const voice = voiceControl({ label: t('Сказати голосом'), onText: (s) => { input.value = s; }, onDone: (s) => { input.value = s; go.click(); } });
    const done = sheet(t('Страва в «{meal}»', { meal: m.name }), h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Що й скільки')), input), voice, note), {
      onClose: () => voice?.cancel(),
      actions: [btn(t('Скасувати'), () => done()), go],
    });
    setTimeout(() => input.focus(), 50);
  };
  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); toast(t('Вкажіть назву меню')); return; }
    const next = { ...work, name, meals: meals.map(({ id, name: n, time, items }) => ({ id, name: n, time, items })) };
    close();
    const before = await writeMenus((all) => all.map((m) => (m.id === next.id ? next : m)));
    // Сьогодні на цьому меню — день оновлюється; минулі дні лишаються на своїй копії
    const today = M.today();
    const was = dayMenu(await db.loadAll(), today)?.id === next.id;
    const dayBefore = was ? await setDayMenu(today, snapshot(next), { quiet: true }) : null;
    toast(was ? t('Меню збережено — сьогодні вже за ним') : t('Меню збережено'), {
      action: t('Скасувати'),
      onAction: async () => {
        await restoreMenus(before);
        if (was) { const { updated, ...rec } = dayBefore; await db.write({ settings: { put: [rec] } }); }
      },
    });
  };
  const remove = () => confirmSheet(t('Видалити меню «{name}»?', { name: work.name }),
    t('Дні, коли ви їли за цим меню, лишаться як були.'), t('Видалити'), async () => {
      close();
      const before = await writeMenus((all) => all.filter((m) => m.id !== work.id));
      toast(t('Меню «{name}» видалено', { name: work.name }), { action: t('Скасувати'), onAction: () => restoreMenus(before) });
    });
  paint();
  const close = sheet(t('Меню'), h('div', { class: 'ai-ration' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Назва')), nameInput), list), {
    tools: [toolBtn('delete', t('Видалити меню'), remove, 'danger')],
    actions: [btn(t('Скасувати'), () => close()), btn(t('Зберегти'), save, 'primary')],
  });
}

/** «Меню: … ›» у картці дня календаря — вибір меню на минулий день. */
export function menuLine(state, date) {
  // Сьогоднішнє меню — у картці «Сьогодні» «Раціону», тут не дублюємо
  if (!planOf(state) || date === M.today()) return null;
  const cur = dayMenu(state, date);
  return h('button', { type: 'button', class: 'link-btn small day-menu', onclick: () => menuSheet(date) },
    icon('plate'), ' ', cur ? t('Меню дня: {name}', { name: cur.name }) : t('Меню дня: за планом'), ' ›');
}
