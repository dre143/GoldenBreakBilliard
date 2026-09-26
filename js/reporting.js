// Pure report aggregation over transaction records. No DOM, no database.
import { round2 } from './billing.js';
import { HALL_TZ, HALL_OFFSET_MS } from './clock.js';

/**
 * Billiard halls trade past midnight, so reports group by business day rather than calendar day:
 * a sale at 1:30 AM belongs to the previous evening's business day.
 */
export const BUSINESS_DAY_START_HOUR = 6;

const pad = (n) => String(n).padStart(2, '0');

// All day arithmetic below is done on the hall's clock (UTC+8) with plain UTC math, never with the device's
// local time zone: the same instant must give the same business day and shift on every device.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Start timestamp of the business day containing ts. */
export function businessDayStart(ts = Date.now()) {
  const startOffset = BUSINESS_DAY_START_HOUR * HOUR;
  const hallMs = ts + HALL_OFFSET_MS - startOffset; // hall time, shifted so the business day starts at "midnight"
  return Math.floor(hallMs / DAY) * DAY + startOffset - HALL_OFFSET_MS;
}

/** 'YYYY-MM-DD' key for the business day containing ts. */
export function dayKey(ts) {
  const d = new Date(businessDayStart(ts) + HALL_OFFSET_MS); // 6:00 AM hall time: same calendar date as the key
  return keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function keyToStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d, BUSINESS_DAY_START_HOUR) - HALL_OFFSET_MS;
}

export function shiftKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Inclusive list of day keys from → to. */
export function dayKeys(fromKey, toKey) {
  const keys = [];
  for (let k = fromKey; k <= toKey && keys.length < 400; k = shiftKey(k, 1)) keys.push(k);
  return keys;
}

export const keyLabel = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(keyToStart(key)).toLocaleDateString('en-PH', { timeZone: HALL_TZ, ...opts });

/* ---------- cashier shifts ---------- */

/**
 * The business day splits into two fixed cashier shifts: Day (6:00 AM to 6:00 PM) and Night
 * (6:00 PM to 6:00 AM the next morning). Boundaries are half-open, so a sale at 5:59:59 PM is on the
 * day shift and one at exactly 6:00:00 PM is on the night shift. Shifts never overlap or leave a gap.
 * "Full day" is the whole business day (both shifts).
 */
export const SHIFT_SPLIT_HOUR = 18;
export const SHIFTS = ['full', 'day', 'night'];

const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
export const SHIFT_LABEL = {
  full: 'Full day',
  day: `Day shift (${hourLabel(BUSINESS_DAY_START_HOUR)}–${hourLabel(SHIFT_SPLIT_HOUR)})`,
  night: `Night shift (${hourLabel(SHIFT_SPLIT_HOUR)}–${hourLabel(BUSINESS_DAY_START_HOUR)})`,
};
export const SHIFT_SHORT = { full: 'Full day', day: 'Day', night: 'Night' };

function splitAt(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d, SHIFT_SPLIT_HOUR) - HALL_OFFSET_MS;
}

/** [start, end) timestamps of a shift on business day `key`. */
export function shiftRange(key, shift = 'full') {
  const start = keyToStart(key);
  const end = keyToStart(shiftKey(key, 1));
  if (shift === 'day') return [start, splitAt(key)];
  if (shift === 'night') return [splitAt(key), end];
  return [start, end];
}

/** 'day' or 'night' for the moment ts. */
export const shiftOf = (ts) => (ts < splitAt(dayKey(ts)) ? 'day' : 'night');

/* ---------- expenses ---------- */

/** Cash taken out of the drawer (water, fare, supplies…), logged by the cashier on duty. */
export const expenseTotal = (expenses) => round2((expenses || []).reduce((s, e) => s + (e.amount || 0), 0));

/** Money received per channel. Older records without `payments` are inferred from `method`. */
export function paymentsOf(tx) {
  if (tx.payments) return { cash: tx.payments.cash || 0, gcash: tx.payments.gcash || 0, other: 0 };
  if (tx.method === 'cash') return { cash: tx.total, gcash: 0, other: 0 };
  if (tx.method === 'gcash') return { cash: 0, gcash: tx.total, other: 0 };
  return { cash: 0, gcash: 0, other: tx.total }; // legacy 'card'
}

const emptyTotals = () => ({
  count: 0, durationMs: 0, rounds: 0, items: 0,
  tableFee: 0, productTotal: 0, cueStickTotal: 0, total: 0, cash: 0, gcash: 0, other: 0,
  expenses: 0, expenseCount: 0,
});

function addExpense(acc, e) {
  acc.expenses += e.amount || 0;
  acc.expenseCount += 1;
  return acc;
}

function add(acc, tx) {
  const p = paymentsOf(tx);
  acc.count += 1;
  acc.durationMs += tx.durationMs || 0;
  acc.rounds += tx.rounds || 0;
  acc.items += (tx.items || []).reduce((n, i) => n + i.qty, 0);
  acc.tableFee += tx.tableFee || 0;
  acc.productTotal += tx.productTotal || 0;
  acc.cueStickTotal += tx.cueStickTotal || 0;
  acc.total += tx.total || 0;
  acc.cash += p.cash;
  acc.gcash += p.gcash;
  acc.other += p.other;
  return acc;
}

