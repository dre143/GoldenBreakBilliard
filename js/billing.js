// Pure billing/inventory rules shared by the UI, services, demo seed and tests.
import { serverNow } from './clock.js';

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MINUTE = 60 * 1000;

/**
 * The hall's official table rate (same for every table):
 *   first 60 minutes ............ ₱200 (flat, even for a shorter session)
 *   after the hour, ₱50 more at 1:05:00, then every 15 minutes: 1:20:00, 1:35:00, 1:50:00, ...
 *
 * 5-MINUTE GRACE: from 1:00:00 through 1:04:59 the bill is still ₱200. A customer who has said "end na
 * ko" shouldn't pay another ₱50 just because the cashier was busy at the counter. The first ₱50 lands
 * exactly at 1:05:00 (firstExtraAtMinutes = 65), and each following ₱50 is 15 minutes after the last.
 * The timer itself is never held back: elapsed time and billable amount are separate things.
 *
 * These numbers are mirrored in firestore.rules (feeOk), which re-checks every sale's fee.
 * Sales saved before the grace period existed carry a pricing snapshot without firstExtraAtMinutes;
 * calculateBilliardBill() still reads those with the old rule so their receipts stay accurate.
 */
export const PRICING = Object.freeze({
  baseMinutes: 60,
  basePrice: 200,
  bracketMinutes: 15,
  bracketPrice: 50,
  firstExtraAtMinutes: 65,
});

