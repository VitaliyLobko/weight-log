// IndexedDB: одна база, по сховищу на кожну сутність, ключ — поле id.
// Зважування й заміри талії мають id = дата (2026-10-16): один запис на день, злиття за днем.
// Кожен запис має updated (мс), видалення лишають надгробок у tombstones —
// це потрібно, щоб синхронізація з Google Диском зливала зміни без втрат.
const DB_NAME = 'weight-log';
const DB_VERSION = 1;
export const STORES = ['weights', 'waists', 'settings'];
const ALL = [...STORES, 'tombstones'];

let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ALL) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    // Нову версію бази відкрили в іншій вкладці — віддаємо з'єднання, інакше там оновлення зависне
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => window.dispatchEvent(new Event('db-blocked'));
  });
  return opening;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const out = fn(tx);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function uid() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadAll() {
  const state = {};
  await run(ALL, 'readonly', (tx) => {
    for (const name of ALL) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { state[name] = req.result; };
    }
  });
  return state;
}

/** changes: { store: { put: [obj], del: [id] } } — усе в одній транзакції, з відміткою часу. */
export async function write(changes) {
  const names = Object.keys(changes).filter((n) => STORES.includes(n));
  const now = Date.now();
  await run([...names, 'tombstones'], 'readwrite', (tx) => {
    const graves = tx.objectStore('tombstones');
    for (const name of names) {
      const store = tx.objectStore(name);
      // Той самий день записали знову після видалення — новіший запис перемагає старий надгробок при злитті
      for (const obj of changes[name].put ?? []) store.put({ ...obj, updated: now });
      for (const id of changes[name].del ?? []) {
        store.delete(id);
        graves.put({ id, store: name, updated: now });
      }
    }
  });
  window.dispatchEvent(new Event('db-change'));
}

const stamp = (x) => Number(x?.updated) || 0;

/**
 * Результат злиття з Диска: { store: { put: [obj], del: [{ id, updated }] } }.
 * Нічого не перезаписує, якщо локальний запис встиг змінитися пізніше.
 */
export function writeMerged(changes) {
  const names = Object.keys(changes).filter((n) => ALL.includes(n));
  return run(names, 'readwrite', (tx) => {
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const obj of changes[name].put ?? []) {
        store.get(obj.id).onsuccess = (e) => { if (stamp(e.target.result) <= stamp(obj)) store.put(obj); };
      }
      for (const grave of changes[name].del ?? []) {
        store.get(grave.id).onsuccess = (e) => { if (e.target.result && stamp(e.target.result) <= stamp(grave)) store.delete(grave.id); };
      }
    }
  });
}

/**
 * «Объединить» з резервної копії: запис із файлу лягає, лише якщо він новіший за локальний
 * і за надгробок — стара копія не відкочує пізніші правки й не воскрешає видалене.
 */
export async function mergeImport(changes) {
  const names = Object.keys(changes).filter((n) => STORES.includes(n));
  await run([...names, 'tombstones'], 'readwrite', (tx) => {
    const graves = tx.objectStore('tombstones');
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const obj of changes[name].put ?? []) {
        store.get(obj.id).onsuccess = (e) => {
          const mine = e.target.result;
          if (mine) {
            if (stamp(mine) < stamp(obj)) store.put(obj);
            return;
          }
          graves.get(obj.id).onsuccess = (g) => { if (!g.target.result || stamp(g.target.result) < stamp(obj)) store.put(obj); };
        };
      }
    }
  });
  window.dispatchEvent(new Event('db-change'));
}

/**
 * «Заменить всё»: лишаються тільки записи з копії, усі з однією відміткою часу — її й повертає
 * (за нею синхронізація відрізняє відновлене від старого, див. sync.markRestore).
 */
export async function replaceAll(changes) {
  const now = Date.now();
  await run(ALL, 'readwrite', (tx) => {
    for (const name of ALL) {
      const store = tx.objectStore(name);
      store.clear();
      if (!STORES.includes(name)) continue;
      for (const obj of changes[name]?.put ?? []) store.put({ ...obj, updated: now });
    }
  });
  window.dispatchEvent(new Event('db-change'));
  return now;
}

export async function clearAll() {
  await run(ALL, 'readwrite', (tx) => {
    for (const name of ALL) tx.objectStore(name).clear();
  });
}
