// Лінійний графік на SVG без бібліотек: вісь часу в днях, одна вісь значень.
// Перемальовується під ширину контейнера; наведення/дотик показує підказку, тап — вибирає день.
import { h, fmt } from './ui.js';
import { daysBetween, addDays } from './model.js';
import { withIcon } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const STEPS = [0.2, 0.5, 1, 2, 5, 10];
const X_STEPS = [1, 2, 3, 7, 14];
/** Мінімальна відстань між підписами дат, px. */
const X_GAP = 62;

/** Крок сітки: ~4–6 ліній на висоту. */
function niceStep(span) {
  return STEPS.find((st) => span / st <= 6) ?? 10;
}

/**
 * Заливка між лініями a і b: клас ahead там, де a < b, behind — де a > b. Відрізок, на якому лінії
 * перетинаються, ділиться в точці перетину на два трикутники різного кольору; розрив даних > 3 днів не заливається.
 */
function band(pts, x, y, cls) {
  const g = s('g', { class: `series-band ${cls}` });
  const poly = (list, diff) => g.append(s('polygon', {
    points: list.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' '),
    class: diff < 0 ? 'ahead' : 'behind',
  }));
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (daysBetween(p.date, q.date) > 3) continue;
    const dp = p.a - p.b;
    const dq = q.a - q.b;
    const xp = x(p.date);
    const xq = x(q.date);
    if (dp * dq < 0) {
      const k = dp / (dp - dq);
      const xc = xp + k * (xq - xp);
      const yc = y(p.a + k * (q.a - p.a));
      poly([[xp, y(p.a)], [xc, yc], [xp, y(p.b)]], dp);
      poly([[xc, yc], [xq, y(q.a)], [xq, y(q.b)]], dq);
    } else {
      poly([[xp, y(p.a)], [xq, y(q.a)], [xq, y(q.b)], [xp, y(p.b)]], dp + dq);
    }
  }
  return g;
}

/** Найвужче вікно масштабу, днів. */
const MIN_SPAN = 6;
/** Найвужча шкала значень при масштабі по вертикалі. */
const MIN_Y_SPAN = 0.6;
/** Подвійний тап: між дотиками не довше, мс, і не далі, px. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 30;
/** Стовпчики під графіком: найвищий, px, і крок ярусів підписів, px (до 3 ярусів, коли стовпчики вузькі). */
const BAR_MAX = 12;
const TIER_PX = 10;
/** Поле праворуч під пігулку кінця лінії, px. */
const END_W = 64;
let clipSeq = 0;

/**
 * spec: {
 *   series: [{ key, label, kind: 'line' | 'dots' | 'band', cls, points: [{ date, v, ring, last, cls }], endLabel, aside }],
 *     endLabel — значення кінця лінії пігулкою на правому краї,
 *     band — заливка між двома лініями, точки { date, a, b }: зелена, де a < b, червона — де a > b,
 *     aside — лінія не впливає на шкалу й не вибирається дотиком (прогноз),
 *   extra: [числа, що мають влізти в шкалу], hlines: [{ v, label, cls }],
 *   legend: [{ label, cls, kind }], height, digits, unit,
 *   selected, onPick(date), tip(date) → [рядки],
 *   zoom — масштаб колесом миші, пальцями (вшир — дати, вгору — значення), подвійним тапом і зсув перетягуванням;
 *   view: [з, по] — початкове вікно (дати), home: [з, по] — вікно періоду, до якого повертає «Скинути» (без нього — view),
 *   ahead — скільки днів за останньою точкою можна показати,
 *   onView(з, по) — вікно змінилося, resetLabel — кнопка «Скинути», поки наближено жестом,
 *   gap: { of, to, label } — від пігулки кінця серії of дужка до кінця серії to з різницею (від плану),
 *   summary — опис графіка для читача з екрана; клавіші ←/→ вибирають день,
 *   legend[].keys — пункт вмикає/вимикає ці серії, hidden — вимкнені спочатку, onHidden(ключі) — після тапу,
 *   bars: [{ from, to, v, tag }] + barsLabel — стовпчики змін від нульової лінії (втрата — вниз), підписані всі,
 *   spans: [{ from, to, label, cls }] — смуги днів на всю висоту (паузи),
 * }
 */
