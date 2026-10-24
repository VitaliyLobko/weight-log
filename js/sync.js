// Синхронізація з файлом weight-log.json на Google Диску власника.
// Офлайн-перший підхід: усе пишеться в IndexedDB, а сюди потрапляє, коли є мережа.
// Злиття — по id: перемагає запис з пізнішим updated, надгробок перемагає старіший запис.
// Підключено бота — журнал між телефонами возить його база (bot.js), а Диск раз на день зберігає копію.
import * as db from './db.js';
import * as bot from './bot.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import { t } from './i18n.js';
import { sharedToken, shareToken, dropSharedToken, noteEmail } from './google-token.js';
import { locate, readJson, writeJson, syncBotFile } from './drive-files.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'weight-log.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const KEY = 'weight-log:sync';
const BACKUP_EVERY = 24 * 3600_000;

class AuthError extends Error {}

class ApiError extends Error {
  constructor(status) {
    super(t('Google Диск ответил {n}', { n: status }));
    this.status = status;
  }
}

let conf = load();
let tokenClient = null;
let gisLoading = null;
let authWaiter = null;
let timer = null;
let running = false;
let again = false;
let forceNext = false;
const listeners = new Set();

/** state: unconfigured | off | idle | syncing | offline | auth | error */
export const status = { state: 'off', message: '' };

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch { /* приватний режим */ }
}

function set(state, message = '') {
  Object.assign(status, {
    state, message, lastSync: conf.lastSync ?? null, email: conf.email ?? null, name: conf.name ?? null, photo: conf.photo ?? null,
  });
  listeners.forEach((fn) => fn(status));
}

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
}

export const configured = () => Boolean(GOOGLE_CLIENT_ID);
export const enabled = () => Boolean(conf.enabled);
/** Свій ключ живий — його; ні — спільний з іншого застосунку автора (вхід там годиться й тут). */
function tokenValid() {
  if (conf.token && conf.expires > Date.now() + 60_000) return true;
  const s = sharedToken(conf);
  if (!s) return false;
  conf.token = s.token;
  conf.expires = s.expires;
  save();
  return true;
}

// ---------- вхід ----------

function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisLoading = null; reject(new Error(t('Нет связи с Google'))); };
    document.head.append(script);
  });
  return gisLoading;
}

function finishAuth(error) {
  const waiter = authWaiter;
  authWaiter = null;
  if (error) waiter?.reject(error);
  else waiter?.resolve();
}

function client() {
  if (tokenClient || !window.google?.accounts?.oauth2) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { finishAuth(new Error(resp.error_description || resp.error)); return; }
      conf.token = resp.access_token;
      conf.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      shareToken(conf.token, conf.expires, conf.email);
      save();
      finishAuth();
    },
    error_callback: (err) => finishAuth(new Error(err?.type === 'popup_closed' ? t('Вход отменён') : (err?.message || t('Ошибка входа в Google')))),
  });
  return tokenClient;
}

/** Підвантажити Google Sign-In заздалегідь: вікно входу має відкритися синхронно з тапу. */
export function preload() {
  if (configured() && navigator.onLine) loadGis().then(client).catch(() => {});
}

/** Викликати лише з обробника тапу/кліку — інакше браузер заблокує вікно входу. */
export async function connect() {
  // Увійшли в іншому застосунку автора менш ніж годину тому — вікно Google не потрібне
  if (!tokenValid()) {
    const c = client();
    if (!c) {
      preload();
      throw new Error(t('Google ещё загружается — нажмите ещё раз через секунду'));
    }
    await new Promise((resolve, reject) => {
      authWaiter = { resolve, reject, at: Date.now() };
      c.requestAccessToken({ prompt: conf.consented ? '' : 'consent', hint: conf.email || undefined });
    });
  }
  conf.enabled = true;
  conf.consented = true;
  save();
  await syncNow({ force: true });
}

/**
 * Ключ Google живе годину, а вікно входу браузер дозволяє лише з дотику. Тож прострочений ключ
 * оновлюємо з дотику, який людина й так робить («Записати»): згоду вже дано, вікно мигне й закриється.
 * Викликати синхронно з обробника кліку, до першого await. Не вийшло (вікно закрили, нема Google) — тихо.
 */
