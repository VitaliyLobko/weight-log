// Лінійні іконки 24×24: обведення currentColor, тож колір і товщину задає CSS.
import { h } from './ui.js';

const ICONS = {
  scale: '<rect x="3.5" y="4" width="17" height="16.5" rx="4.5"/><path d="M7.6 11.2a4.6 4.6 0 0 1 8.8 0z"/><path d="M12 11.2l1.7-2.5"/><path d="M8 16.8h8"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7.5 14.5l3.5-4 3 2.5 5-6"/><circle cx="19" cy="7" r="1.3" class="fill"/>',
  journal: '<path d="M6 3.5h11.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H6z"/><path d="M6 3.5v17M4.5 7.5h3M4.5 12h3M4.5 16.5h3"/><path d="M10.5 8h5M10.5 12h5M10.5 16h3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.4" class="fill"/>',
  speed: '<path d="M4.3 16.5a8.2 8.2 0 1 1 15.4 0"/><path d="M12 13.2l4.2-4.2"/><circle cx="12" cy="13.2" r="1.4" class="fill"/><path d="M6.5 9.5l1 .6M12 6v1.2M17.5 9.5l-1 .6"/>',
  trend: '<path d="M3.5 7l6 6 3.5-3.5 7.5 7.5"/><path d="M15 17h5.5v-5.5"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5"/>',
  flag: '<path d="M5.5 21V3.8"/><path d="M5.5 4h12l-2.6 4 2.6 4h-12"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  'calendar-check': '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>',
  person: '<circle cx="12" cy="5" r="2.3"/><path d="M6.5 9.5h11"/><path d="M12 9.5v5.5M9 21l3-6 3 6"/>',
  tape: '<circle cx="9.5" cy="12" r="6.5"/><circle cx="9.5" cy="12" r="2.2"/><path d="M16 12h5v4h-11.5"/><path d="M18 12v1.8M20 12v1.8"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.4 5.4 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.4-3.4-8.5s1-6.1 3.4-8.5z"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" class="fill"/>',
  cloud: '<path d="M7 18.5h10.2a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.6A3.4 3.4 0 0 0 7 18.5z"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15"/>',
  archive: '<rect x="3.5" y="4" width="17" height="5" rx="1.2"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  warning: '<path d="M10.3 4.6L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r=".9" class="fill"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.4l2.7 2.7L16 9.8"/>',
  note: '<path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z"/><path d="M7.5 9h9M7.5 12.5h6"/>',
  share: '<path d="M12 14.5V3.5"/><path d="M7.5 8L12 3.5 16.5 8"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  download: '<path d="M12 3.5V15"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 15V3.5"/><path d="M7.5 8L12 3.5 16.5 8"/><path d="M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l8-8"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M8 14.5l2.5-3 2.5 2 3-4"/>',
  sync: '<path d="M19.5 9A8 8 0 0 0 5 7.5"/><path d="M4.5 3.5v4h4"/><path d="M4.5 15A8 8 0 0 0 19 16.5"/><path d="M19.5 20.5v-4h-4"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5.5H4.5a3.5 3.5 0 0 0 3.6 4M16 5.5h3.5a3.5 3.5 0 0 1-3.6 4"/><path d="M12 13v4M8.5 20.5h7M9.5 20.5l.5-3.5h4l.5 3.5"/>',
};

/** Іконка як inline SVG; cls — додаткові класи (розмір, колір). */
export function icon(name, cls = '') {
  const el = h('span', { class: `ico ${cls}`, 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] ?? ''}</svg>`;
  return el;
}

/** Текст з іконкою попереду — для заголовків і кнопок. */
export const withIcon = (name, text, cls = '') => [icon(name, cls), h('span', {}, text)];
