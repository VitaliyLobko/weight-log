// Лінійний графік на SVG без бібліотек: вісь часу в днях, одна вісь значень.
// Перемальовується під ширину контейнера; наведення/дотик показує підказку, тап — вибирає день.
import { h, fmt } from './ui.js';
import { daysBetween, addDays } from './model.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const STEPS = [0.2, 0.5, 1, 2, 5, 10];
const X_STEPS = [1, 2, 7, 14];

/** Крок сітки: ~4–6 ліній на висоту. */
function niceStep(span) {
  return STEPS.find((st) => span / st <= 6) ?? 10;
}

/**
 * spec: {
 *   series: [{ key, label, kind: 'line' | 'dots', cls, points: [{ date, v, ring }], endLabel }],
 *   extra: [числа, що мають влізти в шкалу], hlines: [{ v, label, cls }],
 *   legend: [{ label, cls, kind }], height, digits, unit,
 *   selected, onPick(date), tip(date) → [рядки],
 * }
 */
export function lineChart(spec) {
  const legend = spec.legend?.length
    ? h('div', { class: 'chart-legend' }, spec.legend.map((l) => h('span', { class: 'legend-item' },
      h('span', { class: `key ${l.kind} ${l.cls}`, 'aria-hidden': 'true' }), l.label)))
    : null;
  const plot = h('div', { class: 'chart-plot' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'chart' }, legend, h('div', { class: 'chart-stage' }, plot, tip));
  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(plot.clientWidth);
    if (w && w !== lastWidth) { lastWidth = w; draw(w); }
  });
  ro.observe(plot);
  // Шторку чи вкладку перемалювали — спостерігач більше не потрібен
  const gone = new MutationObserver(() => { if (!wrap.isConnected) { ro.disconnect(); gone.disconnect(); } });
  requestAnimationFrame(() => { if (wrap.isConnected) gone.observe(document.body, { childList: true, subtree: true }); });

  function draw(width) {
    const height = spec.height ?? 220;
    const pad = { l: 38, r: 46, t: 10, b: 24 };
    const all = spec.series.flatMap((se) => se.points);
    if (!all.length) { plot.replaceChildren(); return; }
    const dates = [...new Set(all.map((p) => p.date))].sort();
    const d0 = dates[0];
    const d1 = dates.at(-1);
    const spanDays = Math.max(1, daysBetween(d0, d1));
    const vals = [...all.map((p) => p.v), ...(spec.extra ?? [])].filter(Number.isFinite);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const step = niceStep(Math.max(0.5, hi - lo));
    lo = Math.floor((lo - step * 0.3) / step) * step;
    hi = Math.ceil((hi + step * 0.3) / step) * step;
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const x = (date) => pad.l + (daysBetween(d0, date) / spanDays) * iw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const digits = step < 1 ? 1 : 0;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
    const grid = s('g', { class: 'grid' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      grid.append(s('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy }),
        s('text', { x: pad.l - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, fmt.fix(v, digits)));
    }
    // Підписи дат: щодня, через день, щотижня, через тиждень або перше число місяця
    const xStep = X_STEPS.find((st) => spanDays / st <= 5);
    const ticks = [];
    if (xStep) {
      for (let d = 0; d <= spanDays; d += xStep) ticks.push(addDays(d0, d));
    } else {
      const months = Math.max(1, Math.ceil(spanDays / 30 / 5));
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

    const marks = s('g', {});
    for (const se of spec.series) {
      const pts = se.points.filter((p) => Number.isFinite(p.v));
      if (!pts.length) continue;
      if (se.kind === 'line') {
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        marks.append(s('path', { d, class: `series-line ${se.cls}` }));
      } else {
        const g = s('g', { class: `series-dots ${se.cls}` });
        const r = pts.length > 120 ? 2.5 : 3.5;
        for (const p of pts) {
          g.append(s('circle', { cx: x(p.date).toFixed(1), cy: y(p.v).toFixed(1), r }));
          if (p.ring) g.append(s('circle', { cx: x(p.date).toFixed(1), cy: y(p.v).toFixed(1), r: r + 3, class: 'ring' }));
        }
        marks.append(g);
      }
      if (se.endLabel) {
        const p = pts.at(-1);
        marks.append(s('text', { x: x(p.date) + 6, y: y(p.v) + 4, class: 'end-label' }, fmt.fix(p.v, spec.digits ?? 1)));
      }
    }
    svg.append(marks);

    const cursor = s('g', { class: 'cursor', visibility: 'hidden' }, s('line', { y1: pad.t, y2: height - pad.b }));
    const hits = s('g', {});
    cursor.append(hits);
    svg.append(cursor);

    const place = (date, sticky) => {
      if (!date) { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
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
    const nearest = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      const day = Math.round(((px - pad.l) / iw) * spanDays);
      const target = addDays(d0, Math.max(0, Math.min(spanDays, day)));
      return dates.reduce((best, d) => (Math.abs(daysBetween(d, target)) < Math.abs(daysBetween(best, target)) ? d : best), dates[0]);
    };
    let selected = spec.selected && dates.includes(spec.selected) ? spec.selected : null;
    const overlay = s('rect', { x: pad.l - 8, y: 0, width: iw + 16, height, class: 'overlay' });
    let down = null;
    overlay.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || down) place(nearest(e.clientX));
    });
    overlay.addEventListener('pointerdown', (e) => { down = e.pointerId; place(nearest(e.clientX)); });
    overlay.addEventListener('pointerup', (e) => {
      down = null;
      selected = nearest(e.clientX);
      place(selected, true);
      spec.onPick?.(selected);
    });
    overlay.addEventListener('pointercancel', () => { down = null; place(selected, true); });
    overlay.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') place(selected, true); });
    svg.append(overlay);
    plot.replaceChildren(svg);
    place(selected, true);
  }
  return wrap;
}
