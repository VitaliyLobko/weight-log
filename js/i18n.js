// Тексти інтерфейсу — українською прямо в коді; t() лише підставляє параметри {name}.

// Вибір мови з минулих версій більше не потрібен
try { localStorage.removeItem('weight-log:lang'); } catch { /* приватний режим */ }

export const locale = () => 'uk-UA';

export function t(text, params) {
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m)) : text;
}

/** Форма слова за числом: forms — [один, кілька, багато] (1 день, 2 дні, 5 днів). */
export function plural(n, forms) {
  const kind = new Intl.PluralRules('uk').select(Math.abs(n));
  return forms[kind === 'one' ? 0 : kind === 'few' ? 1 : 2];
}
