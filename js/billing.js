// Pure billing/inventory rules shared by the UI, services, demo seed and tests.
import { serverNow } from './clock.js';

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MINUTE = 60 * 1000;

/**
 * The hall's official table rate (same for every table):
 *   first 60 minutes ............ ₱200 (flat, even for a shorter session)
 *   each started 15-minute bracket after that ... ₱50, ALWAYS rounded up
 * These numbers are mirrored in firestore.rules (sessionFeeOk), which re-checks every sale's fee.
 */
export const PRICING = Object.freeze({
  baseMinutes: 60,
  basePrice: 200,
  bracketMinutes: 15,
  bracketPrice: 50,
});

export const PRICING_LABEL = `₱${PRICING.basePrice} first hour · ₱${PRICING.bracketPrice} per ${PRICING.bracketMinutes} min after`;

/** Number of extra 15-minute brackets for a duration (any partial bracket counts as a full one). */
export function extraBrackets(ms, pricing = PRICING) {
  const over = Math.max(0, Math.floor(ms)) - pricing.baseMinutes * MINUTE;
  return over > 0 ? Math.ceil(over / (pricing.bracketMinutes * MINUTE)) : 0;
}

/** Table fee for a session duration in milliseconds. */
export function tableFee(ms, pricing = PRICING) {
  return pricing.basePrice + extraBrackets(ms, pricing) * pricing.bracketPrice;
}

/** Human breakdown, e.g. "₱200 first hour + 2 × ₱50". */
export function feeBreakdown(ms, pricing = PRICING) {
  const n = extraBrackets(ms, pricing);
  return n ? `₱${pricing.basePrice} first hour + ${n} × ₱${pricing.bracketPrice}` : `₱${pricing.basePrice} first hour`;
}

/** Elapsed time at which the fee next goes up (so staff can tell customers). */
export function nextIncreaseAt(ms, pricing = PRICING) {
  const base = pricing.baseMinutes * MINUTE;
  const bracket = pricing.bracketMinutes * MINUTE;
  if (ms <= base) return base;
  return base + extraBrackets(ms, pricing) * bracket;
}

/* ---------- session modes ---------- */

/**
 * A table is opened one of two ways:
 *   'open'  — open time: runs until the cashier stops it, billed on actual time.
 *   'timed' — the customer buys a set number of hours (session.plannedMs). Those hours are the
 *             minimum charge; if they keep playing, the extra time is billed by the same rule.
 * So the billed time is always whichever is longer, booked or actual.
 */
export const plannedMs = (session) => Math.max(0, Number(session?.plannedMs) || 0);
export const isTimed = (session) => plannedMs(session) > 0;

export const billableMs = (session, elapsed) => Math.max(elapsed, plannedMs(session));

/** Time left on a booked session (null for open time), and time played past it. */
export const remainingMs = (session, elapsed) => (isTimed(session) ? Math.max(0, plannedMs(session) - elapsed) : null);
export const overtimeMs = (session, elapsed) => (isTimed(session) ? Math.max(0, elapsed - plannedMs(session)) : 0);

/** Bookable lengths: 15-minute steps, so a booking never lands mid-bracket. */
export const BOOKING_STEP_MS = 15 * MINUTE;
export const BOOKING_PRESETS = [1, 2, 3].map((h) => h * 60 * MINUTE);

/**
 * Elapsed play time. Sessions can't be paused: time runs from the server-stamped start until the
 * server-stamped end (once ended), otherwise until "now" (server-synced, for display only).
 */
export function elapsedMs(table, now = serverNow()) {
  const s = table?.session;
  if (!s || s.startedAt == null) return 0;
  const end = s.ended && s.endedAt != null ? s.endedAt : now;
  return Math.max(0, end - s.startedAt);
}

export const itemsTotal = (items) =>
  round2((items || []).reduce((sum, i) => sum + i.price * i.qty, 0));

export const itemsCount = (items) => (items || []).reduce((n, i) => n + i.qty, 0);

/** Table fee for a session: the rate on billable time, or ₱0 once the game was cancelled (see below). */
export const sessionFee = (session, elapsed) => (session?.cancelled ? 0 : tableFee(billableMs(session, elapsed)));

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
