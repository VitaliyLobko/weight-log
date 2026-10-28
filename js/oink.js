// Хрюк для кнопки «З'їв поза планом»: справжній запис свині, двічі поспіль.
// «Pig grunt» — erdie, freesound.org/people/Erdie/sounds/44274, CC BY 3.0 (подяка — у «Про застосунок»).
let sound = null;
let left = 0;

function play() {
  sound.currentTime = 0;
  sound.play().catch(() => { left = 0; });
}

export function oink() {
  try {
    if (!sound) {
      sound = new Audio('./sounds/oink.ogg');
      sound.addEventListener('ended', () => { if (left-- > 0) play(); });
    }
    left = 1;
    play();
  } catch { /* без звуку */ }
}
