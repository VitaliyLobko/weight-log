// Telegram-бот Хобі-плану: о часі нагадування він пише «час зважитись» і приймає вагу повідомленням.
// Його база (Cloudflare D1) — головна синхронізація журналу між телефонами: зважування, талія, налаштування
// їздять туди й назад (cloud.js), а Google Диск лишається щоденною резервною копією.
// Адреса й ключ — свої, а якщо порожньо — з Хобі-плану: на github.io обидва застосунки на одному origin.
import * as db from './db.js';
import { remindTime } from './remind.js';
import { cursors, exchange } from './cloud.js';

const APP = 'weight-log';
const KEYS = {
  url: 'weight-log:bot-url',
  key: 'weight-log:bot-key',
  remind: 'weight-log:bot-remind',
  at: 'weight-log:bot-at',
  declined: 'weight-log:bot-declined',
  restore: 'weight-log:cloud-restore',
};
// Позначки обміну до 0.1.18 (лише вага за 90 днів через /api/weights) — більше не потрібні
const OLD = ['weight-log:bot-since', 'weight-log:bot-pushed', 'weight-log:bot-last'];
const cur = cursors(APP);
const HOBBY = { url: 'hobby-planner:bot-url', key: 'hobby-planner:bot-key' };

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
  if (changed) cur.reset();
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
  try {
    const restoreAt = Number(get(KEYS.restore) || 0);
    const { rows, commit } = await exchange({
      url, key, app: APP, prefix: APP,
      records: pack(await db.loadAll()),
      extra: { remind: remindOn() ? remindTime() : null },
    });
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