export function lineChart(spec) {
  /** Ключі серій, вимкнених тапом по легенді. */
  const hidden = new Set(spec.hidden ?? []);
  const legendItem = (l) => {
    const body = [h('span', { class: `key ${l.kind} ${l.cls}`, 'aria-hidden': 'true' }), l.label];
    if (!l.keys) return h('span', { class: 'legend-item' }, body);
    const off = l.keys.every((k) => hidden.has(k));
    const el = h('button', { type: 'button', class: `legend-item toggle ${off ? 'off' : ''}`, 'aria-pressed': String(!off) }, body);
    el.addEventListener('click', () => {
      const now = !el.classList.contains('off');
      for (const k of l.keys) if (now) hidden.add(k); else hidden.delete(k);
      el.classList.toggle('off', now);
      el.setAttribute('aria-pressed', String(!now));
      if (lastWidth) draw(lastWidth);
      spec.onHidden?.([...hidden]);
    });
    return el;
  };
  const legend = spec.legend?.length ? h('div', { class: 'chart-legend' }, spec.legend.map(legendItem)) : null;
  const fullBtn = spec.resetLabel
    ? h('button', { type: 'button', class: 'chart-full', hidden: true, onclick: () => reset() }, withIcon('expand', spec.resetLabel))
    : null;
  const plot = h('div', { class: `chart-plot ${spec.zoom ? 'zoomable' : ''}`, tabindex: spec.onPick ? '0' : null });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const head = legend || fullBtn ? h('div', { class: 'chart-head' }, legend ?? h('span'), fullBtn) : null;
  const wrap = h('div', { class: 'chart' }, head, h('div', { class: 'chart-stage' }, plot, tip));

  // Вікно перегляду — у днях від першої дати даних; дробове, щоб масштаб ішов плавно.
  // Лінії aside (прогноз) меж не розсувають: за останнім днем лише spec.ahead днів запасу
  const allDates = [...new Set(spec.series.filter((se) => !se.aside).flatMap((se) => se.points.map((p) => p.date)))].sort();
  const D0 = allDates[0];
  const full = allDates.length ? Math.max(1, daysBetween(D0, allDates.at(-1)) + (spec.ahead ?? 0)) : 1;
  const minSpan = Math.min(MIN_SPAN, full);
  const clampView = ([a, b]) => {
    const span = Math.min(full, Math.max(minSpan, b - a));
    const from = Math.max(0, Math.min(full - span, a));
    return [from, from + span];
  };
  const toView = (range) => (range && D0 ? clampView(range.map((d) => daysBetween(D0, d))) : [0, full]);
  const initial = toView(spec.view);
  const home = spec.home ? toView(spec.home) : initial;
  let view = initial;
  /** Шкала значень [від, до] після щипка вгору; null — підбирається під видимі точки. */
  let yView = null;
  let selected = spec.selected ?? null;
  let cur = null;
  // svg один на весь час: дотик адресується елементу під пальцем, і якби svg замінювався
  // при перемальовуванні, наступні touchmove йшли б у від'єднаний вузол і до plot не доходили
  const svg = s('svg', { class: 'chart-svg', role: 'img', 'aria-label': spec.summary });

  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(plot.clientWidth);
    if (w && w !== lastWidth) { lastWidth = w; draw(w); }
  });
  ro.observe(plot);
  // Шторку чи вкладку перемалювали — спостерігач більше не потрібен
  const gone = new MutationObserver(() => { if (!wrap.isConnected) { ro.disconnect(); gone.disconnect(); } });
  requestAnimationFrame(() => { if (wrap.isConnected) gone.observe(document.body, { childList: true, subtree: true }); });

  function setView(next) {
    const [a, b] = clampView(next);
    if (Math.abs(a - view[0]) < 1e-6 && Math.abs(b - view[1]) < 1e-6) return;
    view = [a, b];
    if (lastWidth) draw(lastWidth);
    spec.onView?.(addDays(D0, Math.ceil(a - 1e-6)), addDays(D0, Math.floor(b + 1e-6)));
  }

  /** Шкала значень: не вужча за MIN_Y_SPAN, не ширша за автоматичну; ширша — знову автоматична. */
  function setY(next) {
    const [lo, hi] = cur.autoY;
    const auto = hi - lo;
    const span = Math.max(MIN_Y_SPAN, next[1] - next[0]);
    if (span >= auto - 1e-6) yView = null;
    else {
      const from = Math.max(lo - auto / 2, Math.min(hi + auto / 2 - span, next[0]));
      yView = [from, from + span];
    }
    if (lastWidth) draw(lastWidth);
  }

  const zoomed = () => Boolean(yView) || Math.abs(view[0] - home[0]) > 1e-6 || Math.abs(view[1] - home[1]) > 1e-6;

  /** Повернути вікно періоду й автоматичну шкалу. */
  function reset() {
    yView = null;
    view = home;
    if (lastWidth) draw(lastWidth);
    spec.onView?.(addDays(D0, Math.ceil(view[0] - 1e-6)), addDays(D0, Math.floor(view[1] + 1e-6)));
  }

  /** Подвійний тап / клік: наблизити втричі довкола точки, а вже наближене — повернути як було. */
  function zoomAt(clientX) {
    if (zoomed()) {
      reset();
      return;
    }
    const f = cur.frac(clientX);
    const span = view[1] - view[0];
    const at = view[0] + f * span;
    const next = span / 3;
    setView([at - f * next, at - f * next + next]);
  }

  function draw(width) {
    const height = spec.height ?? 220;
    const pad = { l: 38, r: 46, t: 10, b: 24 };
    if (!allDates.length) { plot.replaceChildren(); cur = null; return; }
    const [v0, v1] = view;
    const spanDays = v1 - v0;
    if (fullBtn) fullBtn.hidden = !zoomed();
    const off = (date) => daysBetween(D0, date);
    const inView = (p) => off(p.date) >= v0 - 1e-6 && off(p.date) <= v1 + 1e-6;
    // Лінії тягнемо до сусідньої точки за краєм — обрізає clipPath; крапки — лише видимі
    const shown = spec.series.map((se) => {
      if (hidden.has(se.key)) return [];
      const pts = se.points.filter(se.kind === 'band' ? (p) => Number.isFinite(p.a) && Number.isFinite(p.b) : (p) => Number.isFinite(p.v));
      if (se.kind === 'dots') return pts.filter(inView);
      const first = pts.findIndex((p) => off(p.date) >= v0 - 1e-6);
      const last = pts.findLastIndex((p) => off(p.date) <= v1 + 1e-6);
      if (first < 0 || last < 0) return [];
      return pts.slice(Math.max(0, first - 1), last + 2);
    });
    const main = shown.filter((_, i) => !spec.series[i].aside);
    const visible = main.flatMap((pts) => pts.filter(inView));
    const dates = [...new Set(visible.map((p) => p.date))].sort();
    const d0 = addDays(D0, Math.ceil(v0 - 1e-6));
    const d1 = addDays(D0, Math.floor(v1 + 1e-6));
    const vals = [...(visible.length ? visible : main.flat()).map((p) => p.v), ...(spec.extra ?? [])].filter(Number.isFinite);
    if (!vals.length) { plot.replaceChildren(); cur = null; return; }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    let step = niceStep(Math.max(0.5, hi - lo));
    lo = Math.floor((lo - step * 0.3) / step) * step;
    hi = Math.ceil((hi + step * 0.3) / step) * step;
    const autoY = [lo, hi];
    if (yView) {
      [lo, hi] = yView;
      step = niceStep(hi - lo);
    }
    // Кінці ліній з пігулкою, видні у вікні, — під них поле праворуч; інакше поле лише під підписи
    // горизонталей (контрольні точки), коли вони в кадрі
    const ends = spec.series.map((se, i) => (se.endLabel && shown[i].length && inView(shown[i].at(-1)) ? shown[i].at(-1) : null));
    if (ends.some(Boolean)) pad.r = END_W;
    else if (!(spec.hlines ?? []).some((l) => l.v >= lo && l.v <= hi)) pad.r = 14;
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const x = (date) => pad.l + ((off(date) - v0) / spanDays) * iw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const digits = step < 1 ? 1 : 0;
    // Під підписами дат — смуга стовпчиків; її висота залежить від того, скільки ярусів треба підписам
    const barPlan = spec.bars?.length ? planBars() : null;
    const barsH = barPlan ? 2 * (BAR_MAX + 3 + (barPlan.tiers - 1) * TIER_PX + 10) + 2 : 0;
    const total = height + barsH;

    /** Стовпчики у вікні й ярус підпису кожного: найменше ярусів, при яких підписи не накладаються (до 3). */
    function planBars() {
      const dayPx = iw / spanDays;
      const seen = spec.bars.filter((b) => off(b.to) >= v0 - 1 && off(b.from) <= v1 + 1);
      const maxAbs = Math.max(0.3, ...seen.map((b) => Math.abs(b.v)));
      const items = seen.map((b) => {
        const x0 = Math.max(pad.l, x(b.from) - dayPx / 2 + 1.5);
        const x1 = Math.min(pad.l + iw, x(b.to) + dayPx / 2 - 1.5);
        // Широкий стовпчик — ще й «5/7»: днів за планом із позначених
        const text = b.tag && x1 - x0 >= 56 ? `${fmt.signed(b.v, 1)} · ${b.tag}` : fmt.signed(b.v, 1);
        const w = text.length * 6.6 + 4;
        const cx = Math.max(pad.l + w / 2, Math.min(pad.l + iw - w / 2, (x0 + x1) / 2));
        return { b, x0, x1, bh: Math.max(2, (Math.abs(b.v) / maxAbs) * BAR_MAX), up: b.v > 0, text, a: cx - w / 2, z: cx + w / 2, cx };
      }).filter((d) => d.x1 - d.x0 >= 2);
      const fits = (row, d) => row.every((o) => d.z + 2 <= o.a || d.a >= o.z + 2);
      for (let tiers = 1; ; tiers++) {
        // Ярус шукаємо окремо для підписів угору й униз; на третій спробі зайвий підпис пропускаємо
        const rows = { true: Array.from({ length: tiers }, () => []), false: Array.from({ length: tiers }, () => []) };
        let all = true;
        for (const d of items) {
          d.tier = rows[d.up].findIndex((row) => fits(row, d));
          if (d.tier < 0) all = false;
          else rows[d.up][d.tier].push(d);
        }
        if (all || tiers === 3) return { items, tiers };
      }
    }

    svg.setAttribute('viewBox', `0 0 ${width} ${total}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', total);
    svg.replaceChildren();
    const grid = s('g', { class: 'grid' });
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      grid.append(s('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy }),
        s('text', { x: pad.l - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, fmt.fix(v, digits)));
    }
    // Підписи дат: стільки, скільки влазить по ширині; тижні — з понеділка, далі — перше число місяця
    const maxTicks = Math.max(3, Math.floor(iw / X_GAP));
    const xStep = X_STEPS.find((st) => spanDays / st <= maxTicks);
    const ticks = [];
    if (xStep) {
      let d = Math.ceil(v0 - 1e-6);
      if (xStep >= 7) d += (8 - new Date(`${addDays(D0, d)}T00:00:00Z`).getUTCDay()) % 7;
      for (; d <= v1 + 1e-6; d += xStep) ticks.push(addDays(D0, d));
    } else {
      const months = Math.max(1, Math.ceil(spanDays / 30 / maxTicks));
      let m = `${d0.slice(0, 7)}-01`;
      while (m <= d1) {
        if (m >= d0) ticks.push(m);
        const [yy, mm] = m.split('-').map(Number);
        const next = new Date(Date.UTC(yy, mm - 1 + months, 1));
        m = next.toISOString().slice(0, 10);
      }
    }
    for (const d of ticks) {
      grid.append(s('text', { x: x(d), y: height - 6, 'text-anchor': 'middle', class: 'tick' }, fmt.short(d)));
    }
    svg.append(grid);

    // Смуги днів (паузи на підтриманні) — під лініями, підпис угорі, коли смуга досить широка
    for (const sp of spec.spans ?? []) {
      const dayW = iw / spanDays;
      const a = Math.max(pad.l, x(sp.from) - dayW / 2);
      const b = Math.min(pad.l + iw, x(sp.to) + dayW / 2);
      if (b - a < 1) continue;
      svg.append(s('g', { class: `span ${sp.cls ?? ''}` },
        s('rect', { x: a.toFixed(1), y: pad.t, width: (b - a).toFixed(1), height: ih }),
        b - a >= 36 && sp.label ? s('text', { x: ((a + b) / 2).toFixed(1), y: pad.t + 12, 'text-anchor': 'middle', class: 'span-label' }, sp.label) : null));
    }

    // Праве поле: пігулки кінців і дужка різниці; зайняті висоти запам'ятовуємо, щоб підписи горизонталей на них не лягали
    const right = s('g', {});
    const taken = [];
    const ex = pad.l + iw + 9;
    spec.series.forEach((se, i) => {
      const p = ends[i];
      if (!p) return;
      const yy = Math.max(pad.t + 10, Math.min(pad.t + ih - 10, y(p.v)));
      const text = fmt.fix(p.v, spec.digits ?? 1);
      const w = Math.min(END_W - 10, text.length * 7 + 12);
      right.append(s('g', { class: `end-pill ${se.cls}` },
        s('rect', { x: ex, y: (yy - 10).toFixed(1), width: w, height: 20, rx: 10 }),
        s('text', { x: (ex + w / 2).toFixed(1), y: (yy + 4).toFixed(1), 'text-anchor': 'middle' }, text)));
      taken.push(yy);
      const g = spec.gap;
      if (!g || se.key !== g.of || hidden.has(g.to)) return;
      const q = spec.series.find((x) => x.key === g.to)?.points.find((x) => x.date === p.date && Number.isFinite(x.v));
      if (!q) return;
      const d = p.v - q.v;
      const cls = Math.abs(d) < 0.005 ? 'flat' : d < 0 ? 'good' : 'bad';
      const diff = fmt.signed(d, spec.digits ?? 1);
      const yq = Math.max(pad.t + 6, Math.min(pad.t + ih, y(q.v)));
      if (Math.abs(yq - yy) >= 38) {
        // Місця досить: дужка від пігулки до кінця плану, різниця посередині, підпис «план» біля його кінця
        const y0 = yy + (yq > yy ? 11 : -11);
        right.append(s('path', { d: `M${ex - 2},${y0.toFixed(1)}L${ex - 2},${yq.toFixed(1)}`, class: `gap-line ${cls}` }),
          s('text', { x: ex + 4, y: ((y0 + yq) / 2 + 4).toFixed(1), class: `gap-value ${cls}` }, diff),
          s('text', { x: ex + 4, y: (yq + 4).toFixed(1), class: 'gap-label' }, g.label));
        taken.push((y0 + yq) / 2, yq);
      } else {
        // Тісно — одним рядком з того боку пігулки, де план
        const ly = Math.max(pad.t + 10, Math.min(pad.t + ih + 4, yq >= yy ? yy + 24 : yy - 16));
        right.append(s('text', { x: ex + 2, y: ly.toFixed(1), class: `gap-value ${cls}` }, `${g.label} ${diff}`));
        taken.push(ly - 4);
      }
    });

    for (const line of spec.hlines ?? []) {
      if (line.v < lo || line.v > hi) continue;
      const yy = Math.round(y(line.v)) + 0.5;
      const free = !taken.some((t) => Math.abs(t - yy) < 14);
      svg.append(s('g', { class: `hline ${line.cls ?? ''}` },
        s('line', { x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy }),
        free ? s('text', { x: pad.l + iw + 4, y: yy + 4, class: 'tick' }, line.label) : null));
    }

    if (spec.bars?.length) {
      // Стовпчики від нульової лінії: втрата — вниз, набір — угору, тож знак видно й без кольору.
      // Підписані всі; тісно — сусідні підписи розходяться на яруси
      const zero = height + barsH / 2;
      const bars = s('g', { class: 'bars' });
      bars.append(s('line', { x1: pad.l, x2: pad.l + iw, y1: zero + 0.5, y2: zero + 0.5 }),
        s('text', { x: pad.l - 6, y: zero + 4, 'text-anchor': 'end', class: 'tick' }, spec.barsLabel ?? ''));
      const pickedBar = selected ? spec.bars.find((b) => b.from <= selected && selected <= b.to) : null;
      for (const d of barPlan.items) {
        bars.append(s('rect', { x: d.x0.toFixed(1), y: (d.up ? zero - d.bh : zero + 1).toFixed(1), width: (d.x1 - d.x0).toFixed(1), height: d.bh.toFixed(1), rx: 2,
          class: [d.b.v < 0 ? 'good' : d.up ? 'bad' : '', d.b === pickedBar ? 'on' : ''].join(' ').trim() || null }));
      }
      // Підписи — поверх стовпчиків; ярус 0 — біля стовпчика, наступні — на TIER_PX далі від нуля
      for (const d of barPlan.items) {
        if (d.tier < 0) continue;
        const gap = 3 + d.tier * TIER_PX;
        bars.append(s('text', { x: d.cx.toFixed(1), y: (d.up ? zero - d.bh - gap : zero + d.bh + gap + 8).toFixed(1), 'text-anchor': 'middle',
          class: `bar-label ${d.b === pickedBar ? 'on' : ''}`.trim() }, d.text));
      }
      svg.append(bars);
    }

    const clipId = `chart-clip-${++clipSeq}`;
    svg.append(s('defs', {}, s('clipPath', { id: clipId },
      s('rect', { x: pad.l - 6, y: pad.t - 6, width: iw + 12, height: ih + 12 }))));
    const marks = s('g', { 'clip-path': `url(#${clipId})` });
    spec.series.forEach((se, i) => {
      const pts = shown[i];
      if (!pts.length) return;
      if (se.kind === 'band') {
        marks.append(band(pts, x, y, se.cls));
        return;
      }
      if (se.kind === 'line') {
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        marks.append(s('path', { d, class: `series-line ${se.cls}` }));
      } else {
        const g = s('g', { class: `series-dots ${se.cls}` });
        const r = pts.length > 120 ? 2 : 2.8;
        for (const p of pts) {
          const cx = x(p.date).toFixed(1);
          const cy = y(p.v).toFixed(1);
          if (p.ring) g.append(s('circle', { cx, cy, r: r + 2.5, class: 'ring' }));
          g.append(s('circle', { cx, cy, r: p.last ? r + 1.5 : r, class: [p.last ? 'last' : '', p.cls ?? ''].join(' ').trim() || null }));
        }
        marks.append(g);
      }
    });
    svg.append(marks, right);

    // Вибраний день — кільце навколо точки (зважування, а без точок — лінії), без курсора й підказки
    const picked = s('g', { class: 'picked' });
    svg.append(picked);
    const mark = (date) => {
      const on = (x) => !x.aside && !hidden.has(x.key);
      const se = spec.series.find((x) => x.kind === 'dots' && on(x)) ?? spec.series.find((x) => x.kind === 'line' && on(x));
      const p = date && dates.includes(date) ? se?.points.find((q) => q.date === date && Number.isFinite(q.v)) : null;
      picked.replaceChildren(...(p ? [s('circle', { cx: x(date).toFixed(1), cy: y(p.v).toFixed(1), r: 7 })] : []));
    };
    mark(selected);

    const cursor = s('g', { class: 'cursor', visibility: 'hidden' }, s('line', { y1: pad.t, y2: height - pad.b }));
    const hits = s('g', {});
    cursor.append(hits);
    svg.append(cursor);

    // Курсор і підказка — лише поки миша над графіком чи палець тримає точку; вибраний день їх не лишає
    const place = (date) => {
      if (!date || !dates.includes(date)) { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
      const cx = x(date);
      cursor.setAttribute('visibility', 'visible');
      cursor.querySelector('line').setAttribute('x1', cx);
      cursor.querySelector('line').setAttribute('x2', cx);
      hits.replaceChildren(...spec.series.filter((se) => !se.aside && !hidden.has(se.key)).flatMap((se) => se.points.filter((p) => p.date === date && Number.isFinite(p.v))
        .map((p) => s('circle', { cx, cy: y(p.v), r: 5, class: `hit ${se.cls}` }))));
      const lines = spec.tip?.(date) ?? [];
      tip.replaceChildren(...lines.map((l, i) => h('div', { class: i ? '' : 'tip-head' }, l)));
      tip.hidden = !lines.length;
      // Підказка — над графіком з того боку, де більше місця
      const left = cx > width / 2;
      tip.style.left = left ? '' : `${Math.min(cx + 10, width - 150)}px`;
      tip.style.right = left ? `${Math.max(0, width - cx + 10)}px` : '';
    };
    /** Частка ширини області графіка під курсором, 0…1. */
    const frac = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      return Math.max(0, Math.min(1, (px - pad.l) / iw));
    };
    const nearest = (clientX) => {
      if (!dates.length) return null;
      const target = v0 + frac(clientX) * spanDays;
      return dates.reduce((best, d) => (Math.abs(off(d) - target) < Math.abs(off(best) - target) ? d : best), dates[0]);
    };
    /** Частка висоти області графіка під пальцем, згори, 0…1. */
    const fracY = (clientY) => {
      const rect = svg.getBoundingClientRect();
      const py = ((clientY - rect.top) / rect.height) * total;
      return Math.max(0, Math.min(1, (py - pad.t) / ih));
    };
    if (svg.parentNode !== plot) plot.replaceChildren(svg);
    cur = { place, mark, nearest, frac, fracY, dates, y: [lo, hi], autoY, daysPerPx: spanDays / iw / (svg.getBoundingClientRect().width / width || 1) };
    place(null);
  }

  // Події — на постійному контейнері: svg перемальовується під час масштабу й зсуву
  let down = null;
  let pinch = null;
  let lastTap = null;
  let lastPointer = 'mouse';
  plot.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    if (!cur || !e.isPrimary || e.button > 0 || pinch) return;
    const mouse = e.pointerType === 'mouse';
    // Палець на графіку з масштабом: рух убік — зсув, дотик без руху — вибір дня (на pointerup)
    down = { x: e.clientX, view, moved: false, mouse, touch: !mouse && spec.zoom };
    if (mouse && spec.zoom) plot.setPointerCapture(e.pointerId);
    if (!down.touch) cur.place(cur.nearest(e.clientX));
  });
  plot.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const zoomed = view[1] - view[0] < full - 1e-6;
    const dragging = down && spec.zoom && (down.moved || Math.abs(e.clientX - down.x) > (down.mouse ? 4 : 8));
    // Палець, що поїхав убік, — уже не дотик, навіть коли зсувати нікуди (графік віддалено повністю)
    if (dragging && down.touch) down.moved = true;
    if (dragging && zoomed) {
      // Перетягування — зсув вікна, графік їде за мишею чи пальцем
      down.moved = true;
      plot.classList.add('panning');
      const days = (e.clientX - down.x) * cur.daysPerPx;
      setView([down.view[0] - days, down.view[1] - days]);
      return;
    }
    if (down?.touch) return;
    if (e.pointerType === 'mouse' || down) cur.place(cur.nearest(e.clientX));
  });
  plot.addEventListener('pointerup', (e) => {
    const was = down;
    down = null;
    plot.classList.remove('panning');
    if (!cur || !was) return;
    if (was.moved) { cur.place(null); return; }
    if (was.touch) {
      const now = e.timeStamp;
      if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.abs(e.clientX - lastTap.x) < DOUBLE_TAP_PX) {
        lastTap = null;
        zoomAt(e.clientX);
        return;
      }
      lastTap = { at: now, x: e.clientX };
    }
    pick(cur.nearest(e.clientX), was.mouse);
  });

  /** Вибрати день: кільце, підпис стовпчика його тижня й рядок під графіком; tip — ще й підказка. */
  function pick(date, tip) {
    selected = date;
    if (spec.bars?.length && lastWidth) draw(lastWidth);
    else cur.mark(selected);
    cur.place(tip ? selected : null);
    if (selected) spec.onPick?.(selected);
  }

  // Клавіатура: ←/→ — сусідній день у вікні, Esc — сховати підказку
  plot.addEventListener('keydown', (e) => {
    if (!cur || !spec.onPick) return;
    if (e.key === 'Escape') { cur.place(null); return; }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step || !cur.dates.length) return;
    e.preventDefault();
    const at = cur.dates.indexOf(selected);
    pick(cur.dates[at < 0 ? cur.dates.length - 1 : Math.max(0, Math.min(cur.dates.length - 1, at + step))], true);
  });
  plot.addEventListener('pointercancel', () => { down = null; plot.classList.remove('panning'); cur?.place(null); });
  plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !down) cur?.place(null); });

  if (spec.zoom) {
    plot.addEventListener('wheel', (e) => {
      if (!cur) return;
      const [a, b] = view;
      const span = b - a;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const dx = (e.deltaX || (e.shiftKey ? e.deltaY : 0)) * unit;
      if (dx) {
        // Горизонтальне колесо / тачпад / Shift+колесо — зсув
        if ((dx < 0 && a <= 0) || (dx > 0 && b >= full)) return;
        e.preventDefault();
        setView([a + dx * cur.daysPerPx, b + dx * cur.daysPerPx]);
        return;
      }
      const dy = Math.max(-300, Math.min(300, e.deltaY * unit));
      // Далі віддаляти нікуди — колесо гортає сторінку, як звичайно
      if (dy > 0 && span >= full - 1e-6) return;
      e.preventDefault();
      const f = cur.frac(e.clientX);
      const at = a + f * span;
      const next = span * 1.0015 ** dy;
      setView([at - f * next, at - f * next + next]);
    }, { passive: false });
    // Подвійний тап пальцем ловить pointerup, тож dblclick, який браузер шле слідом, — лише від миші
    plot.addEventListener('dblclick', (e) => { if (lastPointer === 'mouse' && cur) zoomAt(e.clientX); });

    // Два пальці: напрямок вирішується на дотику. Розведення вшир чи навскіс — масштаб дат, рух разом — зсув,
    // день під серединою між пальцями лишається під нею; вгору-вниз — масштаб шкали ваги довкола середини.
    const touchMid = (e) => (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const touchMidY = (e) => (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const touchDx = (e) => Math.abs(e.touches[0].clientX - e.touches[1].clientX);
    const touchDy = (e) => Math.abs(e.touches[0].clientY - e.touches[1].clientY);
    const touchDist = (e) => Math.hypot(touchDx(e), touchDy(e));
    plot.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2 || !cur) return;
      e.preventDefault();
      if (touchDy(e) > touchDx(e)) {
        const [lo, hi] = cur.y;
        pinch = { axis: 'y', dist: Math.max(20, touchDy(e)), span: hi - lo, at: hi - cur.fracY(touchMidY(e)) * (hi - lo) };
      } else {
        const f = cur.frac(touchMid(e));
        pinch = { axis: 'x', dist: Math.max(20, touchDist(e)), view, at: view[0] + f * (view[1] - view[0]) };
      }
      down = null;
      lastTap = null;
      cur.place(null);
    }, { passive: false });
    plot.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2 || !cur) return;
      e.preventDefault();
      if (pinch.axis === 'y') {
        const next = pinch.span * (pinch.dist / Math.max(20, touchDy(e)));
        const top = pinch.at + cur.fracY(touchMidY(e)) * next;
        setY([top - next, top]);
        return;
      }
      const next = (pinch.view[1] - pinch.view[0]) * (pinch.dist / Math.max(20, touchDist(e)));
      const f = cur.frac(touchMid(e));
      setView([pinch.at - f * next, pinch.at - f * next + next]);
    }, { passive: false });
    plot.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length === 0) { pinch = null; cur?.place(null); }
    });
  }
  return wrap;
}
