// Довідник продуктів на 100 г і розбір тексту «що з'їв» без ІІ.
// Значення приблизні — середні з відкритих таблиць калорійності; точніше — штрихкод чи фото етикетки.
// Рядок: [назви через |, ккал, Б, Ж, В, одиниці в грамах]. pc — штука/шматок, slice — скибка,
// tbsp/tsp — столова/чайна ложка, cup — склянка/чашка, plate — тарілка/порція,
// top — порція як додаток до страви («з маслом»), dflt — порція, коли кількість не сказали.
// Сам довідник — у data/foods.json (групи → рядки); не завантажився — працюємо без нього, решту порахує ШІ.
const DATA = await fetch(new URL('../data/foods.json', import.meta.url)).then((r) => (r.ok ? r.json() : { groups: [] })).catch(() => ({ groups: [] }));
const T = DATA.groups.flatMap((g) => g.items.map((row) => ({ row, group: g.name })));

// Алкоголь: калорії дає спирт (7 ккал/г), тож перевірку «ккал ≈ БЖВ» для нього не робимо
const ALCOHOL = /пив|вин[оа]|водк|горілк|горилк|коньяк|виск|віск|сидр|ликер|лікер|шампан|мартини|ром\b|джин|текил|текіл|самогон|ігрист|игрист|просек|кагор|настоян|настойк|бейл|глінтвейн|глинтвейн|пунш|коктейл|мохіт|мохит|бренд|мартін|вермут|апероль|шприц|стаут/;

