// Імпорт з Google-таблиці «контроль_веса»: Файл → Завантажити → CSV (поточний аркуш).
// Аркуш «Вес» дає зважування, нотатки й ціль; аркуш «Графики» — ще й заміри талії.
import { parseNum, dmyToIso } from './ui.js';

/** CSV → масив рядків (лапки, коми й переноси всередині лапок, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const norm = (v) => String(v ?? '').trim().toLowerCase();
const isoOf = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : dmyToIso(s);
};
const num = (v) => {
  const n = parseNum(v);
  return Number.isFinite(n) ? n : null;
};

/** Колонка, заголовок якої відповідає регулярці, у рядку заголовків; −1 — нема. */
const col = (header, re, from = 0) => header.findIndex((c, i) => i >= from && re.test(norm(c)));

/** Значення праворуч від підпису (наприклад «Целевой вес, кг» → 95). */
function labeled(rows, re) {
  for (const r of rows) {
    const i = r.findIndex((c) => re.test(norm(c)));
    if (i >= 0) {
      const v = r.slice(i + 1).map(num).find((x) => x !== null);
      if (v !== undefined) return v;
    }
  }
  return null;
}

/**
 * Рядки CSV → { weights: [{ date, kg, note }], waists: [{ date, cm }], goal: { start, target, planRate, checkpoints } }.
 * Нічого не знайшлося — порожні масиви: розбирати, що це за файл, вирішує той, хто викликає.
 */
export function fromSheet(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^дата$/.test(norm(c))));
  const out = { weights: [], waists: [], goal: {} };
  if (hi < 0) return out;
  const header = rows[hi];
  const body = rows.slice(hi + 1);
  const dateCol = col(header, /^дата$/);
  const kgCol = col(header, /^(вес|вага)(,|$|\s)/, dateCol + 1);
  const noteCol = col(header, /^(заметка|нотатка|примітка)/);
  const wDateCol = col(header, /^дата (замера|заміру)/);
  const waistCol = col(header, /^(талия|талія)/);
  if (dateCol >= 0 && kgCol >= 0) {
    for (const r of body) {
      const date = isoOf(r[dateCol]);
      const kg = num(r[kgCol]);
      if (!date || kg === null || kg < 20 || kg > 400) continue;
      out.weights.push({ date, kg, note: noteCol >= 0 ? String(r[noteCol] ?? '').trim() : '' });
    }
  }
  if (wDateCol >= 0 && waistCol >= 0) {
    for (const r of body) {
      const date = isoOf(r[wDateCol]);
      const cm = num(r[waistCol]);
      if (date && cm !== null && cm > 20 && cm < 300) out.waists.push({ date, cm });
    }
  }
  const start = labeled(rows, /^(стартовый вес|стартова вага)/);
  const target = labeled(rows, /^(целевой вес|цільова вага)/);
  const planRate = labeled(rows, /^план, кг/);
  if (start !== null) out.goal.start = start;
  if (target !== null) out.goal.target = target;
  if (planRate !== null) out.goal.planRate = planRate;
  if (start !== null && out.weights.length) out.goal.startDate = out.weights[0].date;
  // «КОНТРОЛЬНЫЕ ТОЧКИ»: нижче — «103 кг → −15 кг, пересдать HbA1c» | 103 | дата
  const cpRow = rows.findIndex((r) => r.some((c) => /^контрольн(ые|і) точки/.test(norm(c))));
  if (cpRow >= 0) {
    const c = rows[cpRow].findIndex((x) => /^контрольн(ые|і) точки/.test(norm(x)));
    const list = [];
    for (const r of rows.slice(cpRow + 1)) {
      const label = String(r[c] ?? '').trim();
      const kg = num(r[c + 1]);
      if (!label || kg === null) break;
      const note = label.includes('→') ? label.split('→').slice(1).join('→').trim() : '';
      list.push({ kg, note: /^(цель|ціль)$/i.test(note) ? '' : note });
    }
    // «95 кг → цель» — це сама ціль, у список точок вона додається автоматично
    const points = list.filter((p) => p.kg !== out.goal.target);
    if (points.length) out.goal.checkpoints = points;
  }
  return out;
}
