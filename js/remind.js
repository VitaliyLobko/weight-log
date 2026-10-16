// Нагадування зважитися. Без сервера сторінка не може сама «продзвонити» вранці,
// тому будильник ставить календар телефона: щоденна подія з нагадуванням о вибраний час.
import { remember, recall } from './ui.js';
import { t } from './i18n.js';

const KEY = 'weight-log:remind-time';
export const DEFAULT_TIME = '07:30';

export function remindTime() {
  const v = recall(KEY);
  return /^\d{2}:\d{2}$/.test(v ?? '') ? v : DEFAULT_TIME;
}

export function setRemindTime(v) {
  if (/^\d{2}:\d{2}$/.test(v)) remember(KEY, v);
}

const compact = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;

function plusMinutes(time, min) {
  const [hh, mm] = time.split(':').map(Number);
  const total = (hh * 60 + mm + min) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Перший день події: завтра, якщо сьогоднішній час уже минув. */
function firstDay(time) {
  const now = new Date();
  const [hh, mm] = time.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  if (d <= now) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Посилання «створити подію» в Google Календарі: щодня, з посиланням на застосунок в описі. */
export function googleCalendarUrl(time, appUrl) {
  const day = firstDay(time);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: t('Взвеситься'),
    details: t('Натощак, после туалета, до еды. Записать: {url}', { url: appUrl }),
    dates: `${compact(day, time)}/${compact(day, plusMinutes(time, 5))}`,
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    recur: 'RRULE:FREQ=DAILY',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Файл .ics для будь-якого календаря: щоденна подія з нагадуванням рівно о вибраний час. */
export function icsFile(time, appUrl) {
  const day = firstDay(time);
  const esc = (s) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//weight-log//UK', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:weight-log-remind-${Date.now()}@vitaliylobko.github.io`,
    `DTSTAMP:${stamp}`,
    // Без часового поясу — «плаваючий» місцевий час: о 07:30 там, де телефон
    `DTSTART:${compact(day, time)}`,
    `DTEND:${compact(day, plusMinutes(time, 5))}`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:${esc(t('Взвеситься'))}`,
    `DESCRIPTION:${esc(t('Натощак, после туалета, до еды. Записать: {url}', { url: appUrl }))}`,
    `URL:${appUrl}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(t('Взвеситься'))}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  return new File([text], 'weight-log-reminder.ics', { type: 'text/calendar' });
}
