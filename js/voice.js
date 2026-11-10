// Голосовий ввід: розпізнавання мовлення браузера (Chrome на Android — сервіс Google, потрібна мережа).
const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition ?? window.webkitSpeechRecognition) : null;
const LANG_KEY = 'weight-log:voice-lang';

/** Мови розпізнавання: код → підпис на перемикачі. */
export const VOICE_LANGS = { 'uk-UA': 'УКР', 'ru-RU': 'РУС' };

export const canListen = () => Boolean(Recognition);

export function voiceLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v in VOICE_LANGS ? v : 'uk-UA';
  } catch { return 'uk-UA'; }
}

export function setVoiceLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* приватний режим */ }
}

/**
 * Одна фраза: onText(текст) — на кожен проміжний результат, onEnd(текст, помилка) — коли замовк.
 * Повертає stop() — закінчити раніше (сказане до цього не губиться).
 */
export function listen({ onText, onEnd }) {
  const r = new Recognition();
  r.lang = voiceLang();
  r.interimResults = true;
  // Безперервний режим на Android дублює фрази — тож одна фраза до паузи, далі можна дописати ще раз
  r.continuous = false;
  r.maxAlternatives = 1;
  let text = '';
  let error = null;
  r.onresult = (e) => {
    text = Array.from(e.results, (x) => x[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
    onText(text);
  };
  r.onerror = (e) => { error = e.error; };
  r.onend = () => onEnd(text, text ? null : error);
  try { r.start(); } catch { onEnd('', 'start'); }
  return () => { try { r.stop(); } catch { /* вже зупинено */ } };
}