const lower = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[’`ʼ]/g, '\'');
const words = (s) => lower(s).match(/[a-zа-яіїєґ'0-9]+/g) ?? [];
// Слова, що не змінюють продукт: без них «свіжий банан» — той самий банан
const STOP = new Set(['с', 'со', 'з', 'із', 'зі', 'и', 'і', 'й', 'та', 'на', 'в', 'у', 'по', 'для', 'из', 'от', 'від', 'без',
  'тертий', 'тертим', 'тертого', 'тертый', 'тертым',
  'свежий', 'свежая', 'свежие', 'свіжий', 'свіжа', 'свіжі', 'домашний', 'домашняя', 'домашній', 'домашня',
  'большой', 'большая', 'маленький', 'маленькая', 'великий', 'велика', 'маленька', 'немного', 'трохи', 'ещё', 'еще', 'ще']);
// Слова з мовлення, що не про їжу: «вчора я з'їв на обід …» — викидаються з тексту до розбору
const FILLER = new Set(['вчора', 'вчера', 'сьогодні', 'сегодня', 'зранку', 'утром', 'ввечері', 'вечером', 'вдень', 'днем',
  'я', 'ми', 'мы', 'ще', 'ещё', 'еще', 'потім', 'потом', 'також', 'также', 'тоже', 'теж', 'ну', 'типу', 'типа', 'десь', 'где-то', 'приблизно', 'примерно',
  'їв', 'їла', 'їли', "з'їв", "з'їла", "з'їли", "з'їдено", 'поїв', 'поїла', 'ел', 'ела', 'ели', 'съел', 'съела', 'съели', 'поел', 'поела',
  'випив', 'випила', 'выпил', 'выпила', 'попив', 'попил', 'перекусив', 'перекусила', 'перекусил', 'було', 'был', 'была']);
// «на обід», «за вечерею» — прийом їжі, теж не продукт
const MEALS = /^(сніданок|сніданку|завтрак\S*|обід|обіді|обед\S*|вечер[яюеі]\S*|ужин\S*|перекус\S*|полуденок|полдник\S*)$/;
// Основа слова: «бананы» → «бана», «курячу» → «куря» — щоб збігалися відмінки
const stem = (w) => (w.length <= 3 ? w : w.length <= 5 ? w.slice(0, -1) : w.slice(0, -2));
// Варіанти основи: «сирок» — «сирок…» або з випадним «о» «сирк…» (сирки), але не «сиром»
const stems = (w) => {
  if (w.length <= 4) return [stem(w)];
  // Випадний голосний: «сирок» — «сирки», «цукор» — «цукру», «перець» — «перцем»
  if (/[оеє][кргнлц]$/.test(w)) return [w, `${w.slice(0, -2)}${w.at(-1)}`];
  if (/ець$/.test(w)) return [w, `${w.slice(0, -3)}ц`];
  return [stem(w)];
};
// Наскільки слово тексту схоже на слово назви: спільний початок / довжина назви («хліба» ближче до «хліб», ніж до «хлібці»)
const closeness = (w, aw) => {
  let i = 0;
  while (i < w.length && i < aw.length && w[i] === aw[i]) i += 1;
  return i / aw.length;
};
const hits = (w, alts) => alts.some((s) => w.startsWith(s));

const build = ([names, kcal, p, f, c, u], extra) => ({
  name: names.split('|')[0],
  names,
  per100: { kcal, p, f, c },
  u,
  ...extra,
  aliases: names.split('|').map((a) => {
    const ws = words(a).filter((w) => !STOP.has(w));
    return { text: a, words: ws.join(' '), list: ws, stems: ws.map(stems), len: ws.join(' ').length };
  }),
});
const BASE = T.map(({ row, group }) => build(row, { group }));
let FOODS = BASE;

/** Ключ рядка довідника — перша назва: свій рядок з тим самим ключем заміняє вбудований. */
export const dictKey = (names) => lower(String(names).split('|')[0]).trim();

/**
 * Свої рядки довідника поверх вбудованих: rows — [{ row: [назви, ккал, Б, Ж, В, одиниці] }].
 * Той самий ключ — виправлений вбудований (fixed, base — як було), новий ключ — доданий (own).
 */
export function setOwnFoods(rows = []) {
  const own = new Map(rows.map((r) => [dictKey(r.row[0]), r.row]));
  // Свої — першими: за рівного збігу розбір бере їх, а не вбудований рядок
  FOODS = [
    ...[...own].filter(([k]) => !BASE.some((b) => dictKey(b.names) === k)).map(([, row]) => build(row, { group: 'мої', own: true })),
    ...BASE.map((b) => {
      const row = own.get(dictKey(b.names));
      return row ? build(row, { group: b.group, fixed: true, base: b }) : b;
    }),
  ];
}

/**
 * Продукт довідника за назвою: усі слова назви (крім службових і чисел) мають бути в одній з назв довідника,
 * і всі слова тієї назви — в тексті. Кілька збігів — найближча за словами («хліба» → «хліб», не «хлібці»),
 * далі більше слів і довша назва («молоко 3,2» над «молоко»).
 */
export function findFood(name) {
  const ws = words(name).filter((w) => !STOP.has(w));
  // Числа й одиночні літери («б/к») назву не уточнюють
  const sig = ws.filter((w) => !/^\d+$/.test(w) && w.length > 1);
  if (!sig.length) return null;
  let best = null;
  for (const food of FOODS) {
    for (const a of food.aliases) {
      const inText = a.stems.every((alts) => ws.some((w) => hits(w, alts)));
      const covers = sig.every((w) => a.stems.some((alts) => hits(w, alts)));
      if (!inText || !covers) continue;
      const score = a.list.reduce((acc, aw) => acc + Math.max(...ws.map((w) => closeness(w, aw))), 0);
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && a.len > best.len)) best = { food, alias: a, len: a.len, score };
    }
  }
  return best?.food ?? null;
}

/** Назва для запису: як написано, якщо це вже форма з довідника («кефір 1%»), інакше назва з довідника («хліба» → «Хліб»). */
function foodLabel(typed, food) {
  const ws = words(typed).filter((w) => !STOP.has(w)).join(' ');
  const a = food.aliases.find((x) => x.words === ws);
  if (a) return cap(typed);
  // Назва з довідника, вся присутня в тексті: більше слів — точніше, при рівних — коротша (основна форма)
  const tw = words(typed);
  // Мова й форма — як сказали: «пельменів» → «Пельмені», не «Пельмени»
  const near = (x) => x.list.reduce((acc, aw) => acc + Math.max(...tw.map((w) => closeness(w, aw))), 0);
  const best = food.aliases.filter((x) => x.stems.length && x.stems.every((alts) => tw.some((w) => hits(w, alts))))
    .sort((x, y) => (y.stems.length - x.stems.length) || (near(y) - near(x)) || (x.len - y.len))[0];
  return cap((best ?? food.aliases[0]).text);
}

/** Кількість для показу: «3» і «три» → «3 шт», «0,5» напою → «0,5 л»; «пів», «півтора» — як сказали. */
function amountLabel(p, u, grams) {
  if (p.unit) return p.amountText;
  const text = /^\d+(?:[.,]\d+)?$/.test(p.amountText) ? p.amountText : Number.isInteger(p.n) ? String(p.n) : null;
  if (!text) return p.amountText;
  return grams === Math.round(p.n * 1000) && !u.pc ? `${text} л` : `${text} шт`;
}

// Одиниці: шаблон → як перевести в грами для продукту u (одиниці продукту з довідника)
const UNITS = [
  [/^(кг|кило\S*|кіло\S*)$/, () => 1000],
  [/^(г|гр|грам\S*|g)$/, () => 1],
  [/^(мл|ml)$/, () => 1],
  [/^(л|l|литр\S*|літр\S*)$/, () => 1000],
  // «кус(ок)», але не «кускус»
  [/^(шт|штук\S*|штуч\S*|кус(ок|ка|ки|ку|ков|оч\S*)?|шмат\S*|пачк\S*|плитк\S*|упак\S*)$/, (u) => u.pc ?? u.slice ?? 100],
  [/^(скиб\S*|ломт\S*|ломот\S*)$/, (u) => u.slice ?? u.pc ?? 30],
  [/^(ч\.?л\.?|чайн\S*)$/, (u) => u.tsp ?? 5],
  [/^(ст\.?л\.?|столов\S*|лож\S*)$/, (u) => u.tbsp ?? 15],
  [/^(стакан\S*|склян\S*|чаш\S*|кружк\S*|горнят\S*|бокал\S*|келих\S*)$/, (u) => u.cup ?? 250],
  [/^(тарел\S*|тарілк\S*|тарілок|порц\S*|миск\S*)$/, (u) => u.plate ?? 250],
  [/^(бутыл\S*|пляш\S*)$/, (u) => u.bottle ?? 500],
  [/^(банк\S*|бляшан\S*)$/, (u) => u.can ?? 330],
  [/^(рюм\S*|чарк\S*|стопк\S*)$/, (u) => u.shot ?? 50],
  [/^(жмен\S*|жмень\S*|горст\S*|пригорщ\S*)$/, (u) => u.handful ?? 30],
  [/^(ціл(ий|а|у|е|і|ої|ого)|цел(ый|ая|ую|ое|ые|ой|ого))$/, (u) => u.whole ?? u.pc ?? u.plate ?? 100],
];
const ADJ_UNIT = /^(чайн\S*|столов\S*)$/;

/** Одиниця з позиції j: «чайна ложка» — два слова, «ст.л.» — одне → { unit, len } або null. */
function unitOf(tokens, j, units = UNITS) {
  const a = lower(tokens[j] ?? '').replace(/[.,]$/, '');
  if (ADJ_UNIT.test(a) && /^лож/.test(lower(tokens[j + 1] ?? ''))) return { unit: a.startsWith('ч') ? 'ч.л' : 'ст.л', len: 2 };
  if (a && units.some(([re]) => re.test(a))) return { unit: a, len: 1 };
  return null;
}

// Числа словами — так їх часто віддає голосовий ввід («дві скибки хліба», «півтора банана»)
const WORD_NUMS = {
  один: 1, одна: 1, одну: 1, одне: 1, одно: 1, два: 2, дві: 2, две: 2, три: 3, чотири: 4, четыре: 4,
  "п'ять": 5, пять: 5, шість: 6, шесть: 6, сім: 7, семь: 7, вісім: 8, восемь: 8,
  "дев'ять": 9, девять: 9, десять: 10, півтора: 1.5, півтори: 1.5, полтора: 1.5, полторы: 1.5,
  // Після «з»: «з трьох яєць», «з двома ложками цукру»
  двох: 2, трьох: 3, чотирьох: 4, "п'яти": 5, двух: 2, трех: 3, четырех: 4, пяти: 5,
  однією: 1, одною: 1, двома: 2, трьома: 3, чотирма: 4, двумя: 2, тремя: 3, четырьмя: 4,
};
const num = (s) => (/^(пол|половин\S*|пів|половинк\S*)$/.test(s) ? 0.5
  : s in WORD_NUMS ? WORD_NUMS[s] : Number(s.replace(',', '.')));
const NUM_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?|пол|половин\\S*|пів|половинк\\S*|${Object.keys(WORD_NUMS).join('|')})$`);