/**
 * Rounds the money fields and derives the two end-of-shift figures:
 *   net         = sales − expenses
 *   cashToCount = cash collected − expenses (expenses are paid out of the cash drawer)
 * A table-fee void already subtracts its refund from the sale's payments, so no further adjustment is needed.
 */
function rounded(acc) {
  for (const k of ['tableFee', 'productTotal', 'cueStickTotal', 'total', 'cash', 'gcash', 'other', 'expenses']) acc[k] = round2(acc[k]);
  acc.net = round2(acc.total - acc.expenses);
  acc.cashToCount = round2(acc.cash - acc.expenses);
  return acc;
}

export function totals(txs, expenses = []) {
  const acc = txs.reduce(add, emptyTotals());
  for (const e of expenses) addExpense(acc, e);
  return rounded(acc);
}

/** One row per business day in the range (days with no sales included as zeros). */
export function byDay(txs, fromKey, toKey, expenses = []) {
  const map = new Map(dayKeys(fromKey, toKey).map((k) => [k, emptyTotals()]));
  for (const tx of txs) {
    const acc = map.get(dayKey(tx.createdAt));
    if (acc) add(acc, tx);
  }
  for (const e of expenses) {
    const acc = map.get(dayKey(e.createdAt));
    if (acc) addExpense(acc, e);
  }
  return [...map].map(([key, acc]) => ({ key, ...rounded(acc) }));
}

export function byMethod(txs) {
  const rows = { cash: emptyTotals(), gcash: emptyTotals(), split: emptyTotals(), other: emptyTotals() };
  for (const tx of txs) add(rows[rows[tx.method] ? tx.method : 'other'], tx);
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, rounded(v)]));
}

export function topProducts(txs, limit = 10) {
  const map = new Map();
  for (const tx of txs) {
    for (const i of tx.items || []) {
      if (!i.productId) continue; // a cue stick sale's items key by cueStickId instead — kept out of this list
      const row = map.get(i.productId) || { productId: i.productId, name: i.name, category: i.category, qty: 0, revenue: 0 };
      row.qty += i.qty;
      row.revenue += i.total ?? i.price * i.qty;
      map.set(i.productId, row);
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, revenue: round2(r.revenue) }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, limit);
}

/**
 * One cashier's sales and expenses within one business day: what they collected, what they paid
 * out of the drawer, and the cash they should hand over (cashToCount).
 */
export function byShift(txs, expenses = []) {
  const map = new Map();
  const rowFor = (at, cashierId, cashierName) => {
    const key = dayKey(at);
    const id = shiftId(key, cashierId);
    const row = map.get(id) || {
      id, day: key, cashierId, cashierName, firstAt: at, lastAt: at, ...emptyTotals(),
    };
    row.firstAt = Math.min(row.firstAt, at);
    row.lastAt = Math.max(row.lastAt, at);
    map.set(id, row);
    return row;
  };
  for (const tx of txs) add(rowFor(tx.createdAt, tx.cashierId, tx.cashierName), tx);
  for (const e of expenses) addExpense(rowFor(e.createdAt, e.cashierId, e.cashierName), e);
  return [...map.values()].map(rounded).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.cashierName.localeCompare(b.cashierName)));
}

export const shiftId = (day, cashierId) => `${day}_${cashierId}`;

/**
 * Games cancelled in their first 5 minutes (no table fee), newest first. This is the owner's audit
 * trail for waived fees. Older sales whose table fee was voided after payment are included too.
 */
/** One shape for a cancelled game or an older post-payment void: when, who, why, and the remark to show. */
export function cancelInfo(t) {
  if (t.gameCancelled) {
    return { at: t.createdAt, by: t.cancelledByName, reason: t.cancelReason, note: t.cancelNote, remark: `Game cancelled (${t.cancelReason})` };
  }
  if (t.tableFeeVoided) {
    return { at: t.tableFeeVoidedAt, by: t.tableFeeVoidedByName, reason: t.voidReason, note: t.voidNote, remark: `Table fee voided (${t.voidReason}), ${t.refundAmount} refunded` };
  }
  return null;
}

export function cancelledGames(txs) {
  const at = (t) => (t.gameCancelled ? t.createdAt : t.tableFeeVoidedAt) || 0;
  // A prepaid booking's cancel also writes a linked refund transaction (kind: 'refund'); it carries
  // gameCancelled too so its own receipt reads right, but the cancellation itself is already counted by
  // the checkout sale it's linked to, so it's excluded here to avoid listing one cancelled game twice.
  return txs.filter((t) => (t.gameCancelled && t.kind !== 'refund') || t.tableFeeVoided).sort((a, b) => at(b) - at(a));
}

/** RFC 4180 CSV from a header row + data rows. */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