export function renewOnGesture() {
  // Вхід, що вже йде (connect чи попередній дотик), не перебиваємо; завислий понад хвилину — вже не рахується
  const busy = authWaiter && Date.now() - (authWaiter.at ?? 0) < 60_000;
  if (!configured() || !conf.enabled || !conf.consented || tokenValid() || !navigator.onLine || busy) return;
  // З ботом Диск — щоденна копія: сьогоднішня вже є — вікно Google не потрібне
  if (bot.botConfig().from && conf.lastSync && Date.now() - conf.lastSync < BACKUP_EVERY && !conf.restoreAt) return;
  const c = client();
  if (!c) { preload(); return; }
  authWaiter = { resolve: () => syncNow(), reject: () => {}, at: Date.now() };
  c.requestAccessToken({ prompt: '', hint: conf.email || undefined });
}

export function disconnect() {
  // Вхід у Google не відкликаємо: він спільний з іншими застосунками автора — відключається лише цей
  conf = {};
  save();
  set('off');
}

// ---------- Google Drive ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    dropSharedToken(conf.token);
    conf.token = null;
    save();
    throw new AuthError(t('Сессия Google истекла'));
  }
  if (!res.ok) throw new ApiError(res.status);
  return res;
}

/** Записати знімок у weight-log.json. false — інший телефон щойно завів файл: синхронізуватись ще раз, із ним. */
async function upload(fileId, data) {
  const content = JSON.stringify({ app: 'weight-log', format: 1, exportedAt: new Date().toISOString(), data });
  const res = await writeJson(api, { id: fileId, name: FILE_NAME, description: 'Weight Log', content });
  conf.fileId = res.id;
  save();
  return res.written;
}

// ---------- спільні налаштування бота ----------

/**
 * Адреса й ключ Telegram-бота — спільний bot-settings.json (drive-files.js). Перемагає новіший запис;
 * «Відключити» діє лише на цьому пристрої й не відключає бота в інших застосунках.
 */
async function syncBotSettings() {
  conf.botFileId = await syncBotFile(api, conf.botFileId, {
    mine: bot.sharedConfig(),
    declinedAt: bot.declinedAt(),
    apply: (theirs) => {
      bot.setBotConfig(theirs.url, theirs.key, theirs.updated);
      window.dispatchEvent(new Event('bot-config'));
    },
  });
  save();
}

/** Налаштування бота змінено тут — віднести на Диск з найближчою синхронізацією. */
export function botChanged() {
  if (conf.enabled) schedule(300, true);
}

// ---------- злиття ----------

const stamp = (x) => Number(x?.updated) || 0;

function newest(lists) {
  const map = new Map();
  for (const rec of lists.flat()) {
    if (!rec?.id) continue;
    const cur = map.get(rec.id);
    if (!cur || stamp(rec) > stamp(cur)) map.set(rec.id, rec);
  }
  return map;
}

export function merge(local, remote) {
  const graves = newest([local.tombstones ?? [], remote.tombstones ?? []]);
  // Сховища, яких ця версія ще не знає (додані новішою), лишаються у файлі як є — інакше стара версія їх стерла б.
  const unknown = Object.entries(remote).filter(([name]) => name !== 'tombstones' && !db.STORES.includes(name));
  const result = { ...Object.fromEntries(unknown), tombstones: [...graves.values()] };
  for (const name of db.STORES) {
    result[name] = [...newest([local[name] ?? [], remote[name] ?? []]).values()]
      .filter((rec) => !graves.has(rec.id) || stamp(rec) > stamp(graves.get(rec.id)));
  }
  return result;
}

/**
 * Після «Заменить всё» правдою стає копія: запис, найновіша версія якого (тут чи на Диску) старша
 * за момент відновлення, видаляється. Надгробки кладемо на бік Диска — тоді localChanges запише їх
 * і сюди, а інші пристрої отримають їх із файлу. Відновлені записи мають рівно restoreAt, а правки
 * після відновлення (тут чи на іншому пристрої) — пізніші, тож їх не чіпає.
 */
function bury(local, remote, restoreAt) {
  const graves = [];
  for (const name of db.STORES) {
    for (const rec of newest([local[name] ?? [], remote[name] ?? []]).values()) {
      if (stamp(rec) < restoreAt) graves.push({ id: rec.id, store: name, updated: restoreAt });
    }
  }
  return { ...remote, tombstones: [...(remote.tombstones ?? []), ...graves] };
}