/**
 * Шматок тексту → { name, n, unit, amountText }: «2 скибки хліба», «хліб 60 г», «кола 0,5», «пів банана».
 * Числа з % («кефір 1%») — частина назви, не кількість.
 */
export function parsePiece(text) {
  const raw = String(text ?? '').trim();
  // «60г» → «60 г»; «%» лишається при числі
  const tokens = raw.replace(/(\d)([a-zа-яіїєґ])/gi, '$1 $2').split(/\s+/).filter(Boolean);
  let n = null; let unit = null; const used = new Set();
  const unitAt = (j, units = UNITS) => {
    const u = unitOf(tokens, j, units);
    if (!u) return null;
    for (let x = 0; x < u.len; x++) used.add(j + x);
    return u.unit;
  };
  // Кількість одразу після «з» — про додаток («з двома ложками цукру», «з трьох яєць»), не про страву
  const own = new Set();
  tokens.forEach((tok, j) => {
    if (!PREPS.has(lower(tok))) return;
    let k = j + 1;
    if (NUM_RE.test(lower(tokens[k] ?? ''))) { own.add(k); k += 1; }
    const u = unitOf(tokens, k);
    if (u) for (let x = 0; x < u.len; x++) own.add(k + x);
  });
  for (let i = 0; i < tokens.length; i++) {
    const tok = lower(tokens[i]);
    if (own.has(i) || !NUM_RE.test(tok) || /%$/.test(tokens[i]) || tokens[i + 1] === '%') continue;
    n = num(tok); used.add(i);
    unit = unitAt(i + 1);
    break;
  }
  // «ложка меду», «склянка кефіру» — одиниця без числа (не грами й не літри)
  if (n === null) {
    for (let i = 0; i < tokens.length && !unit; i++) if (!own.has(i)) unit = unitAt(i, UNITS.slice(4));
    if (unit) n = 1;
  }
  const name = tokens.filter((_, i) => !used.has(i)).join(' ').replace(/^[\s,.:-]+|[\s,.:-]+$/g, '');
  const amountText = tokens.filter((_, i) => used.has(i)).join(' ');
  return { name, n, unit, amountText };
}

