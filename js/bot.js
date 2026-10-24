// Telegram-бот Хобі-плану: о часі нагадування він пише «час зважитись» і приймає вагу повідомленням.
// Тут ми забираємо записане ботом у журнал і віддаємо йому свої свіжі зважування —
// щоб не нагадував, коли вже записано, і рахував різницю з минулим разом.
// Адреса й ключ — свої, а якщо порожньо — з Хобі-плану: на github.io обидва застосунки на одному origin.
import * as db from './db.js';
import * as M from './model.js';
import { remindTime } from './remind.js';

const KEYS = {
  url: 'weight-log:bot-url',
  key: 'weight-log:bot-key',
  remind: 'weight-log:bot-remind',
  since: 'weight-log:bot-since',
  pushed: 'weight-log:bot-pushed',
  last: 'weight-log:bot-last',
  at: 'weight-log:bot-at',
  declined: 'weight-log:bot-declined',
};
const HOBBY = { url: 'hobby-planner:bot-url', key: 'hobby-planner:bot-key' };
// Боту досить свіжих записів: різниця з минулим разом і «чи вже зважувались сьогодні»
const PUSH_DAYS = 90;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

/** from: 'own' — введено тут, 'hobby' — узято з Хобі-плану, null — бот не підключений. */
export function botConfig() {
  const own = { url: get(KEYS.url) ?? '', key: get(KEYS.key) ?? '' };
  if (own.url && own.key) return { ...own, from: 'own' };
  const hobby = { url: get(HOBBY.url) ?? '', key: get(HOBBY.key) ?? '' };
  if (hobby.url && hobby.key) return { ...hobby, from: 'hobby' };
  return { url: '', key: '', from: null };
}

/**
 * Нова адреса чи ключ — обмін з нуля: свіжі записи їдуть у бот ще раз.
 * at — коли налаштування змінено (своє — зараз, з Диска — час того запису); за ним вирішується, хто новіший.
 */
export function setBotConfig(url, key, at = Date.now()) {
  const next = { url: url ? url.trim().replace(/\/+$/, '') : '', key: key ? key.trim() : '' };
  const changed = next.url !== (get(KEYS.url) ?? '') || next.key !== (get(KEYS.key) ?? '');
  set(KEYS.url, next.url || null);
  set(KEYS.key, next.key || null);
  set(KEYS.at, next.url && next.key ? at : null);
  // «Відключити» тут — запис з Диска, старіший за цю мить, бота назад не підключає
  set(KEYS.declined, next.url && next.key ? null : Date.now());
  if (changed) for (const k of [KEYS.since, KEYS.pushed, KEYS.last]) set(k, null);
}

/**
 * Налаштування для спільного файлу на Диску: своє (з часом зміни) або, поки свого нема, — з Хобі-плану
 * на цьому телефоні з часом 0, щоб будь-який запис з Диска його переміг. null — бот не підключений.
 */
export function sharedConfig() {
  const cfg = botConfig();
  if (!cfg.from) return null;
  return { url: cfg.url, key: cfg.key, updated: cfg.from === 'own' ? Number(get(KEYS.at) || 0) : 0 };
}

/** Коли бота відключено на цьому пристрої (0 — не відключали). */
export const declinedAt = () => Number(get(KEYS.declined) || 0);

export const remindOn = () => get(KEYS.remind) !== 'off';
export const setRemindOn = (on) => set(KEYS.remind, on ? null : 'off');
export const lastSync = () => Number(get(KEYS.last) || 0);

let running = false;
let again = false;
let timer;

export function scheduleBot(ms = 2000) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncBot().catch(() => {}); }, ms);
}

/**
 * Один обмін: свої зважування, змінені після минулого разу, і час нагадування (null — не нагадувати) → бот;
 * назад — записи, змінені на боці бота. Беремо запис бота, лише якщо він новіший за свій і за видалення цього дня.
 * Результат: { got: [записи з бота] } або { off: true }; помилка мережі чи ключа — виняток.
 */
export async function syncBot() {
  const { url, key } = botConfig();
  if (!url || !key) return { off: true };
  if (running) { again = true; return { busy: true }; }
  running = true;
  try {
    // Позначку беремо ДО знімка: запис, змінений під час запиту, поїде наступного разу
    const startedAt = Date.now();
    const pushed = Number(get(KEYS.pushed) || 0);
    const state = await db.loadAll();
    const from = M.addDays(M.today(), -PUSH_DAYS);
    const weights = state.weights
      .filter((w) => (w.updated || 0) > pushed && w.id >= from)
      .map((w) => ({ date: w.id, kg: w.kg, note: w.note ?? '', updated: w.updated || 0 }));
    const res = await fetch(`${url}/api/weights`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ since: Number(get(KEYS.since) || 0), weights, remind: remindOn() ? remindTime() : null }),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'key' : `HTTP ${res.status}`);
    const data = await res.json();

    const mine = new Map(state.weights.map((w) => [w.id, w]));
    const graves = new Map(state.tombstones.filter((x) => x.store === 'weights').map((x) => [x.id, x.updated || 0]));
    const got = (data.weights ?? []).filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.date) && Number.isFinite(w.kg)
      && (mine.get(w.date)?.updated || 0) < w.updated && (graves.get(w.date) || 0) < w.updated);
    if (got.length) {
      await db.write({
        weights: { put: got.map((w) => ({ id: w.date, kg: w.kg, note: w.note || mine.get(w.date)?.note || '' })) },
      });
    }
    set(KEYS.since, data.now);
    set(KEYS.pushed, startedAt);
    set(KEYS.last, Date.now());
    return { got };
  } finally {
    running = false;
    if (again) { again = false; scheduleBot(500); }
  }
}
