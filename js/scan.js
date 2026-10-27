// Штрихкод (камера + Open Food Facts) і фото етикетки: точні значення на 100 г замість оцінки моделі.
import { h, sheet, btn, toast } from './ui.js';
import { t } from './i18n.js';

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const LABEL_PX = 1024;

const r1 = (v) => Math.round(v * 10) / 10;
const n0 = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/** Відповідь Open Food Facts → продукт { name, barcode, grams, per100 } або null, якщо калорій на 100 г немає. */
export function offItem(product, code) {
  const nm = product?.nutriments ?? {};
  const kj = n0(nm['energy-kj_100g']) ?? (nm.energy_unit === 'kJ' || !nm['energy-kcal_100g'] ? n0(nm.energy_100g) : null);
  const kcal = n0(nm['energy-kcal_100g']) ?? (kj !== null ? kj / 4.184 : null);
  if (!kcal) return null;
  const name = [product.product_name_uk, product.product_name_ru, product.product_name].find((x) => x?.trim())?.trim()
    ?? t('Продукт {code}', { code });
  const brand = String(product.brands ?? '').split(',')[0].trim();
  const serving = n0(product.serving_quantity);
  return {
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    barcode: code,
    grams: serving && serving < 2000 ? Math.round(serving) : 100,
    per100: { kcal: Math.round(kcal), p: r1(n0(nm.proteins_100g) ?? 0), f: r1(n0(nm.fat_100g) ?? 0), c: r1(n0(nm.carbohydrates_100g) ?? 0) },
  };
}

/** Продукт за штрихкодом з Open Food Facts; null — немає в базі чи без калорій. Помилка 'offline' — немає мережі. */
export async function lookupBarcode(code) {
  if (!navigator.onLine) throw new Error('offline');
  const fields = 'product_name,product_name_uk,product_name_ru,brands,nutriments,serving_quantity';
  const r = await fetch(`${OFF_URL}/${encodeURIComponent(code)}.json?fields=${fields}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.status === 1 || j.product ? offItem(j.product, code) : null;
}

const validCode = (s) => /^\d{8,14}$/.test(s);

/**
 * Шторка сканування: камера з BarcodeDetector (Chrome на Android), а де його немає — лише поле для цифр.
 * onCode(code) — коли код є; шторка закривається сама.
 */
export function scanSheet(onCode) {
  let stream = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((tr) => tr.stop());
  };
  const done = (code) => { if (stopped) return; close(); onCode(code); };
  const digits = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 14, placeholder: '4820000000000' });
  const manual = () => {
    const code = digits.value.replace(/\D/g, '');
    if (!validCode(code)) { digits.focus(); toast(t('Нужно 8–14 цифр под штрихкодом')); return; }
    done(code);
  };
  digits.addEventListener('keydown', (e) => { if (e.key === 'Enter') manual(); });
  const video = h('video', { class: 'scan-video', muted: true, playsinline: true, autoplay: true });
  video.muted = true;
  const status = h('p', { class: 'muted small scan-status' }, t('Наведите камеру на штрихкод'));
  const canScan = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  const body = h('div', { class: 'scan' },
    canScan ? h('div', { class: 'scan-frame' }, video, h('span', { class: 'scan-line', 'aria-hidden': 'true' })) : null,
    canScan ? status : h('p', { class: 'muted small' }, t('Камера-сканер на этом устройстве недоступна — введите цифры под штрихкодом.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Цифры штрихкода')), digits));
  const close = sheet(t('Штрихкод'), body, {
    actions: [btn(t('Найти'), manual, 'primary')],
    onClose: stop,
  });
  if (!canScan) { setTimeout(() => digits.focus(), 250); return; }
  (async () => {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats?.() ?? FORMATS;
      const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (stopped) { stop(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const tick = async () => {
        if (stopped) return;
        try {
          const [hit] = await detector.detect(video);
          if (hit && validCode(hit.rawValue)) { navigator.vibrate?.(40); done(hit.rawValue); return; }
        } catch { /* кадр ще не готовий */ }
        setTimeout(tick, 250);
      };
      tick();
    } catch (err) {
      status.textContent = err?.name === 'NotAllowedError'
        ? t('Нет доступа к камере — разрешите его в браузере или введите цифры.')
        : t('Камера не запустилась — введите цифры под штрихкодом.');
    }
  })();
}

/** Вибрати фото етикетки (на телефоні — одразу камера) і зменшити до JPEG ~1024 px: data URL або null. */
export function pickLabelPhoto() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) { resolve(null); return; }
      try { resolve(await shrink(file)); } catch { resolve(null); }
    });
    document.body.append(input);
    input.click();
  });
}

async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, LABEL_PX / Math.max(bmp.width, bmp.height));
  const canvas = h('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Відповідь бота за етикеткою → продукт або null, якщо таблиці не прочитано. */
export function labelItem(r) {
  if (!(Number(r?.k100) > 0)) return null;
  const serving = Number(r.serving);
  return {
    name: r.name?.trim() || t('Продукт с этикетки'),
    grams: serving > 0 && serving < 2000 ? Math.round(serving) : 100,
    per100: { kcal: Math.round(r.k100), p: r1(Number(r.p100) || 0), f: r1(Number(r.f100) || 0), c: r1(Number(r.c100) || 0) },
  };
}