/** Скільки грамів у порції: одиниця → грами продукту; без одиниці — штуки, а дріб у напою — літри. */
export function portionGrams(u = {}, { n, unit }) {
  if (unit) {
    const hit = UNITS.find(([re]) => re.test(unit));
    const g = hit ? hit[1](u) : 100;
    return Math.round((n ?? 1) * g);
  }
  const one = u.pc ?? u.slice ?? u.plate ?? u.cup ?? 100;
  // Без кількості — звичайна порція: «пельмені» — тарілка, а не один, «горішки» — жменя
  if (n === null) return u.dflt ?? (u.pc && u.plate ? u.plate : one);
  // «половина піци» — від цілої, а не від шматка
  if (!Number.isInteger(n) && u.whole) return Math.round(n * u.whole);
  if (!Number.isInteger(n) && n < 3 && u.cup && !u.pc) return Math.round(n * 1000);
  return Math.round(n * one);
}

const r1 = (v) => Math.round(v * 10) / 10;

/** Порція з значень на 100 г: ккал цілими, БЖВ з одним знаком. */
export function fromPer100(per100, grams) {
  const k = grams / 100;
  return { kcal: Math.round(per100.kcal * k), p: r1(per100.p * k), f: r1(per100.f * k), c: r1(per100.c * k) };
}

/** Значення на 100 г з порції — для старих «Моїх продуктів», де записано лише порцію. */
export function per100Of(item) {
  const g = Number(item.grams);
  if (item.per100) return item.per100;
  if (!g || !Number.isFinite(Number(item.kcal))) return null;
  const k = 100 / g;
  return { kcal: Math.round(item.kcal * k), p: r1((item.p || 0) * k), f: r1((item.f || 0) * k), c: r1((item.c || 0) * k) };
}

