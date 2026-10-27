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
/** Висота смуги тижневих стовпчиків під графіком, px. */
const BARS_H = 38;
let clipSeq = 0;

/**
 * spec: {
 *   series: [{ key, label, kind: 'line' | 'dots' | 'band', cls, points: [{ date, v, ring, last, cls }], endLabel, aside }],
 *     band — заливка між двома лініями, точки { date, a, b }: зелена, де a < b, червона — де a > b,
 *     aside — лінія не впливає на шкалу й не вибирається дотиком (прогноз),
 *   extra: [числа, що мають влізти в шкалу], hlines: [{ v, label, cls }],
 *   legend: [{ label, cls, kind }], height, digits, unit,
 *   selected, onPick(date), tip(date) → [рядки],
 *   zoom — масштаб колесом миші, пальцями (вшир — дати, вгору — значення), подвійним тапом і зсув перетягуванням;
 *   view: [з, по] — початкове вікно (дати), ahead — скільки днів за останньою точкою можна показати,
 *   onView(з, по) — вікно змінилося, onFull + fullLabel — кнопка «весь графік», поки показано не все,
 *   legend[].keys — пункт вмикає/вимикає ці серії, hidden — вимкнені спочатку, onHidden(ключі) — після тапу,
 *   floor: { v, label } — стрілка «↓ label», коли v нижче шкали, bars: [{ from, to, v }] + barsLabel — тижневі стовпчики,
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
  const fullBtn = spec.onFull
    ? h('button', { type: 'button', class: 'chart-full', hidden: true, onclick: () => spec.onFull() }, withIcon('expand', spec.fullLabel))
    : null;
  const plot = h('div', { class: `chart-plot ${spec.zoom ? 'zoomable' : ''}` });
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
  const initial = spec.view && D0 ? clampView(spec.view.map((d) => daysBetween(D0, d))) : [0, full];
  let view = initial;
  /** Шкала значень [від, до] після щипка вгору; null — підбирається під видимі точки. */
  let yView = null;
  let selected = spec.selected ?? null;
  let cur = null;
  // svg один на весь час: дотик адресується елементу під пальцем, і якби svg замінювався
  // при перемальовуванні, наступні touchmove йшли б у від'єднаний вузол і до plot не доходили
  const svg = s('svg', { class: 'chart-svg', role: 'img' });

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

  const zoomed = () => Boolean(yView) || Math.abs(view[0] - initial[0]) > 1e-6 || Math.abs(view[1] - initial[1]) > 1e-6;

  /** Подвійний тап / клік: наблизити втричі довкола точки, а вже наближене — повернути як було. */
  function zoomAt(clientX) {
    if (zoomed()) {
      yView = null;
      view = initial;
      if (lastWidth) draw(lastWidth);
      spec.onView?.(addDays(D0, Math.ceil(view[0] - 1e-6)), addDays(D0, Math.floor(view[1] + 1e-6)));
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
    // Під підписами дат — смуга тижневих стовпчиків
    const total = height + (spec.bars?.length ? BARS_H : 0);
    const pad = { l: 38, r: 46, t: 10, b: 24 };
    if (!allDates.length) { plot.replaceChildren(); cur = null; return; }
    const [v0, v1] = view;
    const spanDays = v1 - v0;
    if (fullBtn) fullBtn.hidden = spanDays >= full - 1e-6 && !yView;
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
    // Поле праворуч — лише під підписи горизонталей (контрольні точки), коли вони в кадрі
    if (!(spec.hlines ?? []).some((l) => l.v >= lo && l.v <= hi)) pad.r = 14;
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const x = (date) => pad.l + ((off(date) - v0) / spanDays) * iw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const digits = step < 1 ? 1 : 0;

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

    for (const line of spec.hlines ?? []) {
      if (line.v < lo || line.v > hi) continue;
      const yy = Math.round(y(line.v)) + 0.5;
      svg.append(s('g', { class: `hline ${line.cls ?? ''}` },
        s('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy }),
        s('text', { x: width - pad.r + 4, y: yy + 4, class: 'tick' }, line.label)));
    }
    // Ціль нижче шкали — стрілка в лівому нижньому куті (там при схудненні порожньо)
    if (spec.floor && spec.floor.v < lo) {
      svg.append(s('text', { x: pad.l + 6, y: pad.t + ih - 6, class: 'floor-label' }, `↓ ${spec.floor.label}`));
    }

    if (spec.bars?.length) {
      // Тижневі стовпчики: висота — модуль зміни, колір — знак; підпис, коли стовпчик досить широкий
      const base = total - 3;
      const dayPx = iw / spanDays;
      const seen = spec.bars.filter((b) => off(b.to) >= v0 - 1 && off(b.from) <= v1 + 1);
      const maxAbs = Math.max(0.3, ...seen.map((b) => Math.abs(b.v)));
      const bars = s('g', { class: 'bars' });
      bars.append(s('line', { x1: pad.l, x2: pad.l + iw, y1: base + 0.5, y2: base + 0.5 }),
        s('text', { x: pad.l - 6, y: base, 'text-anchor': 'end', class: 'tick' }, spec.barsLabel ?? ''));
      for (const b of seen) {
        const x0 = Math.max(pad.l, x(b.from) - dayPx / 2 + 1.5);
        const x1 = Math.min(pad.l + iw, x(b.to) + dayPx / 2 - 1.5);
        if (x1 - x0 < 3) continue;
        const bh = Math.max(2, (Math.abs(b.v) / maxAbs) * (BARS_H - 20));
        bars.append(s('rect', { x: x0.toFixed(1), y: (base - bh).toFixed(1), width: (x1 - x0).toFixed(1), height: bh.toFixed(1), rx: 2,
          class: b.v < 0 ? 'good' : b.v > 0 ? 'bad' : '' }));
        if (x1 - x0 >= 24) {
          bars.append(s('text', { x: ((x0 + x1) / 2).toFixed(1), y: (base - bh - 3).toFixed(1), 'text-anchor': 'middle', class: 'bar-label' },
            fmt.signed(b.v, 1)));
        }
      }
      svg.append(bars);
    }

    const clipId = `chart-clip-${++clipSeq}`;
    svg.append(s('defs', {}, s('clipPath', { id: clipId },
      s('rect', { x: pad.l - 6, y: pad.t - 6, width: iw + 12, height: ih + 12 }))));
    const marks = s('g', { 'clip-path': `url(#${clipId})` });
    const labels = s('g', {});
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
      // Підпис на кінці — лише коли кінець лінії у вікні; над точкою, щоб не лягав на хвостик прогнозу
      const p = pts.at(-1);
      if (se.endLabel && inView(p)) {
        const lx = Math.min(x(p.date), pad.l + iw - 16);
        const ly = y(p.v) - 16 < pad.t + 4 ? y(p.v) + 24 : y(p.v) - 16;
        labels.append(s('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'end-label' }, fmt.fix(p.v, spec.digits ?? 1)));
      }
    });
    svg.append(marks, labels);

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
    cur = { place, mark, nearest, frac, fracY, y: [lo, hi], autoY, daysPerPx: spanDays / iw / (svg.getBoundingClientRect().width / width || 1) };
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
    selected = cur.nearest(e.clientX);
    cur.mark(selected);
    cur.place(was.mouse ? selected : null);
    if (selected) spec.onPick?.(selected);
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
