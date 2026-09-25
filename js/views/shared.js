import { state } from '../state.js';
import { elapsedMs, currentBill } from '../billing.js';
import { fmtDuration, peso } from '../ui.js';
import { serverNow } from '../clock.js';
import { bookingStatus } from './pool-card.js';
import { applyHourAlerts } from '../hour-alerts.js';

/**
 * Update live readouts inside root from table state (called each second):
 * [data-elapsed] timer, [data-bill] running bill, [data-left] booked time left / extra time.
 */
export function updateTableTimers(root) {
  // Display accounts do not start the staff sound service; their cards still need live effects.
  applyHourAlerts(root);
  const byId = new Map(state.tables.map((t) => [t.id, t]));
  const now = serverNow();
  root.querySelectorAll('[data-elapsed]').forEach((el) => {
    const t = byId.get(el.dataset.elapsed);
    if (t?.session) el.textContent = fmtDuration(elapsedMs(t, now));
  });
  root.querySelectorAll('[data-bill]').forEach((el) => {
    const t = byId.get(el.dataset.bill);
    if (t?.session) el.textContent = peso(currentBill(t, now));
  });
  root.querySelectorAll('[data-left]').forEach((el) => {
    const t = byId.get(el.dataset.left);
    if (!t?.session) return;
    const b = bookingStatus(t, elapsedMs(t, now));
    el.textContent = b.value;
    const label = root.querySelector(`[data-left-label="${CSS.escape(el.dataset.left)}"]`);
    if (label) label.textContent = b.label;
  });
}