/** Ккал не сходяться з БЖВ (4·Б + 9·Ж + 4·В) більш ніж на 15% — варто перевірити. */
export function kcalMismatch({ name, kcal, p, f, c }) {
  if (!(kcal > 30) || ALCOHOL.test(lower(name))) return false;
  const calc = 4 * (p || 0) + 9 * (f || 0) + 4 * (c || 0);
  return Math.abs(kcal - calc) / Math.max(kcal, calc) > 0.15;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// «З чим»: «бутерброд з маслом», «кофе с молоком»
const PREPS = new Set(['з', 'із', 'зі', 'с', 'со', 'из']);
// Орудний відмінок — начинка після «з»: «маслом», «сиром», «ковбасою», «колбасой», «огірками»
const INSTR = /(ом|ем|єм|ою|ею|єю|ой|ей|ами|ями|ми|им|ым|ім)$/;
const SPLIT = /(,(?!\d)|;|\n|\+|\s(?:и|і|та|й|плюс|ще|ещё|еще)\s)/i;
// Родовий множини: «огірків», «помидоров», «грибів»
const GEN_PL = /^\S{2,}(ів|їв|ов|ев)$/;

/**
 * Слово продовжує перелік після «з» у попередньому шматку: орудний — «з маслом, сиром»;
 * родовий з тим самим закінченням — «з огірків і помідорів», «из огурцов и помидоров».
 */
function sameList(prev, first) {
  const ws = words(prev);
  const at = ws.findLastIndex((w) => PREPS.has(w));
  if (at < 0 || !first) return false;
  if (INSTR.test(first)) return true;
  // Лише родовий множини: «з курки і пиріжки» — дві різні речі
  const after = ws[at + 1] ?? '';
  const end = first.slice(-2);
  return GEN_PL.test(after) && GEN_PL.test(first) && after.slice(-2) === end;
}

/**
 * Текст «що з'їв» → шматки: кома (не в «0,5»), крапка з комою, рядок, «+», «і / и / та», з голосу — «плюс», «ще».
 * Перелік після «з» лишається при страві: «бутерброд з маслом, сиром і ковбасою» — один шматок.
 */
export function splitText(text) {
  const parts = String(text ?? '').split(SPLIT);
  const out = [];
  let sep = '';
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i].trim();
    if (piece) {
      const prev = out.at(-1);
      const glue = prev !== undefined && !/^\d/.test(piece) && sameList(prev, words(piece)[0] ?? '');
      if (glue) out[out.length - 1] = `${prev}${sep}${piece}`;
      else out.push(piece);
    }
    const next = parts[i + 1] ?? '';
    sep = /[,;\n+]/.test(next) ? ', ' : ` ${next.trim()} `;
  }
  return out;
}

/** Без слів мовлення: «вчора я з'їв на обід котлету» → «котлету». */
function cleanPiece(piece) {
  const out = [];
  for (const tok of String(piece).split(/\s+/).filter(Boolean)) {
    const w = lower(tok).replace(/[.!?:]+$/, '');
    if (FILLER.has(w)) continue;
    // «і кола», «плюс чай» на початку шматка — лишок від розбиття
    if (!out.length && (CONJ.has(w) || w === 'плюс')) continue;
    if (MEALS.test(w)) {
      if (/^(на|за|до|к|після|после)$/.test(lower(out.at(-1) ?? ''))) out.pop();
      continue;
    }
    out.push(tok);
  }
  return out.join(' ');
}

/** Свій продукт за назвою: та сама назва чи всі її слова в тексті. */
function findMine(name, mine) {
  const ws = words(name).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
  if (!ws.length) return null;
  let best = null;
  for (const m of mine) {
    const ms = words(m.name).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
    if (!ms.length) continue;
    const ok = ms.every((w) => ws.some((x) => x.startsWith(stem(w))))
      && ws.every((x) => ms.some((w) => x.startsWith(stem(w))));
    if (ok && (!best || m.name.length > best.name.length)) best = m;
  }
  return best;
}

/** Свій продукт без лічильників «Моїх продуктів» — у запис дня вони не йдуть. */
export function withoutStats(x) {
  if (!x) return null;
  const { used, last, ...item } = x;
  return item;
}

/** Порція додатку до страви: «з маслом» — скибка масла, «з цукром» — ложечка, «з пюре» — тарілка. */
const topGrams = (u = {}) => u.top ?? u.slice ?? u.pc ?? u.tsp ?? u.tbsp ?? u.plate ?? u.cup ?? 30;
// Одиниці, що рахують штуки основи: «2 бутерброди», «3 скибки хліба з маслом»
const COUNT_UNIT = /^(шт|штук\S*|кус(ок|ка|ки|ку|ков|оч\S*)?|шмат\S*|скиб\S*|ломт\S*|ломот\S*)$/;

const CONJ = new Set(['і', 'и', 'та', 'й', 'а', 'також']);

