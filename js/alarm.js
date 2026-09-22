// Alert sounds.
//   - The 15-min-left and 5-min-left booking alerts are SPOKEN, in a man's voice, via the browser's
//     built-in Web Speech API (window.speechSynthesis) — no audio file, no server.
//   - The hour-mark ring (a whole hour of play just completed) plays a real recording, assets/sounds/hour-bell.mp3.
//   - Everything else (and the fallback for a browser with no speech voices, or if the recording can't
//     play) is synthesized with the Web Audio API — no audio file needed for those.
// Browsers only allow sound/speech/playback until the page is tapped once, so primeAlarmAudio() runs on the
// first tap and unlocks all three (an inaudible tone, an empty utterance, a muted play-and-pause) for
// alerts that fire later on their own.

let ctx = null;

function audio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(c, { frequency, start, duration, volume, type = 'sine', attack = 0.012 }) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(start);
  osc.stop(start + duration);
}

export function primeAlarmAudio() {
  const c = audio();
  if (c) tone(c, { frequency: 440, start: c.currentTime, duration: 0.05, volume: 0.0001 });
  if (window.speechSynthesis) {
    loadVoices();
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* speech not available on this device */ }
  }
  // Unlocks the real bell recording the same way: play, then immediately pause and rewind, muted.
  const bell = hourBellElement();
  if (bell) {
    bell.muted = true;
    bell.play().then(() => { bell.pause(); bell.currentTime = 0; bell.muted = false; }).catch(() => { bell.muted = false; });
  }
}

/** Soft "ding-dong" (two sine notes, one after the other, never overlapping): there's still time — 15 minutes
 * left on a booking, or an hour mark 5 minutes away. */
export function playWarningChime() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  tone(c, { frequency: 784, start: t, duration: 0.32, volume: 0.16 }); // G5
  tone(c, { frequency: 659, start: t + 0.34, duration: 0.42, volume: 0.16 }); // E5, only once the first note ends
}

/** Brisk triple beep on a triangle wave (an electronic alarm, not a struck bell): act now — 5 minutes left. */
export function playUrgentChime() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  for (let i = 0; i < 3; i++) {
    tone(c, { frequency: 988, start: t + i * 0.24, duration: 0.13, volume: 0.2, type: 'triangle', attack: 0.006 });
  }
}

/** One short "ding-dong" (not repeated), same character as the warning chime: an hour mark is 5 minutes away. */
export function playHourChime() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  tone(c, { frequency: 784, start: t, duration: 0.3, volume: 0.16 });
  tone(c, { frequency: 659, start: t + 0.32, duration: 0.36, volume: 0.16 });
}

/** Synthesized fallback for playHourBell(), used only if the real recording (below) can't play on this
 * device: several sine partials at slightly inharmonic ratios is the classic way to fake a bell/gong. */
function synthesizeHourBell() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const fundamental = 587; // D5 — a clear, dinner-bell-like pitch
  const partials = [
    { ratio: 1, duration: 1.4, volume: 0.24 },
    { ratio: 2.02, duration: 1.15, volume: 0.15 },
    { ratio: 2.99, duration: 0.9, volume: 0.1 },
    { ratio: 4.02, duration: 0.65, volume: 0.06 },
  ];
  for (const p of partials) tone(c, { frequency: fundamental * p.ratio, start: t, duration: p.duration, volume: p.volume, attack: 0.004 });
}

// A real recording (a classic school bell) for the hour-mark ring. Created lazily (this file is also
// imported by the plain-Node test suite, which has no `Audio`/DOM at all) and only once; primeAlarmAudio()
// plays-and-immediately-pauses it on the first tap, the same unlock browsers require for the tones above.
let hourBell = null;
function hourBellElement() {
  if (typeof Audio === 'undefined') return null;
  if (!hourBell) { hourBell = new Audio('assets/sounds/hour-bell.mp3'); hourBell.preload = 'auto'; }
  return hourBell;
}

/** Rings once, exactly when a running table's play crosses a whole hour (1:00:00, 2:00:00, 3:00:00, ...). */
export function playHourBell() {
  const el = hourBellElement();
  if (!el) { synthesizeHourBell(); return; }
  // A fresh clone each time, so two tables crossing their hour mark close together both get the full ring
  // instead of the second call cutting off the first.
  el.cloneNode().play().catch(() => synthesizeHourBell()); // blocked by autoplay policy, or the file failed to load
}

/* ---------- spoken alerts (Web Speech API) ---------- */

let voicesPromise = null;

/** The browser loads its voice list asynchronously; this resolves once it's ready (or after a short timeout). */
function loadVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve([]);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const existing = synth.getVoices();
    if (existing.length) { resolve(existing); return; }
    const onChange = () => { synth.removeEventListener('voiceschanged', onChange); resolve(synth.getVoices()); };
    synth.addEventListener('voiceschanged', onChange);
    setTimeout(() => { synth.removeEventListener('voiceschanged', onChange); resolve(synth.getVoices()); }, 500);
  });
  return voicesPromise;
}

// Common male/female voice names across Chrome, Edge, Android and iOS TTS packs.
const MALE_VOICE = /\b(male|david|mark|guy|george|james|arthur|thomas|daniel|ryan|fred|alex)\b/i;
const FEMALE_VOICE = /\b(female|zira|susan|samantha|karen|moira|tessa|victoria|fiona|kate|linda|serena|aria)\b/i;

async function pickMaleVoice() {
  const voices = await loadVoices();
  const english = voices.filter((v) => /^en/i.test(v.lang));
  const pool = english.length ? english : voices;
  return pool.find((v) => MALE_VOICE.test(v.name) && !FEMALE_VOICE.test(v.name))
    || pool.find((v) => !FEMALE_VOICE.test(v.name))
    || pool[0]
    || null;
}

/**
 * Speak a short phrase aloud in a man's voice (falls back to `fallback`, a tone chime, if this device has
 * no speech voices at all). Named/male-sounding voices vary a lot by device, so the pitch is also lowered,
 * which reads as a deeper, more male voice even on a generic default voice.
 */
export async function speakAlert(text, fallback) {
  const synth = window.speechSynthesis;
  if (!synth) { fallback?.(); return; }
  try {
    const voice = await pickMaleVoice();
    const utter = new SpeechSynthesisUtterance(text);
    if (voice) utter.voice = voice;
    utter.pitch = 0.75;
    utter.rate = 0.95;
    utter.volume = 1;
    // A voice failing to load or the TTS engine erroring mid-speech doesn't throw synchronously — catch it here too.
    utter.onerror = () => fallback?.();
    synth.speak(utter);
  } catch {
    fallback?.();
  }
}
