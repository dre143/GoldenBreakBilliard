// Pure report aggregation over transaction records. No DOM, no database.
import { round2 } from './billing.js';

/**
 * Billiard halls trade past midnight, so reports group by business day rather than calendar day:
 * a sale at 1:30 AM belongs to the previous evening's business day.
 */
export const BUSINESS_DAY_START_HOUR = 6;

const pad = (n) => String(n).padStart(2, '0');

/** Start timestamp of the business day containing ts. */
export function businessDayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(BUSINESS_DAY_START_HOUR, 0, 0, 0);
  if (d.getTime() > ts) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** 'YYYY-MM-DD' key for the business day containing ts. */
export function dayKey(ts) {
  const d = new Date(businessDayStart(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function keyToStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, BUSINESS_DAY_START_HOUR, 0, 0, 0).getTime();
}

export function shiftKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta, 12);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Inclusive list of day keys from → to. */
export function dayKeys(fromKey, toKey) {
  const keys = [];
  for (let k = fromKey; k <= toKey && keys.length < 400; k = shiftKey(k, 1)) keys.push(k);
  return keys;
}

export const keyLabel = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(keyToStart(key)).toLocaleDateString('en-PH', opts);

/** Money received per channel. Older records without `payments` are inferred from `method`. */
export function paymentsOf(tx) {
  if (tx.payments) return { cash: tx.payments.cash || 0, gcash: tx.payments.gcash || 0, other: 0 };
  if (tx.method === 'cash') return { cash: tx.total, gcash: 0, other: 0 };
  if (tx.method === 'gcash') return { cash: 0, gcash: tx.total, other: 0 };
  return { cash: 0, gcash: 0, other: tx.total }; // legacy 'card'
}

const emptyTotals = () => ({
  count: 0, durationMs: 0, rounds: 0, items: 0,
  tableFee: 0, productTotal: 0, total: 0, cash: 0, gcash: 0, other: 0,
});

function add(acc, tx) {
  const p = paymentsOf(tx);
  acc.count += 1;
  acc.durationMs += tx.durationMs || 0;
  acc.rounds += tx.rounds || 0;
  acc.items += (tx.items || []).reduce((n, i) => n + i.qty, 0);
  acc.tableFee += tx.tableFee || 0;
  acc.productTotal += tx.productTotal || 0;
  acc.total += tx.total || 0;
  acc.cash += p.cash;
  acc.gcash += p.gcash;
  acc.other += p.other;
  return acc;
}

function rounded(acc) {
  for (const k of ['tableFee', 'productTotal', 'total', 'cash', 'gcash', 'other']) acc[k] = round2(acc[k]);
  return acc;
}

export function totals(txs) {
  return rounded(txs.reduce(add, emptyTotals()));
}

/** One row per business day in the range (days with no sales included as zeros). */
export function byDay(txs, fromKey, toKey) {
  const map = new Map(dayKeys(fromKey, toKey).map((k) => [k, emptyTotals()]));
  for (const tx of txs) {
    const acc = map.get(dayKey(tx.createdAt));
    if (acc) add(acc, tx);
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

/** A shift = one cashier's sales within one business day. */
export function byShift(txs) {
  const map = new Map();
  for (const tx of txs) {
    const key = dayKey(tx.createdAt);
    const id = shiftId(key, tx.cashierId);
    const row = map.get(id) || {
      id, day: key, cashierId: tx.cashierId, cashierName: tx.cashierName,
      firstAt: tx.createdAt, lastAt: tx.createdAt, ...emptyTotals(),
    };
    add(row, tx);
    row.firstAt = Math.min(row.firstAt, tx.createdAt);
    row.lastAt = Math.max(row.lastAt, tx.createdAt);
    map.set(id, row);
  }
  return [...map.values()].map(rounded).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.cashierName.localeCompare(b.cashierName)));
}

export const shiftId = (day, cashierId) => `${day}_${cashierId}`;

/** Table-fee-voided sales, most recently voided first — the owner's audit trail for waived fees. */
export function voidedSales(txs) {
  return txs.filter((t) => t.tableFeeVoided).sort((a, b) => (b.tableFeeVoidedAt || 0) - (a.tableFeeVoidedAt || 0));
}

export function voidedTotals(txs) {
  const list = voidedSales(txs);
  return { count: list.length, refunded: round2(list.reduce((s, t) => s + (t.refundAmount || 0), 0)) };
}

/** RFC 4180 CSV from a header row + data rows. */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
