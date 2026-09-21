import { state } from '../state.js';
import { elapsedMs, currentBill, billingStatus } from '../billing.js';
import { fmtDuration, peso } from '../ui.js';
import { serverNow } from '../clock.js';
import { bookingStatus, billingAlertInner } from './pool-card.js';

/**
 * Update live readouts inside root from table state (called each second):
 * [data-elapsed] timer, [data-bill] running bill, [data-left] booked time left / overtime.
 */
export function updateTableTimers(root) {
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
  // Billing status text/colour: from billingStatus(), at the same instant as the bill above.
  root.querySelectorAll('[data-alert]').forEach((el) => {
    const t = byId.get(el.dataset.alert);
    if (!t?.session) return;
    const { state } = billingStatus(t.session, elapsedMs(t, now));
    if (el.dataset.alertState !== state) {
      el.dataset.alertState = state;
      el.className = `pool__alert pool__alert--${state}`;
      el.innerHTML = billingAlertInner(state);
      el.hidden = state === 'normal';
    }
    const card = el.closest('.pool');
    card?.classList.toggle('pool--approaching', state === 'approaching');
    card?.classList.toggle('pool--threshold', state === 'reached');
  });
  root.querySelectorAll('[data-left]').forEach((el) => {
    const t = byId.get(el.dataset.left);
    if (!t?.session) return;
    const b = bookingStatus(t, elapsedMs(t, now));
    el.textContent = b.value;
    const label = root.querySelector(`[data-left-label="${CSS.escape(el.dataset.left)}"]`);
    if (label) label.textContent = b.label;
    el.closest('.pool')?.classList.toggle('pool--overtime', b.over && !t.session.ended);
  });
}
