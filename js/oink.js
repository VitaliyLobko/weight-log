// Хрюк для кнопки «З'їв поза планом»: справжній запис свині, двічі поспіль.
// «Pig grunt» — erdie, freesound.org/people/Erdie/sounds/44274, CC BY 3.0 (подяка — у «Про застосунок»).
const MUTE_KEY = 'weight-log:oink';
let sound = null;
let left = 0;

/** Хрюк увімкнено на цьому пристрої (вимикається в шторці «Поза планом»). */
export function oinkOn() {
  try { return localStorage.getItem(MUTE_KEY) !== 'off'; } catch { return true; }
}

export function setOinkOn(on) {
  try {
    if (on) localStorage.removeItem(MUTE_KEY);
    else localStorage.setItem(MUTE_KEY, 'off');
  } catch { /* приватний режим */ }
  if (!on && sound) { left = 0; sound.pause(); }
}

function play() {
  sound.currentTime = 0;
  sound.play().catch(() => { left = 0; });
}

export function oink() {
  if (!oinkOn()) return;
  try {
    if (!sound) {
      sound = new Audio('./sounds/oink.ogg');
      sound.addEventListener('ended', () => { if (left-- > 0) play(); });
    }
    left = 1;
    play();
  } catch { /* без звуку */ }
}
