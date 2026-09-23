// Hour-mark proximity alert on the table cards: "warn" in the last 5 minutes before each whole hour of
// play, "crit" in the last minute. The level is derived from elapsed time on every tick, so it clears the
// instant the hour passes (or the session is stopped) and re-arms for the next hour on its own.
//
// Set Hours only — Open Time has no warning or expiry effects of any kind (see time-alerts.js), and that
// includes this one: it never gets the rail glow, the bell badge, the chime, or the hour-crossing bell.
//
// Per hour mark (session start + hour number — not the table id, so a Transfer Table move carries this
// state with it rather than restarting it) there is one chime, at the start of the warning, and one
// optional manual dismissal that hides that card's glow/badge until the next hour mark. Both are
// remembered for the browser session so a page reload doesn't repeat the chime or bring a dismissed alert back.
// Dismissing only hides the visuals: it never touches the timer, billing or any other table.
import { state, on } from './state.js';
import {
  elapsedMs, hourAlert, isTimed, plannedMs, HOUR_MS,
} from './billing.js';
import { playHourChime, playHourBell, primeAlarmAudio } from './alarm.js';
import { serverNow } from './clock.js';

const STORE_KEY = 'goldenbreak:hour-alerts';
const MIN = 60 * 1000;

function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY)) || {};
    return {
      dismissed: new Set(saved.dismissed || []), chimed: new Set(saved.chimed || []), rung: new Set(saved.rung || []),
    };
  } catch { return { dismissed: new Set(), chimed: new Set(), rung: new Set() }; }
}
const memory = load();
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      dismissed: [...memory.dismissed].slice(-200), chimed: [...memory.chimed].slice(-200), rung: [...memory.rung].slice(-200),
    }));
  } catch { /* storage unavailable: alerts still work, they just may repeat after a reload */ }
}

// "Just crossed" matters, so a table already hours into play when the app is first opened doesn't ring for
// an hour mark that passed long ago (same reasoning as the booking-threshold chime in time-alerts.js).
const HOUR_RING_WINDOW_MS = 15 * 1000;

/** Ring the bell once, exactly when a running table's play crosses a whole hour (1:00:00, 2:00:00, ...). */
function checkHourCrossings(now) {
  for (const t of state.tables) {
    const s = t.session;
    if (!s || s.ended || s.cancelled || t.status !== 'in_use' || !isTimed(s)) continue;
    const elapsed = elapsedMs(t, now);
    const completedHours = Math.floor(elapsed / HOUR_MS);
    if (completedHours < 1) continue;
    if (elapsed - completedHours * HOUR_MS > HOUR_RING_WINDOW_MS) continue; // this mark passed a while ago
    const id = `${s.startedAt}:hour:${completedHours}`;
    if (memory.rung.has(id)) continue;
    memory.rung.add(id);
    save();
    playHourBell();
  }
}

/**
 * The hour-mark alert a table is in right now, or null. Only a running clock alerts: a stopped, cancelled
 * or checked-out table (or an Available one) never does.
 */
export function hourAlertFor(table, now = serverNow()) {
  const s = table?.session;
  if (!s || s.ended || s.cancelled || table.status !== 'in_use' || !isTimed(s)) return null;
  const a = hourAlert(elapsedMs(table, now));
  if (!a.level) return null;
  const key = `${s.startedAt}:${a.boundary}`;
  return { ...a, key, dismissed: memory.dismissed.has(key) };
}

/** Level to show on a card ('warn' | 'crit'), or null when there's nothing to show. */
export function visibleHourLevel(table, now = serverNow()) {
  const a = hourAlertFor(table, now);
  return a && !a.dismissed ? a.level : null;
}

const SR_TEXT = {
  warn: 'Hour mark in under 5 minutes.',
  crit: 'Hour mark in under 1 minute.',
};

/** Put the alert state on every table card under root (called every second, and after any change). */
export function applyHourAlerts(root = document) {
  const byId = new Map(state.tables.map((t) => [t.id, t]));
  const now = serverNow();
  root.querySelectorAll('.pool[data-pool]').forEach((card) => {
    const level = visibleHourLevel(byId.get(card.dataset.pool), now);
    card.classList.toggle('pool--hour-warn', level === 'warn');
    card.classList.toggle('pool--hour-crit', level === 'crit');
    // Announce only when the level changes, not every second.
    const sr = card.querySelector('[data-hour-sr]');
    if (sr && sr.dataset.level !== (level || '')) {
      sr.dataset.level = level || '';
      sr.textContent = level ? SR_TEXT[level] : '';
    }
  });
}

export function dismissHourAlert(tableId) {
  const a = hourAlertFor(state.tables.find((t) => t.id === tableId));
  if (!a) return;
  memory.dismissed.add(a.key);
  save();
  applyHourAlerts();
}

// A booked table whose booking ends within 15 minutes already gets the booking chime (time-alerts.js),
// so the hour-mark chime stays quiet then and two sounds don't stack.
function bookingAlertCovers(table, now) {
  const s = table.session;
  const left = isTimed(s) ? plannedMs(s) - elapsedMs(table, now) : null;
  return left != null && left > 0 && left <= 15 * MIN;
}

export function startHourAlerts() {
  function check() {
    const now = serverNow();
    for (const t of state.tables) {
      const a = hourAlertFor(t, now);
      if (!a || memory.chimed.has(a.key)) continue;
      memory.chimed.add(a.key); // also when first seen in the last minute: a late chime would be noise
      save();
      if (a.level === 'warn' && !a.dismissed && !bookingAlertCovers(t, now)) playHourChime();
    }
    checkHourCrossings(now);
    applyHourAlerts();
  }

  function onClick(e) {
    const btn = e.target.closest('[data-hour-dismiss]');
    if (!btn) return;
    const card = btn.closest('.pool');
    dismissHourAlert(btn.dataset.hourDismiss);
    // The dismiss button just disappeared: hand keyboard focus back to the card so it isn't lost.
    card?.querySelector('.pool__hit')?.focus();
  }

  // Browsers only allow sound after the page has been tapped once.
  const prime = () => primeAlarmAudio();
  document.addEventListener('pointerdown', prime, { once: true });
  document.addEventListener('keydown', prime, { once: true });
  document.addEventListener('click', onClick);

  const offs = [on('tick', check), on('tables', check)];
  check();
  return () => {
    offs.forEach((off) => off());
    document.removeEventListener('click', onClick);
    document.removeEventListener('pointerdown', prime);
    document.removeEventListener('keydown', prime);
  };
}