/**
 * Додатки без ком (так їх дає голос): «маслом сиром ковбасою» — щоразу найдовший відомий шматок; не впізнали — null.
 * Кількість перед додатком — amt: «двома ложками цукру», «ложкою меду»; родовий без одиниці («трьох яєць») —
 * madeOf: страва З цього, а не з цим.
 */
function segment(toks, mine) {
  const out = [];
  for (let i = 0; i < toks.length;) {
    let amt = null;
    if (NUM_RE.test(lower(toks[i]))) {
      const n = num(lower(toks[i]));
      const u = unitOf(toks, i + 1);
      amt = { n, unit: u?.unit ?? null };
      i += 1 + (u?.len ?? 0);
    } else {
      const u = unitOf(toks, i, UNITS.slice(4));
      if (u) { amt = { n: 1, unit: u.unit }; i += u.len; }
    }
    if (i >= toks.length) return null;
    let end = toks.length;
    let hit = null;
    while (end > i) {
      hit = lookup(toks.slice(i, end).join(' '), mine);
      if (hit) break;
      end -= 1;
    }
    if (!hit) return null;
    out.push(amt ? { ...hit, amt, madeOf: !amt.unit && !INSTR.test(lower(toks[i])) } : hit);
    i = end;
  }
  return out;
}

/** Частина страви: свій продукт (з вагою) чи довідник → { label, per100, u }. */
function lookup(name, mine) {
  const my = findMine(name, mine);
  const myPer100 = my && per100Of(my);
  if (myPer100) return { label: my.name, per100: myPer100, u: my.grams ? { pc: Number(my.grams) } : {} };
  const food = findFood(name);
  return food ? { label: foodLabel(name, food), per100: food.per100, u: food.u } : null;
}

/**
 * Страва з додатками: «2 бутерброди з маслом, сиром і ковбасою», «чай з цукром», «котлета з пюре».
 * Основа — за кількістю з тексту, додатки — звичайною порцією; дрібні (не більші за штуку основи) множаться
 * на число штук. Основу чи хоч один додаток не впізнали — null (тоді ШІ).
 */
function composite(p, mine) {
  const ws = p.name.split(/\s+/).filter(Boolean);
  const isLink = (tok) => PREPS.has(lower(tok).replace(/,$/, '')) || CONJ.has(lower(tok).replace(/,$/, ''));
  // Основа — найдовший відомий початок, за яким іде «з …» чи «і …»: «вареники з сиром» + «і сметаною»
  let at = -1;
  let base = null;
  for (let j = ws.length - 1; j >= 1 && !base; j -= 1) {
    if (!isLink(ws[j])) continue;
    if (!ws.slice(0, j).some((x) => !isLink(x))) continue;
    base = lookup(ws.slice(0, j).join(' '), mine);
    if (base) at = j;
  }
  // Без «з» це не страва з додатками, а перелік («борщ і хліб») — його вже розбито на шматки
  if (!base || !ws.slice(0, at + 1).some((x) => PREPS.has(lower(x)))) return null;
  const rest = ws.slice(at).join(' ');
  const adds = segment(ws.slice(at).filter((x) => !isLink(x)).map((x) => x.replace(/,$/, '')), mine);
  if (!adds?.length) return null;
  const one = portionGrams(base.u, { n: null, unit: null });
  const k = p.n && (!p.unit || COUNT_UNIT.test(p.unit)) ? p.n : 1;
  const addGrams = (a) => {
    if (a.amt) {
      // «ложка цукру» в напої — чайна
      const unit = a.amt.unit && /^лож/.test(a.amt.unit) && base.u.cup ? 'ч.л' : a.amt.unit;
      return portionGrams(a.u, { n: a.amt.n, unit });
    }
    const g = topGrams(a.u);
    return Math.round(g <= one ? g * k : g);
  };
  const extra = adds.filter((a) => !a.madeOf).map((a) => ({ ...a, grams: addGrams(a) }));
  // «яєчня з трьох яєць» — вага страви з яєць, значення на 100 г — страви
  const made = adds.filter((a) => a.madeOf).reduce((acc, a) => acc + addGrams(a), 0);
  // Гарнір при основній страві («пюре з котлетою») — гарнірна порція, як і в «котлеті з пюре»
  const garnish = p.n === null && base.u.top >= 100 && base.u.plate && extra.some((a) => a.grams >= 60);
  const baseGrams = p.n === null && made ? made : garnish ? base.u.top : portionGrams(base.u, p);
  const parts = [{ ...base, grams: baseGrams }, ...extra];
  const sum = { kcal: 0, p: 0, f: 0, c: 0 };
  let grams = 0;
  for (const x of parts) {
    for (const key of Object.keys(sum)) sum[key] += (x.per100[key] * x.grams) / 100;
    grams += x.grams;
  }
  const per100 = { kcal: Math.round((sum.kcal / grams) * 100), p: r1((sum.p / grams) * 100), f: r1((sum.f / grams) * 100), c: r1((sum.c / grams) * 100) };
  return {
    name: cap(`${base.label} ${rest}`.replace(/\s+,/g, ',')),
    qty: amountLabel(p, base.u, baseGrams),
    grams, per100, kcal: Math.round(sum.kcal), p: r1(sum.p), f: r1(sum.f), c: r1(sum.c), src: 'table',
  };
}

