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
let clipSeq = 0;

/**
 * spec: {
 *   series: [{ key, label, kind: 'line' | 'dots' | 'band', cls, points: [{ date, v, ring, last }], endLabel }],
 *     band — заливка між двома лініями, точки { date, a, b }: зелена, де a < b, червона — де a > b,
 *   extra: [числа, що мають влізти в шкалу], hlines: [{ v, label, cls }],
 *   legend: [{ label, cls, kind }], height, digits, unit,
 *   selected, onPick(date), tip(date) → [рядки],
 *   zoom — масштаб колесом миші, пальцями й зсув перетягуванням; view: [з, по] — початкове вікно (дати),
 *   onView(з, по) — вікно змінилося, onFull + fullLabel — кнопка «весь графік», поки показано не все,
 * }
 */
export function lineChart(spec) {
  const legend = spec.legend?.length
    ? h('div', { class: 'chart-legend' }, spec.legend.map((l) => h('span', { class: 'legend-item' },
      h('span', { class: `key ${l.kind} ${l.cls}`, 'aria-hidden': 'true' }), l.label)))
    : null;
  const fullBtn = spec.onFull
    ? h('button', { type: 'button', class: 'chart-full', hidden: true, onclick: () => spec.onFull() }, withIcon('expand', spec.fullLabel))
    : null;
  const plot = h('div', { class: `chart-plot ${spec.zoom ? 'zoomable' : ''}` });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const head = legend || fullBtn ? h('div', { class: 'chart-head' }, legend ?? h('span'), fullBtn) : null;
  const wrap = h('div', { class: 'chart' }, head, h('div', { class: 'chart-stage' }, plot, tip));

  // Вікно перегляду — у днях від першої дати всіх даних; дробове, щоб масштаб ішов плавно
  const allDates = [...new Set(spec.series.flatMap((se) => se.points.map((p) => p.date)))].sort();
  const D0 = allDates[0];
  const full = allDates.length ? Math.max(1, daysBetween(D0, allDates.at(-1))) : 1;
  const minSpan = Math.min(MIN_SPAN, full);
  const clampView = ([a, b]) => {
    const span = Math.min(full, Math.max(minSpan, b - a));
    const from = Math.max(0, Math.min(full - span, a));
    return [from, from + span];
  };
  const initial = spec.view && D0 ? clampView(spec.view.map((d) => daysBetween(D0, d))) : [0, full];
  let view = initial;
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

  function draw(width) {
    const height = spec.height ?? 220;
    const pad = { l: 38, r: 46, t: 10, b: 24 };
    if (!allDates.length) { plot.replaceChildren(); cur = null; return; }
    const [v0, v1] = view;
    const spanDays = v1 - v0;
    if (fullBtn) fullBtn.hidden = spanDays >= full - 1e-6;
    const off = (date) => daysBetween(D0, date);
    const inView = (p) => off(p.date) >= v0 - 1e-6 && off(p.date) <= v1 + 1e-6;
    // Лінії тягнемо до сусідньої точки за краєм — обрізає clipPath; крапки — лише видимі
    const shown = spec.series.map((se) => {
      const pts = se.points.filter(se.kind === 'band' ? (p) => Number.isFinite(p.a) && Number.isFinite(p.b) : (p) => Number.isFinite(p.v));
      if (se.kind === 'dots') return pts.filter(inView);
      const first = pts.findIndex((p) => off(p.date) >= v0 - 1e-6);
      const last = pts.findLastIndex((p) => off(p.date) <= v1 + 1e-6);
      if (first < 0 || last < 0) return [];
      return pts.slice(Math.max(0, first - 1), last + 2);
    });
    const visible = shown.flatMap((pts) => pts.filter(inView));
    const dates = [...new Set(visible.map((p) => p.date))].sort();
    const d0 = addDays(D0, Math.ceil(v0 - 1e-6));
    const d1 = addDays(D0, Math.floor(v1 + 1e-6));
    const vals = [...(visible.length ? visible : shown.flat()).map((p) => p.v), ...(spec.extra ?? [])].filter(Number.isFinite);
    if (!vals.length) { plot.replaceChildren(); cur = null; return; }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const step = niceStep(Math.max(0.5, hi - lo));
    lo = Math.floor((lo - step * 0.3) / step) * step;
    hi = Math.ceil((hi + step * 0.3) / step) * step;
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const x = (date) => pad.l + ((off(date) - v0) / spanDays) * iw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const digits = step < 1 ? 1 : 0;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.replaceChildren();
    const grid = s('g', { class: 'grid' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
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

    const clipId = `chart-clip-${++clipSeq}`;
    svg.append(s('defs', {}, s('clipPath', { id: clipId },
      s('rect', { x: pad.l - 6, y: 0, width: iw + 12, height: height - pad.b + 6 }))));
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
        const r = pts.length > 120 ? 2.5 : 3.5;
        for (const p of pts) {
          const cx = x(p.date).toFixed(1);
          const cy = y(p.v).toFixed(1);
          if (p.ring) g.append(s('circle', { cx, cy, r: r + 2.5, class: 'ring' }));
          g.append(s('circle', { cx, cy, r: p.last ? r + 1.5 : r, class: p.last ? 'last' : null }));
        }
        marks.append(g);
      }
      // Підпис на кінці — лише коли кінець лінії у вікні
      const p = pts.at(-1);
      if (se.endLabel && inView(p)) {
        labels.append(s('text', { x: x(p.date) + 6, y: y(p.v) + 4, class: 'end-label' }, fmt.fix(p.v, spec.digits ?? 1)));
      }
    });
    svg.append(marks, labels);

    const cursor = s('g', { class: 'cursor', visibility: 'hidden' }, s('line', { y1: pad.t, y2: height - pad.b }));
    const hits = s('g', {});
    cursor.append(hits);
    svg.append(cursor);

    const place = (date, sticky) => {
      if (!date || !dates.includes(date)) { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
      const cx = x(date);
      cursor.setAttribute('visibility', 'visible');
      cursor.querySelector('line').setAttribute('x1', cx);
      cursor.querySelector('line').setAttribute('x2', cx);
      hits.replaceChildren(...spec.series.flatMap((se) => se.points.filter((p) => p.date === date && Number.isFinite(p.v))
        .map((p) => s('circle', { cx, cy: y(p.v), r: 5, class: `hit ${se.cls}` }))));
      const lines = spec.tip?.(date) ?? [];
      tip.replaceChildren(...lines.map((l, i) => h('div', { class: i ? '' : 'tip-head' }, l)));
      tip.hidden = !lines.length;
      tip.classList.toggle('sticky', Boolean(sticky));
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
    if (svg.parentNode !== plot) plot.replaceChildren(svg);
    cur = { place, nearest, frac, daysPerPx: spanDays / iw / (svg.getBoundingClientRect().width / width || 1) };
    place(selected, true);
  }

  // Події — на постійному контейнері: svg перемальовується під час масштабу й зсуву
  let down = null;
  let pinch = null;
  plot.addEventListener('pointerdown', (e) => {
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
    if (was.moved) { cur.place(selected, true); return; }
    selected = cur.nearest(e.clientX);
    cur.place(selected, true);
    if (selected) spec.onPick?.(selected);
  });
  plot.addEventListener('pointercancel', () => { down = null; plot.classList.remove('panning'); cur?.place(selected, true); });
  plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !down) cur?.place(selected, true); });

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
    plot.addEventListener('dblclick', () => setView(initial));

    // Два пальці: розведення — масштаб, рух разом — зсув. День під серединою між пальцями лишається під нею.
    const touchMid = (e) => (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const touchDist = (e) => Math.abs(e.touches[0].clientX - e.touches[1].clientX);
    plot.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2 || !cur) return;
      e.preventDefault();
      const f = cur.frac(touchMid(e));
      pinch = { dist: Math.max(20, touchDist(e)), view, at: view[0] + f * (view[1] - view[0]) };
      down = null;
      cur.place(null);
    }, { passive: false });
    plot.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2 || !cur) return;
      e.preventDefault();
      const next = (pinch.view[1] - pinch.view[0]) * (pinch.dist / Math.max(20, touchDist(e)));
      const f = cur.frac(touchMid(e));
      setView([pinch.at - f * next, pinch.at - f * next + next]);
    }, { passive: false });
    plot.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length === 0) { pinch = null; cur?.place(selected, true); }
    });
  }
  return wrap;
}
