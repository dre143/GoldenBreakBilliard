import {
  elapsedMs, currentBill, PRICING, isTimed, remainingMs, overtimeMs,
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
 * The card's second readout. A booked table counts down "Time left", then shows "Extra time" once the
 * booking runs out. An Open Time table has no booking to count down, so it just always shows the rate —
 * the actual running total is the Bill line next to it, which comes from calculateBilliardBill on the
 * real elapsed time regardless of what this readout says.
 */
export function bookingStatus(t, elapsed) {
  if (isTimed(t.session)) {
    if (t.session.ended) return { label: 'Time left', value: fmtDuration(remainingMs(t.session, elapsed)) };
    const over = overtimeMs(t.session, elapsed);
    return over > 0
      ? { label: 'Extra time', value: `+${fmtDuration(over)}` }
      : { label: 'Time left', value: fmtDuration(remainingMs(t.session, elapsed)) };
  }
  return { label: 'Rate', value: `₱${PRICING.basePrice} / 1st hr` };
}

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
  const now = serverNow(); // one instant for the timer and the bill, so they can't disagree
  const elapsed = live ? elapsedMs(t, now) : 0;
  const booking = live ? bookingStatus(t, elapsed) : null;
  // Hour-mark alert (5 min / 1 min before each whole hour): a state layered on a running card, see hour-alerts.js.
  const hourLevel = live && !stopped ? visibleHourLevel(t) : null;
  const id = esc(t.id);
  // Stopped tables are still In Use (unpaid); the navy cloth says so visually, the sr-only prefix says it aloud.
  const status = !live ? 'Available'
    : stopped ? '<span class="sr-only">In Use, </span>Session ended'
      : `<span class="sr-only">In Use, </span>${timed ? `Booked ${esc(fmtBooking(t.session.plannedMs))}` : 'Open Time'}`;

  return `
    <article class="pool ${live ? 'pool--live' : 'pool--idle'}${stopped ? ' pool--stopped' : ''}${hourLevel ? ` pool--hour-${hourLevel}` : ''}" aria-labelledby="pool-${id}" data-pool="${id}">
      <h2 class="pool__plate" id="pool-${id}">${esc(t.name)}</h2>
      <div class="pool__table">
        ${POCKETS}
        <div class="pool__cloth">
          <p class="pool__status">${live ? NINE_BALL : '<span class="pool__lamp" aria-hidden="true"></span>'}${status}</p>
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