/**
 * Порахувати без ІІ: кожен шматок — зі «Своїх продуктів», інакше з довідника, інакше як страва з додатками.
 * → { items, missing } — missing: шматки, яких не впізнали.
 */
export function resolveLocal(text, mine = []) {
  const items = [];
  const missing = [];
  for (const raw of splitText(text)) {
    const piece = cleanPiece(raw);
    if (!piece) continue;
    const p = parsePiece(piece);
    if (!p.name) { missing.push(piece); continue; }
    const my = withoutStats(findMine(p.name, mine));
    const food = findFood(p.name);
    const myPer100 = my && per100Of(my);
    // Свій продукт без ваги порції, а в тексті є кількість — перерахувати нема з чого, тоді довідник
    if (my && (p.n === null || myPer100 || !food)) {
      const per100 = myPer100;
      if (p.n === null || !per100) { items.push({ ...my, src: 'my' }); continue; }
      // Напій («кола 0,5») — літри, а не частка своєї пляшки
      const drink = food?.u?.cup && !food.u.pc;
      const u = { ...(food?.u ?? {}), ...(my.grams && !drink ? { pc: my.grams } : {}) };
      const grams = portionGrams(u, p);
      items.push({ name: my.name, qty: amountLabel(p, u, grams), grams, per100, ...fromPer100(per100, grams), src: 'my', ...(my.barcode ? { barcode: my.barcode } : {}) });
      continue;
    }
    if (!food) {
      const dish = composite(p, mine);
      if (dish) items.push(dish);
      else missing.push(piece);
      continue;
    }
    const grams = portionGrams(food.u, p);
    items.push({ name: foodLabel(p.name, food), qty: amountLabel(p, food.u, grams), grams, per100: { ...food.per100 }, ...fromPer100(food.per100, grams), src: 'table' });
  }
  return { items, missing };
}

/**
 * Продукт від моделі: порцію рахуємо самі з «на 100 г» (модель помиляється в множенні),
 * а якщо продукт є в довіднику — беремо його значення.
 */
export function fromModel(x) {
  const grams = Number(x.grams) > 0 ? Number(x.grams) : 100;
  const food = findFood(x.base || '') ?? findFood(x.name);
  const m = { p: Number(x.p100) || 0, f: Number(x.f100) || 0, c: Number(x.c100) || 0 };
  // Модель часом дає 0 ккал при ненульових БЖВ — тоді рахуємо з них
  const k = Number(x.k100) > 0 ? Number(x.k100) : Math.round(4 * m.p + 9 * m.f + 4 * m.c);
  const model = k > 0 ? { kcal: k, ...m } : null;
  const per100 = food ? { ...food.per100 } : model ?? per100Of({ ...x, grams });
  if (!per100) return { name: x.name, qty: x.qty ?? '', grams, kcal: Number(x.kcal) || 0, p: Number(x.p) || 0, f: Number(x.f) || 0, c: Number(x.c) || 0, src: 'ai' };
  return { name: x.name, qty: x.qty ?? '', grams, per100, ...fromPer100(per100, grams), src: food ? 'table' : 'ai' };
}

/** Увесь довідник — для перегляду й перевірки в «Довідці» та пошуку в шторці «Поза планом». */
export const tableFoods = () => FOODS;

/** Самоперевірка довідника тим самим правилом, що й для продуктів: рядки, де ккал не сходяться з БЖВ. */
export const tableProblems = () => FOODS
  .filter((x) => kcalMismatch({ name: x.name, ...x.per100 }))
  .map((x) => x.name);
