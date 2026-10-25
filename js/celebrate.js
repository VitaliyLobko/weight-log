// Святкування рубежів: пройдена контрольна точка, ціль і середнє вперше нижче сотні — по разу на рубіж.
// Що вже відсвятковано, пам'ятає пристрій; рубежі, пройдені до першого запуску, позначаються мовчки.
import { h, fmt } from './ui.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

const KEY = 'weight-log:celebrated';
const RANK = { century: 3, target: 2, cp: 1 };

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v && Array.isArray(v.done) ? { done: new Set(v.done), upTo: v.upTo ?? '' } : null;
  } catch {
    return null;
  }
}

function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify({ done: [...s.done], upTo: s.upTo })); } catch { /* приватний режим */ }
}

/**
 * list — пройдені рубежі [{ id, kind: 'cp' | 'target' | 'century', kg, avg, date, lost }], latest — дата останнього запису.
 * Святкуємо лише рубіж, пройдений не раніше за останню перевірку: точка, додана нижче вже пройденої ваги,
 * чи давній запис, виправлений заднім числом, — не новина.
 */
export function check(list, latest) {
  if (!latest) return;
  const s = load();
  if (!s) {
    save({ done: new Set(list.map((m) => m.id)), upTo: latest });
    return;
  }
  const fresh = list.filter((m) => !s.done.has(m.id) && m.date >= s.upTo);
  for (const m of list) s.done.add(m.id);
  if (latest > s.upTo) s.upTo = latest;
  save(s);
  // Кілька рубежів за раз (стрибок через точку й ціль) — показуємо найважливіший
  const top = fresh.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.kg - b.kg)[0];
  if (top) play(top);
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Показати святкування (і повторно — тапом по пройденій точці). */
export function play(m) {
  document.querySelector('.celebrate')?.remove();
  const fx = h('canvas', { class: 'celebrate-fx', 'aria-hidden': 'true' });
  const ok = h('button', { type: 'button', class: 'btn primary' }, t('Ура!'));
  const titleId = 'celebrate-title';
  const card = h('div', { class: 'celebrate-card' },
    m.kind === 'century' ? odometer(m.avg) : h('div', { class: 'celebrate-ico' }, icon(m.kind === 'target' ? 'trophy' : 'flag')),
    h('h2', { id: titleId }, title(m)),
    h('p', {}, text(m)),
    ok);
  const el = h('div', { class: `celebrate ${m.kind}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, fx, card);
  let stop = () => {};
  const close = () => {
    stop();
    el.classList.add('out');
    setTimeout(() => el.remove(), reduced() ? 0 : 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ok.addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  ok.focus({ preventScroll: true });
  try { navigator.vibrate?.(m.kind === 'century' ? [60, 80, 60, 80, 180] : m.kind === 'target' ? [40, 60, 40, 60, 120] : [30, 50, 30]); } catch { /* без вібрації */ }
  if (reduced()) {
    // Без руху — одразу кінцевий стан лічильника
    card.classList.add('go');
    return;
  }
  if (m.kind === 'century') {
    // Спершу «1» відпадає й цифри докручуються, тоді — салют
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('go')));
    const timer = setTimeout(() => { stop = fireworks(fx); }, 2200);
    stop = () => clearTimeout(timer);
  } else {
    stop = confetti(fx, m.kind === 'target' ? 2 : 1);
  }
}

function title(m) {
  if (m.kind === 'century') return t('Двузначное!');
  if (m.kind === 'target') return t('Цель достигнута!');
  return t('Контрольная точка {kg}', { kg: `${fmt.fix(m.kg)} ${t('кг')}` });
}

function text(m) {
  const avg = fmt.fix(m.avg, 2);
  if (m.kind === 'century') return t('Среднее за 7 дней впервые ниже сотни — {avg} кг.', { avg });
  if (m.kind === 'target') return t('Среднее за 7 дней — {avg} кг, минус {lost} кг от начала.', { avg, lost: fmt.fix(m.lost, 1) });
  return t('Среднее за 7 дней — {avg} кг. Так держать!', { avg });
}

/**
 * Лічильник «100,0 → 99,8»: кожна цифра — стрічка, що прокручується вниз (вага зменшується) на повний оберт
 * із запасом; провідна «1» падає й колонка стискається.
 */
function odometer(avg) {
  // Дві цифри після коми — як середнє на головній
  const end = fmt.fix(Math.min(avg, 99.99), 2).padStart(6, ' ');
  const start = fmt.fix(100, 2);
  const cols = [...start].map((from, i) => {
    const to = end[i];
    if (!/\d/.test(from)) return h('span', { class: 'odo-sep' }, from);
    if (to === ' ') return h('span', { class: 'odo-col drop' }, h('span', { class: 'odo-strip' }, h('span', {}, from)));
    const steps = 10 + ((Number(from) - Number(to) + 10) % 10);
    const digits = Array.from({ length: steps + 1 }, (_, k) => (Number(from) - k + 100) % 10);
    const strip = h('span', { class: 'odo-strip', style: `--n:${steps}; --d:${i}` }, digits.map((d) => h('span', {}, d)));
    return h('span', { class: 'odo-col' }, strip);
  });
  // Читачу екрана — кінцеве число, а не стрічки цифр
  return h('div', { class: 'odo', role: 'img', 'aria-label': `${fmt.fix(avg, 2)} ${t('кг')}` },
    h('span', { class: 'odo-digits', 'aria-hidden': 'true' }, cols), h('span', { class: 'odo-unit', 'aria-hidden': 'true' }, t('кг')));
}

function palette() {
  const css = getComputedStyle(document.documentElement);
  return ['--accent-2', '--good', '--c-ring', '--c-plan', '--c-waist', '--accent'].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
}

/** Полотно на весь екран з урахуванням щільності пікселів; повертає контекст і розміри в CSS-пікселях. */
function stage(canvas) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const hgt = innerHeight;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h: hgt };
}

/** Конфетті з верхнього краю; waves — скільки хвиль (ціль — дві). */
function confetti(canvas, waves) {
  const { ctx, w, h: H } = stage(canvas);
  const colors = palette();
  const parts = [];
  const wave = () => {
    for (let i = 0; i < 140; i++) {
      parts.push({
        x: Math.random() * w, y: -20 - Math.random() * H * 0.4,
        vx: (Math.random() - 0.5) * 2.4, vy: 2 + Math.random() * 3,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        s: 6 + Math.random() * 6, c: colors[i % colors.length], sway: Math.random() * 6,
      });
    }
  };
  wave();
  const timers = Array.from({ length: waves - 1 }, (_, i) => setTimeout(wave, 1300 * (i + 1)));
  let raf = 0;
  let t0 = 0;
  const frame = (ts) => {
    t0 ||= ts;
    ctx.clearRect(0, 0, w, H);
    for (const p of parts) {
      p.vy += 0.05;
      p.x += p.vx + Math.sin((ts - t0) / 300 + p.sway) * 0.8;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (parts.some((p) => p.y < H + 20) || timers.length && ts - t0 < 1300 * waves) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
}

/** Золотий салют: кілька вибухів зі слідом, що гасне. */
function fireworks(canvas) {
  const { ctx, w, h: H } = stage(canvas);
  const gold = ['#ffd45c', '#ffe9a6', '#f5b52e', '#ffffff', '#ffc94a'];
  const parts = [];
  const burst = () => {
    const cx = w * (0.15 + Math.random() * 0.7);
    const cy = H * (0.12 + Math.random() * 0.35);
    const n = 70;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const v = 2.2 + Math.random() * 2.8;
      parts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, c: gold[i % gold.length] });
    }
  };
  const shots = [0, 450, 800, 1300, 1700, 2300, 2700].map((ms) => setTimeout(burst, ms));
  let raf = 0;
  let t0 = 0;
  const frame = (ts) => {
    t0 ||= ts;
    // Напівпрозоре затирання лишає слід за іскрами
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.fillRect(0, 0, w, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      if (p.life <= 0) continue;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.045;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.011;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (ts - t0 < 2800 || parts.some((p) => p.life > 0)) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, H);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); shots.forEach(clearTimeout); };
}
