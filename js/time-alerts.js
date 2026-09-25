// Time-left alerts for booked (Set Hours) tables:
//   WARNING   — 5 minutes left on the booking: a spoken card, naming the table.
//   EXPIRY    — the booked time itself runs out (elapsed reaches the booking length): the real bell
//               recording, the same one used for the hour-mark alert. Handled in checkThresholds() below.
//   AUTO-STOP — a Set Hours table has no overtime: the instant the booked time runs out, checkAutoStop()
//               ends the session itself (the same as the cashier tapping End Session), so the clock and
//               the bill never run past what was booked. Open Time has no booking to run out, so it's
//               unaffected and keeps its own overtime pricing past the first hour.
// Each alert fires once per game on this device (remembered for the browser session, so a page reload
// doesn't repeat it — and tracked by the session's start time, not the table id, so a Transfer Table move
// carries this state with it rather than re-firing). Open Time has no booking to warn about or expire, so
// none of this module's sounds apply to it at all — it only ever gets the (separate) hour-mark bell.
// Runs on every screen while someone is signed in.
import { state, on } from './state.js';
import {
  elapsedMs, isTimed, plannedMs, billingStatus, HOUR_MS,
} from './billing.js';
import {
  playUrgentChime, playHourBell, primeAlarmAudio, speakAlert,
} from './alarm.js';
import { esc, fmtCountdown } from './ui.js';
// Dynamic, not a static import: services.js pulls in db.js, which touches browser-only globals
// (location, localStorage) at module load — fine in the app, fatal if this file is imported by the
// Node test runner (see tests/unit/time-alerts.test.mjs, which only exercises alertFor()).
let endSessionFn = null;
async function autoEndSession(tableId, session) {
  if (!endSessionFn) ({ endSession: endSessionFn } = await import('./services.js'));
  return endSessionFn(tableId, { expiredBooking: plannedMs(session), startedAt: session.startedAt });
}

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
  const stopping = new Set(); // tableIds with an endSession() in flight, so a slow round-trip isn't retried every tick

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

  // EXPIRY, Set Hours only: chime once when the booking's time runs out (overtimeStartMs is exactly the
  // booked length, js/billing.js) and once at each ₱ step after that, in case auto-stop hasn't caught up
  // yet. "Just" matters, so a tablet opened mid-way through doesn't chime for a moment that passed long
  // ago. Open Time has no booking, so it never reaches this loop at all — see the module header.
  function checkThresholds() {
    for (const t of state.tables) {
      const s = t.session;
      if (!s || !isTimed(s)) continue;
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
        if (kind === 'overtime') playHourBell();
        else playUrgentChime();
      }
    }
  }

  // A Set Hours table has no overtime: the moment the booked time is used up, stop the clock right there
  // (same as the cashier's own End Session), so the bill can never run past what was booked. Any
  // signed-in device notices and stops it; endSession() checks session.ended inside its own transaction,
  // so two devices racing to stop the same table can't double-write.
  function checkAutoStop() {
    for (const t of state.tables) {
      const s = t.session;
      if (!s || s.ended || s.cancelled || !isTimed(s) || stopping.has(t.id)) continue;
      if (elapsedMs(t) < plannedMs(s)) continue;
      stopping.add(t.id);
      autoEndSession(t.id, s).catch((err) => console.error('Auto-stop failed', err)).finally(() => stopping.delete(t.id));
    }
  }

  function check() {
    checkThresholds();
    checkAutoStop();
    let changed = false;
    for (const t of state.tables) {
      const s = t.session;
      if (!s || s.ended || s.cancelled || !isTimed(s)) continue;
      const alert = alertFor(plannedMs(s) - elapsedMs(t));
      if (!alert) continue;
      const id = `${s.startedAt}:${plannedMs(s)}:${alert.key}`; // transfers keep the alert; added time re-arms it
      if (fired.has(id)) continue;
      // Mark this alert and every wider one as done, so a 5-minute alert is never followed by a 15-minute one.
      for (const a of TIME_ALERTS) if (a.ms >= alert.ms) fired.add(`${s.startedAt}:${plannedMs(s)}:${a.key}`);
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