/** "1:05:00" style clock for a number of minutes (used in labels). */
const clockLabel = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:00`;

export const PRICING_LABEL = `₱${PRICING.basePrice} first hour · ₱${PRICING.bracketPrice} every ${PRICING.bracketMinutes} min from ${clockLabel(PRICING.firstExtraAtMinutes)} (5-min grace)`;

/**
 * THE authoritative bill calculation. Everything that shows or charges a table fee goes through here:
 * the table card, Open Time, Set Hours, checkout, the booking preview, the server-side sale check
 * (mirrored in firestore.rules) and the tests. Nothing else may compute a fee.
 *
 * elapsedMs: the time the customer actually consumed (real elapsed time, never the booked time).
 * Returns { fee, extraBrackets, inGrace, graceEndsAtMs, nextIncreaseAtMs }:
 *   fee              ₱200 until 1:04:59, ₱250 from 1:05:00, ₱300 from 1:20:00, ...
 *   inGrace          true from 1:00:00 up to (not including) 1:05:00: the hour is over but no charge yet
 *   nextIncreaseAtMs the elapsed time at which the fee next goes up\n *   lastIncreaseAtMs the elapsed time at which it last went up (null while still on the first-hour fee)
 */
export function calculateBilliardBill(elapsedMs, pricing = PRICING) {
  const ms = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  const baseMs = pricing.baseMinutes * MINUTE;
  const bracketMs = pricing.bracketMinutes * MINUTE;

  if (pricing.firstExtraAtMinutes == null) {
    // Sale saved before the grace period: every started 15 minutes after the hour was charged.
    const over = ms - baseMs;
    const brackets = over > 0 ? Math.ceil(over / bracketMs) : 0;
    return {
      fee: pricing.basePrice + brackets * pricing.bracketPrice,
      extraBrackets: brackets,
      inGrace: false,
      graceEndsAtMs: baseMs,
      nextIncreaseAtMs: baseMs + brackets * bracketMs,
      lastIncreaseAtMs: null,
    };
  }

  const firstExtraAtMs = pricing.firstExtraAtMinutes * MINUTE;
  // Thresholds are reached inclusively: at exactly 1:05:00 the first ₱50 is already due.
  const brackets = ms >= firstExtraAtMs ? 1 + Math.floor((ms - firstExtraAtMs) / bracketMs) : 0;
  return {
    fee: pricing.basePrice + brackets * pricing.bracketPrice,
    extraBrackets: brackets,
    inGrace: ms >= baseMs && ms < firstExtraAtMs,
    graceEndsAtMs: firstExtraAtMs,
    nextIncreaseAtMs: firstExtraAtMs + brackets * bracketMs,
    lastIncreaseAtMs: brackets ? firstExtraAtMs + (brackets - 1) * bracketMs : null,
  };
}

/* The helpers below are views of calculateBilliardBill, not separate formulas. */

/** Table fee for a duration in milliseconds. */
export const tableFee = (ms, pricing = PRICING) => calculateBilliardBill(ms, pricing).fee;

/** Number of ₱50 steps added on top of the first hour. */
export const extraBrackets = (ms, pricing = PRICING) => calculateBilliardBill(ms, pricing).extraBrackets;

/** Elapsed time at which the fee next goes up (so staff can tell customers). */
export const nextIncreaseAt = (ms, pricing = PRICING) => calculateBilliardBill(ms, pricing).nextIncreaseAtMs;

/** Human breakdown, e.g. "₱200 first hour + 2 × ₱50", or a grace-period note between 1:00:00 and 1:05:00. */
export function feeBreakdown(ms, pricing = PRICING) {
  const bill = calculateBilliardBill(ms, pricing);
  if (bill.inGrace) return `₱${pricing.basePrice} first hour · grace period, no extra charge yet`;
  return bill.extraBrackets
    ? `₱${pricing.basePrice} first hour + ${bill.extraBrackets} × ₱${pricing.bracketPrice}`
    : `₱${pricing.basePrice} first hour`;
}
/* ---------- session modes ---------- */

/**
 * A table is opened one of two ways:
 *   'open'  — open time: runs until the cashier stops it.
 *   'timed' — the customer books a length (session.plannedMs): the time they intend to play. It drives the
 *             "time left" countdown, the alerts and when overtime starts. It is NOT what they pay for.
 * Three separate things: BOOKED duration (plannedMs), ACTUAL elapsed time (start to end stamps) and the
 * BILLABLE amount, which is calculated from the actual elapsed time only. Unused booked time is never charged.
 */
export const plannedMs = (session) => Math.max(0, Number(session?.plannedMs) || 0);
export const isTimed = (session) => plannedMs(session) > 0;

// Auto-stop uses the device's server-clock estimate; its server timestamp can land
// just before the booking boundary. Keep this tolerance aligned with firestore.rules.
export const BOOKING_END_TOLERANCE_MS = 2000;
/** An unpaid timed session that reached its booking end can be extended. */
export const canExtendEndedSession = (session) => Boolean(session?.ended && !session.cancelled
  && isTimed(session) && session.startedAt != null && session.endedAt != null
  && sessionElapsed(session, session.endedAt) >= plannedMs(session) - BOOKING_END_TOLERANCE_MS);

export const sessionElapsed = (session, end) => Math.max(0,
  (session.elapsedBeforeResume || 0) + end - (session.resumedAt ?? session.startedAt));

export const bookingEndsAt = (session) => (session.resumedAt ?? session.startedAt)
  + plannedMs(session) - (session.elapsedBeforeResume || 0);

/** Time left on a booked session (null for open time), and time played past it. */
export const remainingMs = (session, elapsed) => (isTimed(session) ? Math.max(0, plannedMs(session) - elapsed) : null);
export const overtimeMs = (session, elapsed) => (isTimed(session) ? Math.max(0, elapsed - plannedMs(session)) : 0);

/** Bookable lengths: 15-minute steps, so a booking never lands mid-bracket. */
export const BOOKING_STEP_MS = 15 * MINUTE;
export const BOOKING_PRESETS = [1, 2, 3].map((h) => h * 60 * MINUTE);

/**
 * Elapsed play time, excluding waits between an expired booking and its extension.
 * Resumed sessions carry prior play time plus time since their server-stamped resume.
 */
export function elapsedMs(table, now = serverNow()) {
  const s = table?.session;
  if (!s || s.startedAt == null) return 0;
  const end = s.ended && s.endedAt != null ? s.endedAt : now;
  const elapsed = sessionElapsed(s, end);
  // Normalize legacy auto-stops that landed a fraction of a second before expiry.
  return s.ended && isTimed(s) && Math.abs(elapsed - plannedMs(s)) <= BOOKING_END_TOLERANCE_MS
    ? plannedMs(s) : elapsed;
}

export const itemsTotal = (items) =>
  round2((items || []).reduce((sum, i) => sum + i.price * i.qty, 0));

export const itemsCount = (items) => (items || []).reduce((n, i) => n + i.qty, 0);

/* ---------- prepaid Set Hours bookings ----------
 * A Set Hours session can be paid for while it keeps running: session.prepaid tracks how much of the
 * BOOKED time (plannedMs) already has its table fee paid, as { paidMs, paidFee, lastTxId, refunded }.
 * paidMs only ever grows, up to the current plannedMs — "Pay Now" always brings it level with plannedMs
 * in the same write, so the fee for any given minute of booked time is charged exactly once, never twice
 * (see js/services.js payBooking/extendSession). "Pay Later" (extending the booking without paying) grows
 * plannedMs alone, so a balance opens up between what's booked and what's paid; nothing here is charged
 * until the cashier collects it. Open Time never has a prepaid marker.
 */
export const paidMs = (session) => Math.max(0, Number(session?.prepaid?.paidMs) || 0);
export const isPrepaid = (session) => Boolean(session?.prepaid);
/** Fee already collected for the booking (₱0 if never prepaid). */
export const paidFee = (session, pricing = PRICING) => (isPrepaid(session) ? tableFee(paidMs(session), pricing) : 0);
/**
 * What's still owed on the BOOKED length alone (never on time actually played): the schedule fee for the
 * full booking minus what's already been paid. Ends up ₱0 once "Pay Now" has covered the whole booking.
 * Stays based on booked time, not consumed time, so it doesn't shrink if the customer plays less.
 */
export const balanceDue = (session, pricing = PRICING) =>
  (isTimed(session) ? round2(tableFee(plannedMs(session), pricing) - paidFee(session, pricing)) : 0);

/**
 * One session's bill, from its elapsed time. `elapsedMs` is the real time played and is never altered.
 * For an unpaid session the bill is the plain schedule fee for the time played, exactly as before.
 * For a prepaid session, the paid portion is never charged again and is never refunded for playing
 * less than booked (see js/billing.js prepaid section above): the fee is calculated on whichever is
 * larger, the time actually played or the time already paid for, then the already-paid fee is
 * subtracted — so `tableFee` here is always what's still OWED, not the full schedule amount. A
 * cancelled game has no table fee owed at all (any refund of what was already paid is a separate,
 * append-only refund transaction — see js/services.js cancelGame).
 */
export function billSession(session, elapsed) {
  const cancelled = Boolean(session?.cancelled);
  const floorMs = paidMs(session); // 0 for a session that was never prepaid
  const billedMs = Math.max(elapsed, floorMs);
  const bill = calculateBilliardBill(billedMs);
  const owed = cancelled ? 0 : round2(bill.fee - paidFee(session));
  return { elapsedMs: elapsed, billedMs, cancelled, ...bill, fee: owed, tableFee: owed };
}

/**
 * Overtime status of a running table, for the table card: 'normal', 'approaching' or 'reached' (overtime).
 * The colour follows the time that was BOOKED, not the fee steps, and it is independent of the grace period:
 *   reached      red, from the moment the booked time is used up (Set Hours) or the first hour is (Open Time),
 *                and it stays red until checkout. The grace period changes only the bill, never the colour:
 *                a 1h booking is red from 1:00:00, while the bill stays ₱200 until 1:05:00.
 *   approaching  yellow, in the last BILLING_WARNING_MS (5 min) before that moment.
 * It is computed from the same elapsed value as the bill (billSession), so the colour, animation, chime and amount
 * can never disagree about the time. A stopped or cancelled clock is 'normal'.
 * Returns { state, overtimeStartMs, ...billSession } (overtimeStartMs: when the table goes into overtime;
 * lastIncreaseAtMs from the bill is the latest ₱ step, used for the chime).
 */
export const BILLING_WARNING_MS = 5 * MINUTE;
export const overtimeStartMs = (session) => (isTimed(session) ? plannedMs(session) : PRICING.baseMinutes * MINUTE);
export function billingStatus(session, elapsed) {
  const bill = billSession(session, elapsed);
  const startMs = overtimeStartMs(session);
  let state = 'normal';
  if (session && !session.ended && !session.cancelled) {
    if (elapsed > startMs) state = 'reached';
    else if (elapsed >= startMs - BILLING_WARNING_MS) state = 'approaching';
  }
  return { state, overtimeStartMs: startMs, ...bill };
}

/** Table fee for a session: the rate on billable time, or ₱0 once the game was cancelled (see below). */
export const sessionFee = (session, elapsed) => billSession(session, elapsed).tableFee;

export function currentBill(table, now = serverNow()) {
  if (!table?.session) return 0;
  return round2(sessionFee(table.session, elapsedMs(table, now)) + itemsTotal(table.session.items));
}
export const isLowStock = (p) => Number(p.stock) <= Number(p.reorderLevel);

/* ---------- cancel game ----------
 * A customer who changes their mind within the first 5 minutes isn't charged the table fee. The
 * cashier cancels the game from the table itself, before anyone pays: the clock stops and the table
 * fee becomes ₱0. Anything already on the bill (drinks, snacks) is still owed and is paid at checkout.
 * After 5 minutes the table was genuinely used, so there is no cancel and the fee stands.
 * firestore.rules enforces the same 5 minutes against server time.
 */
export const CANCEL_WINDOW_MS = 5 * 60 * 1000;

/** A game can be cancelled while it has run for CANCEL_WINDOW_MS or less (stopped or still running). */
export function canCancelGame(table, now = serverNow()) {
  const s = table?.session;
  if (!s || s.cancelled) return false;
  return elapsedMs(table, now) <= CANCEL_WINDOW_MS;
}

/** How long is left to cancel, in ms (0 once the window has passed). */
export const cancelTimeLeft = (table, now = serverNow()) =>
  table?.session ? Math.max(0, CANCEL_WINDOW_MS - elapsedMs(table, now)) : 0;

export const CANCEL_REASONS = [
  'Customer decided not to play',
  'Started the wrong table',
  'Table was not actually used',
  'Accidental start',
  'Other',
];

/** Sales that count toward totals (a legacy fully-voided sale would be excluded; new voids never are). */
export const activeSales = (txs) => txs.filter((t) => !t.voided);

/* ---------- hour-mark proximity alert ----------
 * A running table gets a heads-up as it nears each whole hour of play (1:00, 2:00, ...): "warn" inside the
 * last 5 minutes, "crit" inside the last minute. Crossing the hour clears it and re-arms it for the next one.
 * `boundary` numbers the hour mark being approached (1 = the first hour), so each hour is its own alert.
 */
export const HOUR_MS = 60 * 60 * 1000;
export const HOUR_WARN_MS = 5 * 60 * 1000;
export const HOUR_CRIT_MS = 60 * 1000;

export function hourAlert(elapsed) {
  if (!(elapsed > 0)) return { level: null, boundary: 1, msToMark: HOUR_MS };
  const boundary = Math.floor(elapsed / HOUR_MS) + 1;
  const msToMark = boundary * HOUR_MS - elapsed;
  const level = msToMark <= HOUR_CRIT_MS ? 'crit' : msToMark <= HOUR_WARN_MS ? 'warn' : null;
  return { level, boundary, msToMark };
}
