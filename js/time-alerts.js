// Time-left alerts for booked (Set Hours) tables: a chime and an alert card at 15 minutes left, and a
// louder chime and card again at 5 minutes left. Each alert fires once per table per game on this device
// (remembered for the browser session, so a page reload doesn't repeat it). Open Time tables have no end
// time, so they never alert. Every table (booked or open) also chimes once when a billing threshold is reached.
// Runs on every screen while someone is signed in.
import { state, on } from './state.js';
import { elapsedMs, isTimed, plannedMs, billingStatus } from './billing.js';
import { playWarningChime, playUrgentChime, primeAlarmAudio } from './alarm.js';
import { esc, fmtCountdown } from './ui.js';

const MIN = 60 * 1000;

// Checked from the smallest window up: a table with 4 minutes left only gets the 5-minute alert.
export const TIME_ALERTS = [
  { key: '5', ms: 5 * MIN, label: '5 minutes left', level: 'urgent', sound: playUrgentChime },
  { key: '15', ms: 15 * MIN, label: '15 minutes left', level: 'warn', sound: playWarningChime },
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

  // A billing threshold was just crossed (the card turns red): chime once. "Just" matters, so a tablet opened
  // mid-overtime doesn't chime for a threshold that passed long ago. Uses the same billingStatus() as the card.
  function checkThresholds() {
    for (const t of state.tables) {
      const s = t.session;
      if (!s) continue;
      const elapsed = elapsedMs(t);
      const b = billingStatus(s, elapsed);
      if (b.state !== 'reached' || elapsed - b.thresholdAtMs > THRESHOLD_CHIME_WINDOW_MS) continue;
      const id = `${t.id}:${s.startedAt}:threshold:${b.thresholdAtMs}`;
      if (fired.has(id)) continue;
      fired.add(id);
      saveFired(fired);
      playUrgentChime();
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
      const id = `${t.id}:${s.startedAt}:${alert.key}`;
      if (fired.has(id)) continue;
      // Mark this alert and every wider one as done, so a 5-minute alert is never followed by a 15-minute one.
      for (const a of TIME_ALERTS) if (a.ms >= alert.ms) fired.add(`${t.id}:${s.startedAt}:${a.key}`);
      saveFired(fired);
      open.set(t.id, { id, alert });
      alert.sound();
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
