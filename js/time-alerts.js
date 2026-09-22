// Time-left alerts for booked (Set Hours) tables:
//   WARNING — 5 minutes left on the booking: a spoken card, naming the table.
//   EXPIRY  — the booked time itself runs out (elapsed reaches the booking length): the real bell
//             recording, the same one used for the hour-mark alert. Handled in checkThresholds() below,
//             since that's also where the table card turns red for overtime — one clock for the colour,
//             the card and the sound.
// Each alert fires once per game on this device (remembered for the browser session, so a page reload
// doesn't repeat it — and tracked by the session's start time, not the table id, so a Transfer Table move
// carries this state with it rather than re-firing). Open Time tables have no booked length, so neither
// alert applies to them — though every table still chimes at each ₱ step once it's in overtime (see
// checkThresholds()).
// Runs on every screen while someone is signed in.
import { state, on } from './state.js';
import {
  elapsedMs, isTimed, plannedMs, billingStatus, HOUR_MS,
} from './billing.js';
import {
  playUrgentChime, playHourBell, primeAlarmAudio, speakAlert,
} from './alarm.js';
import { esc, fmtCountdown } from './ui.js';

const MIN = 60 * 1000;

// Spoken aloud in a man's voice, naming the table (falls back to a tone chime on a browser with no speech
// voices at all).
export const TIME_ALERTS = [
  { key: '5', ms: 5 * MIN, label: '5 minutes left', level: 'urgent', sound: (name) => speakAlert(`${name}, 5 minutes left`, playUrgentChime) },
];

const THRESHOLD_CHIME_WINDOW_MS = 15 * 1000;
const FIRED_KEY = 'goldenbreak:time-alerts-fired';

function loadFired() {
  try { return new Set(JSON.parse(sessionStorage.getItem(FIRED_KEY)) || []); } catch { return new Set(); }
}
function saveFired(set) {
  try { sessionStorage.setItem(FIRED_KEY, JSON.stringify([...set].slice(-200))); } catch { /* ignore */ }
}

/** Which alert (if any) a table is in right now, from its time left. */
export function alertFor(msLeft) {
  if (!(msLeft > 0)) return null;
  return TIME_ALERTS.find((a) => msLeft <= a.ms) || null;
}

export function startTimeAlerts() {
  const fired = loadFired();
  const open = new Map(); // tableId -> { id, alert }

  const host = document.createElement('div');
  host.className = 'time-alerts';
  host.setAttribute('aria-live', 'assertive');
  document.body.append(host);

  // Browsers block sound until the page is tapped once; unlock audio on the first tap or key press.
  const prime = () => primeAlarmAudio();
  document.addEventListener('pointerdown', prime, { once: true });
  document.addEventListener('keydown', prime, { once: true });

  function render() {
    host.innerHTML = [...open.entries()].map(([tableId, { alert }]) => {
      const t = state.tables.find((x) => x.id === tableId);
      const left = t?.session ? plannedMs(t.session) - elapsedMs(t) : 0;
      return `
        <div class="time-alert time-alert--${alert.level}" role="alert">
          <div class="time-alert__text">
            <strong>${esc(t?.name ?? 'Table')}</strong>
            <span>${alert.label} · <span class="num" data-alert-left="${esc(tableId)}">${fmtCountdown(Math.max(0, left))}</span></span>
          </div>
          <a class="btn btn--neutral btn--sm" href="#/checkout/${encodeURIComponent(tableId)}" data-alert-dismiss="${esc(tableId)}">Open table</a>
          <button type="button" class="btn btn--primary btn--sm" data-alert-dismiss="${esc(tableId)}">OK</button>
        </div>`;
    }).join('');
  }

  // Chime once when a table goes into overtime (the card turns red) and once at each ₱ step after that.
  // "Just" matters, so a tablet opened mid-overtime doesn't chime for a moment that passed long ago.
  // Uses the same billingStatus() as the card, so the sound, the colour and the bill share one clock.
  //
  // EXPIRY: for a Set Hours table, overtimeStartMs is exactly the booked length (js/billing.js), so its
  // 'overtime' moment is the instant the customer's paid-for time actually runs out — that's the real
  // bell. Every later ₱ step stays the plain tone.
  //
  // An Open Time table's own 'overtime' moment is always its first hour of play — the same instant
  // hour-alerts.js already rings the bell for (it does that for every running table, booked or not). A
  // booking whose length happens to be a whole number of hours (a 1h/2h/3h preset) hits that same
  // collision. Either way, skip this module's own sound there so it isn't doubled with that bell.
  function checkThresholds() {
    for (const t of state.tables) {
      const s = t.session;
      if (!s) continue;
      const elapsed = elapsedMs(t);
      const b = billingStatus(s, elapsed);
      if (b.state !== 'reached') continue;
      const moments = [['overtime', b.overtimeStartMs]];
      if (b.lastIncreaseAtMs != null && b.lastIncreaseAtMs > b.overtimeStartMs) moments.push(['step', b.lastIncreaseAtMs]);
      for (const [kind, at] of moments) {
        if (elapsed - at > THRESHOLD_CHIME_WINDOW_MS) continue;
        const id = `${s.startedAt}:${kind}:${at}`; // by session, not table id, so a Transfer Table move carries this state
        if (fired.has(id)) continue;
        fired.add(id);
        saveFired(fired);
        if (kind === 'overtime' && at % HOUR_MS === 0) continue; // hour-alerts.js already rings for this instant
        if (kind === 'overtime' && isTimed(s)) playHourBell();
        else playUrgentChime();
      }
    }
  }

  function check() {
    checkThresholds();
    let changed = false;
    for (const t of state.tables) {
      const s = t.session;
      if (!s || s.ended || s.cancelled || !isTimed(s)) continue;
      const alert = alertFor(plannedMs(s) - elapsedMs(t));
      if (!alert) continue;
      const id = `${s.startedAt}:${alert.key}`; // by session, not table id, so a Transfer Table move carries this state
      if (fired.has(id)) continue;
      // Mark this alert and every wider one as done, so a 5-minute alert is never followed by a 15-minute one.
      for (const a of TIME_ALERTS) if (a.ms >= alert.ms) fired.add(`${s.startedAt}:${a.key}`);
      saveFired(fired);
      open.set(t.id, { id, alert });
      alert.sound(t.name);
      changed = true;
    }
    // Drop cards for tables that were stopped, checked out, or extended past the alert.
    for (const [tableId, { alert }] of open) {
      const t = state.tables.find((x) => x.id === tableId);
      const s = t?.session;
      const current = s && !s.ended && !s.cancelled && isTimed(s) ? alertFor(plannedMs(s) - elapsedMs(t)) : null;
      if (!current || current.ms > alert.ms) { open.delete(tableId); changed = true; }
    }
    if (changed) render();
    else {
      host.querySelectorAll('[data-alert-left]').forEach((el) => {
        const t = state.tables.find((x) => x.id === el.dataset.alertLeft);
        if (t?.session) el.textContent = fmtCountdown(Math.max(0, plannedMs(t.session) - elapsedMs(t)));
      });
    }
  }

  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-alert-dismiss]');
    if (!b) return;
    open.delete(b.dataset.alertDismiss);
    render();
  });

  const offs = [on('tick', check), on('tables', check)];
  check();
  return () => {
    offs.forEach((off) => off());
    document.removeEventListener('pointerdown', prime);
    document.removeEventListener('keydown', prime);
    host.remove();
  };
}