/** Запам'ятати момент відновлення з копії до найближчої вдалої синхронізації (переживе офлайн і перезапуск). */
export function markRestore(at) {
  if (!conf.enabled) return;
  conf.restoreAt = at;
  save();
}

function fingerprint(data) {
  return ['tombstones', ...db.STORES].map((name) => JSON.stringify(
    [...(data[name] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))))).join('\n');
}

function localChanges(local, merged) {
  const changes = {};
  let count = 0;
  const graves = new Map(merged.tombstones.map((g) => [g.id, g]));
  for (const name of ['tombstones', ...db.STORES]) {
    const mine = new Map((local[name] ?? []).map((r) => [r.id, r]));
    const put = merged[name].filter((r) => JSON.stringify(mine.get(r.id)) !== JSON.stringify(r));
    const keep = new Set(merged[name].map((r) => r.id));
    const del = name === 'tombstones' ? [] : [...mine.keys()].filter((id) => !keep.has(id)).map((id) => graves.get(id) ?? { id, updated: stamp(mine.get(id)) });
    if (put.length || del.length) changes[name] = { put, del };
    count += put.length + del.length;
  }
  return count ? changes : null;
}

// ---------- цикл синхронізації ----------

/** force — зараз, навіть якщо сьогоднішня копія вже є (дотик людини, підключення, налаштування бота). */
export async function syncNow({ force = false } = {}) {
  if (!configured()) { set('unconfigured'); return; }
  if (!conf.enabled) { set('off'); return; }
  const fresh = conf.lastSync && Date.now() - conf.lastSync < BACKUP_EVERY;
  if (!force && fresh && !conf.restoreAt && bot.botConfig().from) { set('idle'); return; }
  if (!navigator.onLine) { set('offline'); return; }
  if (!tokenValid()) { set('auth', t('Нажмите, чтобы войти в Google')); return; }
  if (running) { again = true; return; }
  running = true;
  set('syncing');
  try {
    // Акаунт: адреса, ім'я й аватар; photo === undefined — підключено старою версією, без аватара
    if (!conf.email || conf.photo === undefined) {
      const about = await (await api(`${DRIVE}/about?fields=user(emailAddress,displayName,photoLink)`)).json();
      conf.email = about.user?.emailAddress ?? conf.email ?? null;
      noteEmail(conf.token, conf.email);
      conf.name = about.user?.displayName ?? null;
      conf.photo = about.user?.photoLink ?? null;
    }
    // Відновлення посеред цього проходу застосує наступний — тут уже прочитано старі дані
    const { restoreAt } = conf;
    const local = await db.loadAll();
    const fileId = await locate(api, FILE_NAME, conf.fileId);
    conf.fileId = fileId;
    const remote = fileId ? ((await readJson(api, fileId))?.data ?? {}) : {};
    const merged = merge(local, restoreAt ? bury(local, remote, restoreAt) : remote);
    const changes = localChanges(local, merged);
    if (changes) {
      await db.writeMerged(changes);
      bot.rewindPushed();
    }
    if ((!fileId || fingerprint(remote) !== fingerprint(merged)) && !(await upload(fileId, merged))) again = true;
    // Бот — окремий файл: його збій не робить невдалою синхронізацію ваги
    try {
      await syncBotSettings();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      console.warn('bot-settings', err);
    }
    if (restoreAt && conf.restoreAt === restoreAt) delete conf.restoreAt;
    conf.lastSync = Date.now();
    save();
    set('idle');
    if (changes) window.dispatchEvent(new Event('sync-applied'));
  } catch (err) {
    if (err instanceof AuthError) set('auth', t('Нажмите, чтобы войти в Google'));
    else set(navigator.onLine ? 'error' : 'offline', err.message);
  } finally {
    running = false;
    if (again) { again = false; schedule(500, true); }
  }
}

export function schedule(ms = 2000, force = false) {
  forceNext ||= force;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const f = forceNext;
    forceNext = false;
    syncNow({ force: f });
  }, ms);
}

window.addEventListener('db-change', () => { if (conf.enabled) schedule(); });
window.addEventListener('online', () => { if (conf.enabled) { preload(); schedule(500); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conf.enabled) schedule(300);
});
