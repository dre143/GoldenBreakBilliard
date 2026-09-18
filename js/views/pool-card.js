import {
  elapsedMs, currentBill, PRICING, isTimed, remainingMs, overtimeMs,
} from '../billing.js';
import { esc, icon, peso, fmtDuration, fmtBooking } from '../ui.js';

// Live tables show a spinning 9-ball in place of the status lamp; the highlight layer stays still
// while the inner ball (with its off-center "9") rotates, so it reads as a ball turning.
const NINE_BALL = '<span class="nine-ball" aria-hidden="true"><span class="nine-ball__spin"><span class="nine-ball__face">9</span></span></span>';

const POCKETS = ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
  .map((p) => `<span class="pocket pocket--${p}" aria-hidden="true"></span>`).join('');

/** Countdown text for a booked table: time left, or how far over it is. */
export function bookingStatus(t, elapsed) {
  const over = overtimeMs(t.session, elapsed);
  return over > 0
    ? { label: 'Overtime', value: `+${fmtDuration(over)}`, over: true }
    : { label: 'Time left', value: fmtDuration(remainingMs(t.session, elapsed)), over: false };
}

/**
 * Top-down pool table card for the floor grid. One glance: dark navy cloth with a lit LED = In Use,
 * pale cloth with an unlit display = Available. A free table offers Open Time (runs until stopped)
 * or Set Hours (a booked number of hours). On a live table the whole card is the Stop & Bill link
 * (stretched-link pattern), so it's a single tap to Checkout.
 */
export function poolCard(t) {
  const live = t.status === 'in_use' && Boolean(t.session);
  const stopped = live && t.session.ended;
  const timed = live && isTimed(t.session);
  const elapsed = live ? elapsedMs(t) : 0;
  const booking = timed ? bookingStatus(t, elapsed) : null;
  const id = esc(t.id);
  // Stopped tables are still In Use (unpaid); the navy cloth says so visually, the sr-only prefix says it aloud.
  const status = !live ? 'Available'
    : stopped ? '<span class="sr-only">In Use, </span>Clock Stopped'
      : `<span class="sr-only">In Use, </span>${timed ? `Booked ${esc(fmtBooking(t.session.plannedMs))}` : 'Open Time'}`;

  return `
    <article class="pool ${live ? 'pool--live' : 'pool--idle'}${stopped ? ' pool--stopped' : ''}${booking?.over && !stopped ? ' pool--overtime' : ''}" aria-labelledby="pool-${id}" data-pool="${id}">
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
            ${timed
              ? `<div><dt data-left-label="${id}">${booking.label}</dt><dd class="num" data-left="${id}">${booking.value}</dd></div>`
              : `<div><dt>Rate</dt><dd class="num">₱${PRICING.basePrice} / 1st hr</dd></div>`}
            <div><dt>Bill</dt><dd class="num" ${live ? `data-bill="${id}"` : ''}>${live ? peso(currentBill(t)) : '—'}</dd></div>
          </dl>
        </div>
      </div>
      ${live
        ? `<a class="btn btn--amber btn--block btn--lg pool__cta pool__cta--stretch" href="#/checkout/${encodeURIComponent(t.id)}" data-fk="bill-${id}">${icon('stop')}Stop &amp; Bill</a>`
        : `<div class="pool__actions">
            <button type="button" class="btn btn--primary btn--lg" data-action="open-time" data-id="${id}" data-fk="open-${id}" aria-label="Open time on ${esc(t.name)}">${icon('play')}Open Time</button>
            <button type="button" class="btn btn--neutral btn--lg" data-action="set-hours" data-id="${id}" data-fk="hours-${id}" aria-label="Set hours on ${esc(t.name)}">${icon('clock')}Set Hours</button>
          </div>`}
    </article>`;
}
