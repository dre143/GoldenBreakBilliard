// Alert sounds, from Marimar Inn: made in the browser with the Web Audio API, so there's no audio file.
// Browsers only allow sound after the page has been tapped once, so primeAlarmAudio() runs on the first
// tap and plays an inaudible note to unlock audio for alerts that fire later on their own.

let ctx = null;

function audio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function beep(c, frequency, start, duration, volume) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(start);
  osc.stop(start + duration);
}

export function primeAlarmAudio() {
  const c = audio();
  if (c) beep(c, 440, c.currentTime, 0.05, 0.0001);
}

/** Soft two-note chime, played twice: 15 minutes left. */
export function playWarningChime() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  for (const offset of [0, 0.9]) {
    beep(c, 660, t + offset, 0.2, 0.18);
    beep(c, 880, t + offset + 0.24, 0.24, 0.18);
  }
}

/** Sharper, louder triple chime: 5 minutes left. */
export function playUrgentChime() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  for (let i = 0; i < 3; i++) {
    beep(c, 900, t + i * 0.32, 0.22, 0.3);
    beep(c, 650, t + i * 0.32 + 0.16, 0.14, 0.24);
  }
}
