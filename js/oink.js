// Хрюк для кнопки «З'їв поза планом»: синтез через Web Audio, без аудіофайлів.
let ctx = null;

function grunt(ac, at, len, pitch) {
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(pitch * 1.25, at);
  osc.frequency.exponentialRampToValueAtTime(pitch * 0.75, at + len);

  // Хрипіння: швидка модуляція гучності
  const rasp = ac.createOscillator();
  rasp.frequency.value = 38;
  const raspGain = ac.createGain();
  raspGain.gain.value = 0.5;
  rasp.connect(raspGain);

  // Носова форманта
  const nose = ac.createBiquadFilter();
  nose.type = 'bandpass';
  nose.frequency.value = 650;
  nose.Q.value = 2.5;

  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(0.9, at + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + len);
  raspGain.connect(amp.gain);

  osc.connect(nose).connect(amp).connect(ac.destination);
  osc.start(at); rasp.start(at);
  osc.stop(at + len + 0.02); rasp.stop(at + len + 0.02);
}

export function oink() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime + 0.01;
    grunt(ctx, now, 0.16, 150);
    grunt(ctx, now + 0.2, 0.22, 125);
  } catch { /* без звуку */ }
}
