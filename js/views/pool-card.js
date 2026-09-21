import {
  elapsedMs, currentBill, PRICING, isTimed, remainingMs, overtimeMs, billingStatus,
} from '../billing.js';
import { esc, icon, peso, fmtDuration, fmtBooking } from '../ui.js';
import { visibleHourLevel } from '../hour-alerts.js';
import { serverNow } from '../clock.js';

// Live tables show a spinning 9-ball in place of the status lamp; the highlight layer stays still
// while the inner ball (with its off-center "9") rotates, so it reads as a ball turning.
const NINE_BALL = '<span class="nine-ball" aria-hidden="true"><span class="nine-ball__spin"><span class="nine-ball__face">9</span></span></span>';

const POCKETS = ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
  .map((p) => `<span class="pocket pocket--${p}" aria-hidden="true"></span>`).join('');

/**
 * The card's second readout. A booked table counts down "Time left", then shows "Overtime" past the booking.
 * An Open Time table shows its rate until the first hour is used up, then "Overtime" too (time past 1:00:00).
 * Overtime is only what the customer has played beyond that point; the bill next to it comes from
 * calculateBilliardBill, so during the 5-minute grace it reads e.g. "Overtime +00:04:30 / Bill ₱200.00".
 */
export function bookingStatus(t, elapsed) {
  if (isTimed(t.session)) {
    const over = overtimeMs(t.session, elapsed);
    return over > 0
      ? { label: 'Overtime', value: `+${fmtDuration(over)}`, over: true }
      : { label: 'Time left', value: fmtDuration(remainingMs(t.session, elapsed)), over: false };
  }
  const over = elapsed - PRICING.baseMinutes * 60000;
  return over > 0
    ? { label: 'Overtime', value: `+${fmtDuration(over)}`, over: true }
    : { label: 'Rate', value: `₱${PRICING.basePrice} / 1st hr`, over: false };
}

/**
 * The billing status as text for screen readers (no visible banner: the card's yellow/red look, the highlighted bill
 * and the Overtime readout carry it). The state comes from billingStatus() (js/billing.js), the same calculation
 * that produces the bill.
 */
export const BILLING_ALERT_TEXT = {
  approaching: ['APPROACHING', 'BILLING THRESHOLD'],
  reached: ['BILLING THRESHOLD', 'REACHED / OVERTIME'],
};

export function billingAlertInner(state) {
  const text = BILLING_ALERT_TEXT[state];
  return text ? text.join(' ') : '';
}

/** Card modifier for a billing state ('' when normal). */
export const billingClass = (state) => (state === 'approaching' ? 'pool--approaching' : state === 'reached' ? 'pool--threshold' : '');

/**
 * Top-down pool table card for the floor grid. One glance: dark navy cloth with a lit LED = In Use,
 * pale cloth with an unlit display = Available. The card carries no visible buttons: the whole card is
 * the tap target (stretched-hit pattern). On the Tables screen it opens that table's actions
 * (Open Time / Set Hours, or Stop & Bill); on the Checkout picker (picker: true) it goes straight to the bill.
 */
export function poolCard(t, { picker = false } = {}) {
  const live = t.status === 'in_use' && Boolean(t.session);
  const stopped = live && t.session.ended;
  const timed = live && isTimed(t.session);
  const now = serverNow(); // one instant for the timer, the bill and the billing status, so they can't disagree
  const elapsed = live ? elapsedMs(t, now) : 0;
  const booking = live ? bookingStatus(t, elapsed) : null;
  // Hour-mark alert (5 min / 1 min before each whole hour): a state layered on a running card, see hour-alerts.js.
  const hourLevel = live && !stopped ? visibleHourLevel(t) : null;
  const billing = live ? billingStatus(t.session, elapsed) : null;
  const id = esc(t.id);
  // Stopped tables are still In Use (unpaid); the navy cloth says so visually, the sr-only prefix says it aloud.
  const status = !live ? 'Available'
    : stopped ? '<span class="sr-only">In Use, </span>Clock Stopped'
      : `<span class="sr-only">In Use, </span>${timed ? `Booked ${esc(fmtBooking(t.session.plannedMs))}` : 'Open Time'}`;

  return `
    <article class="pool ${live ? 'pool--live' : 'pool--idle'}${stopped ? ' pool--stopped' : ''}${booking?.over && !stopped ? ' pool--overtime' : ''}${hourLevel ? ` pool--hour-${hourLevel}` : ''}${billing && billingClass(billing.state) ? ` ${billingClass(billing.state)}` : ''}" aria-labelledby="pool-${id}" data-pool="${id}">
      <h2 class="pool__plate" id="pool-${id}">${esc(t.name)}</h2>
      <div class="pool__table">
        ${POCKETS}
        <div class="pool__cloth">
          <p class="pool__status">${live ? NINE_BALL : '<span class="pool__lamp" aria-hidden="true"></span>'}${status}</p>
          ${live ? `<div class="pool__alert pool__alert--${billing.state}" data-alert="${id}" data-alert-state="${billing.state}" role="status" aria-live="polite"${billing.state === 'normal' ? ' hidden' : ''}>${billingAlertInner(billing.state)}</div>` : ''}
          <div class="led">
            ${live
              ? `<span class="led__digits num" data-elapsed="${id}">${fmtDuration(elapsed)}</span>`
              : '<span class="led__digits num" aria-hidden="true">--:--:--</span><span class="sr-only">Timer not running</span>'}
          </div>
          <dl class="pool__meta">
            ${live
              ? `<div><dt data-left-label="${id}">${booking.label}</dt><dd class="num" data-left="${id}">${booking.value}</dd></div>`
              : `<div><dt>Rate</dt><dd class="num">₱${PRICING.basePrice} / 1st hr</dd></div>`}
            <div><dt>Bill</dt><dd class="num" ${live ? `data-bill="${id}"` : ''}>${live ? peso(currentBill(t, now)) : '—'}</dd></div>
          </dl>
        </div>
      </div>
      ${live && !stopped ? `<span class="pool__bell" aria-hidden="true">${icon('bell')}</span>
      <button type="button" class="pool__dismiss" data-hour-dismiss="${id}" data-fk="dismiss-${id}" aria-label="Dismiss hour-mark alert for ${esc(t.name)}">${icon('x')}</button>
      <span class="sr-only" role="status" data-hour-sr="${id}" data-level="${hourLevel || ''}">${hourLevel === 'crit' ? 'Hour mark in under 1 minute.' : hourLevel === 'warn' ? 'Hour mark in under 5 minutes.' : ''}</span>` : ''}
      ${picker
        ? `<a class="pool__hit" href="#/checkout/${encodeURIComponent(t.id)}" data-fk="bill-${id}" aria-label="Bill ${esc(t.name)}"></a>`
        : `<button type="button" class="pool__hit" data-action="open-table" data-id="${id}" data-fk="pool-${id}" aria-label="${esc(t.name)}, ${live ? 'in use' : 'available'}. Show actions"></button>`}
    </article>`;
}
