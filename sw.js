importScripts('./version.js');

const PREFIX = 'weight-log-';
const CACHE = `${PREFIX}${self.APP_VERSION}-${self.APP_BUILD}`;
const ASSETS = [
  './',
  './index.html',
  './version.js',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/sync.js',
  './js/google-token.js',
  './js/drive-files.js',
  './js/bot-key.js',
  './js/bot.js',
  './js/cloud.js',
  './js/model.js',
  './js/ui.js',
  './js/i18n.js',
  './js/chart.js',
  './js/remind.js',
  './js/lock.js',
  './js/icons.js',
  './js/diet.js',
  './js/nutrition.js',
  './js/daylog.js',
  './js/foods.js',
  './js/scan.js',
  './js/oink.js',
  './sounds/oink.ogg',
  './js/celebrate.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/author.jpg',
];

// Файли — повз HTTP-кеш браузера: GitHub Pages віддає max-age=600, і без reload
// оновлення 10 хвилин після релізу ставило б старі файли.
const precache = () => caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))));

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

/**
 * Сусідній застосунок на цьому ж домені (shooting-log) під час свого оновлення видаляє всі чужі кеші.
 * Тому при кожному відкритті з мережею перевіряємо свій кеш і докладаємо, чого бракує.
 */
async function repairCache() {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  const missing = ASSETS.map((url) => new URL(url, self.registration.scope).href).filter((url) => !have.has(url));
  if (missing.length) await cache.addAll(missing.map((url) => new Request(url, { cache: 'reload' })));
}

// Кеші інших застосунків на тому ж домені (vitaliylobko.github.io/…) не чіпаємо — лише свої старі версії.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') event.waitUntil(repairCache().catch(() => {}));
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true, cacheName: CACHE });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (err) {
      if (request.mode === 'navigate') return caches.match('./index.html', { cacheName: CACHE });
      throw err;
    }
  })());
});
