// Telegram-бот Хобі-плану: о часі нагадування він пише «час зважитись» і приймає вагу повідомленням.
// Його база (Cloudflare D1) — головна синхронізація журналу між телефонами: зважування, талія, налаштування
// їздять туди й назад (cloud.js), а Google Диск лишається щоденною резервною копією.
// Адреса й ключ — спільні для всіх застосунків на пристрої (bot-key.js): вставив в одному — підхоплюють усі.
import * as db from './db.js';
import { remindTime } from './remind.js';
import { cursors, exchange } from './cloud.js';
import * as BK from './bot-key.js';

const APP = 'weight-log';
const KEYS = {
  url: 'weight-log:bot-url',
  key: 'weight-log:bot-key',
  remind: 'weight-log:bot-remind',
  dayAsk: 'weight-log:day-ask',
  at: 'weight-log:bot-at',
  declined: 'weight-log:bot-declined',
  restore: 'weight-log:cloud-restore',
};
// Позначки обміну до 0.1.10 (лише вага за 90 днів через /api/weights) — більше не потрібні
const OLD = ['weight-log:bot-since', 'weight-log:bot-pushed', 'weight-log:bot-last'];
const cur = cursors(APP);

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

/** from: 'own' — бот підключений (адреса й ключ спільні для застосунків), null — ні. */
export function botConfig() {
  const cfg = BK.current(declinedAt());
  return cfg ? { url: cfg.url, key: cfg.key, from: 'own' } : { url: '', key: '', from: null };
}

/**
 * Свої адреса й ключ — і для решти застосунків на цьому пристрої. at — коли налаштування змінено
 * (своє — зараз, з Диска — час того запису); за ним вирішується, хто новіший. Порожні — «Відключити» тут.
 */
export function setBotConfig(url, key, at = Date.now()) {
  const next = { url: url ? url.trim().replace(/\/+$/, '') : '', key: key ? key.trim() : '' };
  const on = Boolean(next.url && next.key);
  set(KEYS.url, next.url || null);
  set(KEYS.key, next.key || null);
  set(KEYS.at, on ? at : null);
  // «Відключити» тут — налаштування, старіші за цю мить, бота назад не підключають
  set(KEYS.declined, on ? null : Date.now());
  if (on) BK.publish(next.url, next.key, at);
}

/** Для bot-settings.json на Диску: лише ключ, який бот уже прийняв; null — нести нічого. */
export const sharedConfig = () => BK.forDrive(declinedAt());

/** Бот відкинув усі ключі, що є на пристрої: показати «встав новий ключ». */
export const keyProblem = () => BK.keyProblem(declinedAt());
export const isBadKey = BK.isBad;

/** Коли бота відключено на цьому пристрої (0 — не відключали). */
export const declinedAt = () => Number(get(KEYS.declined) || 0);

export const remindOn = () => get(KEYS.remind) !== 'off';
export const setRemindOn = (on) => set(KEYS.remind, on ? null : 'off');
/** Вечірнє «Як день за раціоном?» у боті: час або null — не питати. */
export const DAY_ASK_DEFAULT = '20:00';
export function dayAskTime() {
  const v = get(KEYS.dayAsk);
  if (v === 'off') return null;
  return /^\d{2}:\d{2}$/.test(v ?? '') ? v : DAY_ASK_DEFAULT;
}
export const setDayAskTime = (v) => set(KEYS.dayAsk, v ?? 'off');
export const lastSync = () => cur.last();
/** Лягли записи зі старими мітками (з копії чи Диска) — віддати боту все ще раз: він лишить новіше. */
export const rewindPushed = () => cur.rewind();

/**
 * «Заменить всё» з копії: наступний обмін віддає боту весь журнал заново, а записи бота, старші
 * за відновлення, видаляє (переживе офлайн і перезапуск).
 */
export function markRestore(at) {
  if (!botConfig().from) return;
  set(KEYS.restore, at);
  cur.reset();
}

let running = false;
let again = false;
let timer;

export function scheduleBot(ms = 2000) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncBot().catch(() => {}); }, ms);
}

const pack = (state) => [
  ...db.STORES.flatMap((store) => (state[store] ?? []).map((r) => ({ store, id: r.id, data: r, updated: r.updated || 0 }))),
  ...(state.tombstones ?? []).filter((g) => db.STORES.includes(g.store))
    .map((g) => ({ store: g.store, id: g.id, updated: g.updated || 0, deleted: true })),
];

/**
 * Один обмін: свої записи й видалення, змінені після минулого разу, і час нагадування (null — не нагадувати) → бот;
 * назад — змінене на інших телефонах і вага, надіслана в Telegram. Перемагає новіший запис (db.applyCloud).
 * Результат: { got: [нові зважування { date, kg }] } або { off: true }; помилка мережі чи ключа — виняток.
 */
export async function syncBot() {
  const { url, key } = botConfig();
  if (!url || !key) return { off: true };
  if (running) { again = true; return { busy: true }; }
  running = true;
  const cfg = { url, key };
  try {
    const restoreAt = Number(get(KEYS.restore) || 0);
    const all = await db.loadAll();
    let res;
    try {
      res = await exchange({
        url, key, app: APP, prefix: APP,
        records: pack(all),
        // Без плану харчування бот увечері про раціон не питає
        extra: { remind: remindOn() ? remindTime() : null, dayAsk: all.settings.some((s) => s.id === 'nutrition') ? dayAskTime() : null },
      });
    } catch (err) {
      if (err.status === 401) {
        BK.markBad(cfg);
        // Є інший ключ, якого бот ще не відкидав (Хобі-план, Диск) — одразу пробуємо його
        if (BK.current(declinedAt())) again = true;
        window.dispatchEvent(new Event('bot-key'));
      }
      throw err;
    }
    BK.markOk(cfg);
    const { rows, commit } = res;
    const stale = restoreAt ? rows.filter((r) => r.updated < restoreAt && !r.deleted) : [];
    const applied = await db.applyCloud(restoreAt ? rows.filter((r) => r.updated >= restoreAt) : rows);
    if (stale.length) await db.buryStale(stale, restoreAt);
    commit();
    if (restoreAt && Number(get(KEYS.restore) || 0) === restoreAt) set(KEYS.restore, null);
    for (const k of OLD) set(k, null);
    const got = applied.filter((r) => r.store === 'weights' && !r.deleted && Number.isFinite(r.data?.kg))
      .map((r) => ({ date: r.id, kg: r.data.kg }));
    return { got };
  } finally {
    running = false;
    if (again) { again = false; scheduleBot(500); }
  }
}

/**
 * Калорійність їжі з тексту через бота (/api/food): { items: [{ name, qty, grams, kcal, p, f, c }], note, source }.
 * Помилка: message 'no-bot' — бот не підключений, 'limit' — ліміт на день, 'offline', інакше — бот чи модель.
 */
export async function askFood(text) {
  const { url, key } = botConfig();
  if (!url || !key) throw new Error('no-bot');
  if (!navigator.onLine) throw new Error('offline');
  const r = await fetch(`${url}/api/food`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw Object.assign(new Error(e.error || `HTTP ${r.status}`), { status: r.status });
  }
  return r.json();
}
