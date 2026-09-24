// Business operations. Every state change that touches more than one field or document runs in a
// transaction so two terminals can't double-bill a table or oversell stock.
//
// Time integrity: session start/end and sale times are written as SERVER_TIME (the database server's
// clock), never the device clock. The table fee is computed only from those stored stamps, and
// firestore.rules re-computes and verifies it, so changing a till's clock can't change a bill.
import { db, auth } from './db.js';
import {
  elapsedMs, round2, itemsTotal, CANCEL_REASONS, CANCEL_WINDOW_MS, PRICING,
  billSession, plannedMs, BOOKING_STEP_MS,
} from './billing.js';
import { SERVER_TIME, serverNow } from './clock.js';

/* ---------- table sessions ---------- */

const validBooking = (ms) => Number.isInteger(ms) && ms > 0 && ms % BOOKING_STEP_MS === 0;

/**
 * Open a table. booking = 0 → open time (runs until stopped, billed on actual play).
 * booking > 0 → the customer books that many milliseconds: the time they intend to play. It is not the bill;
 * the bill is always calculated from the time actually played. Bookings are whole 15-minute steps.
 */
export function startSession(tableId, user, { booking = 0 } = {}) {
  if (booking && !validBooking(booking)) return Promise.reject(new Error('Choose the time in 15-minute steps.'));
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t) throw new Error('Table not found.');
    if (t.status !== 'available') throw new Error(`${t.name} already has an open session.`);
    tx.update('tables', tableId, {
      status: 'in_use',
      session: {
        startedAt: SERVER_TIME, ended: false, endedAt: null, plannedMs: booking, items: [], rounds: 0,
        openedBy: user.uid, openedByName: user.name,
      },
      updatedAt: SERVER_TIME,
    });
  });
}

/** Add booked time to a running session (a customer buying another hour). Booked time can't be cut. */
export function extendSession(tableId, addMs) {
  if (!validBooking(addMs)) return Promise.reject(new Error('Choose the time in 15-minute steps.'));
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t?.session) throw new Error('This table has no open session.');
    if (t.session.ended) throw new Error('This session has already been stopped.');
    const planned = plannedMs(t.session) + addMs;
    tx.update('tables', tableId, { 'session.plannedMs': planned, updatedAt: SERVER_TIME });
    return planned;
  });
}

/** Stop the clock for billing: the server stamps the end time. Final: a session can't be resumed. */
export function endSession(tableId) {
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t?.session) throw new Error('This table has no open session.');
    if (t.session.ended) return;
    tx.update('tables', tableId, { 'session.ended': true, 'session.endedAt': SERVER_TIME, updatedAt: SERVER_TIME });
  });
}

/**
 * Cancel a game within the first CANCEL_WINDOW_MS (5 minutes): the customer changed their mind, so
 * the table fee is ₱0. A running clock stops in the same write (server-stamped); a clock that was
 * already stopped must have run 5 minutes or less. firestore.rules checks the window against server
 * time. Items already on the bill are still owed and are paid at checkout.
 */
export function cancelGame(tableId, { reason, note = '' } = {}, user) {
  if (!CANCEL_REASONS.includes(reason)) return Promise.reject(new Error('Choose a reason for cancelling.'));
  if (reason === 'Other' && !note.trim()) return Promise.reject(new Error('Add a note explaining why.'));
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    const s = t?.session;
    if (!s) throw new Error('This table has no open session.');
    if (s.cancelled) throw new Error('This game has already been cancelled.');
    if (elapsedMs(t, serverNow()) > CANCEL_WINDOW_MS) {
      throw new Error('This game has run for more than 5 minutes, so it can no longer be cancelled.');
    }
    const cancelled = { reason, note: note.trim(), byId: user.uid, byName: user.name, at: SERVER_TIME };
    tx.update('tables', tableId, s.ended
      ? { 'session.cancelled': cancelled, updatedAt: SERVER_TIME }
      : { 'session.ended': true, 'session.endedAt': SERVER_TIME, 'session.cancelled': cancelled, updatedAt: SERVER_TIME });
    return { tableName: t.name, hasItems: (s.items || []).length > 0 };
  });
}

/**
 * Move a live (not yet ended) session to a different table: the original start time, items, rounds and
 * booking length carry over untouched, so the bill keeps counting from when it first started — nothing
 * about the customer's tab resets. The source table frees immediately; the destination must be
 * Available. Each hop is recorded on the session (js/firestore.rules checks it's a genuine paired move,
 * not a session being discarded), so the eventual receipt can show where the game started.
 *
 * `at` uses the server-synced clock (serverNow()), not the usual SERVER_TIME placeholder: Firestore
 * doesn't allow a serverTimestamp() sentinel inside an array element, and `transfers` is one. This is
 * fine here because `at` is a display-only audit note — it never feeds the bill, which is driven purely
 * by session.startedAt/endedAt, still real server timestamps, untouched by the move.
 */
export function transferTable(fromTableId, toTableId, user) {
  if (fromTableId === toTableId) return Promise.reject(new Error('Choose a different table to transfer to.'));
  return db.transaction(async (tx) => {
    const from = await tx.get('tables', fromTableId);
    if (!from?.session) throw new Error('This table has no open session.');
    if (from.session.ended) throw new Error('This session has already been stopped; check it out instead of transferring it.');
    const to = await tx.get('tables', toTableId);
    if (!to) throw new Error('Table not found.');
    if (to.status !== 'available') throw new Error(`${to.name} already has an open session.`);
    const transfer = {
      fromTableId, fromTableName: from.name, at: serverNow(), byId: user.uid, byName: user.name,
    };
    tx.update('tables', fromTableId, {
      status: 'available', session: null, lastTransferToId: toTableId, updatedAt: SERVER_TIME,
    });
    tx.update('tables', toTableId, {
      status: 'in_use',
      session: { ...from.session, transfers: [...(from.session.transfers || []), transfer] },
      updatedAt: SERVER_TIME,
    });
    return { fromName: from.name, toName: to.name };
  });
}

/** Add/remove units of a product on a table's open bill (stock is checked, deducted at checkout). */
export function changeItem(tableId, productId, delta) {
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t?.session) throw new Error('This table has no open session.');
    const p = await tx.get('products', productId);
    const items = [...(t.session.items || [])];
    const idx = items.findIndex((i) => i.productId === productId);
    const qty = (idx >= 0 ? items[idx].qty : 0) + delta;
    if (!p && delta > 0) throw new Error('Product not found.');
    if (p && delta > 0 && qty > p.stock) {
      throw new Error(p.stock > 0 ? `Only ${p.stock} ${p.name} in stock.` : `${p.name} is out of stock.`);
    }
    if (qty <= 0) {
      if (idx >= 0) items.splice(idx, 1);
    } else {
      const line = { productId, name: p?.name ?? items[idx].name, category: p?.category ?? items[idx].category, price: p?.price ?? items[idx].price, qty };
      if (idx >= 0) items[idx] = line; else items.push(line);
    }
    tx.update('tables', tableId, { 'session.items': items, updatedAt: SERVER_TIME });
  });
}

export const PAYMENT_METHODS = ['cash', 'gcash', 'split'];

/**
 * QRPH reference: the cashier types the last 5 digits of the customer's QRPH reference number for
 * any payment with a QRPH part (QRPH or Split), so the owner can match it to the QRPH history.
 * Returns the 5 digits, or null when nothing was paid by QRPH.
 */
export function gcashRefFor(method, ref) {
  if (method !== 'gcash' && method !== 'split') return null;
  const digits = String(ref ?? '').replace(/\D/g, '');
  if (digits.length !== 5) throw new Error('Enter the last 5 digits of the QRPH reference number.');
  return digits;
}

/** Thrown when stopping the clock changed the amount due from what the cashier was looking at. */
export class TotalChangedError extends Error {
  constructor(total, durationMs) {
    super('The clock has stopped and the final total changed. Check the amount and complete again.');
    this.name = 'TotalChangedError';
    this.total = total;
    this.durationMs = durationMs;
  }
}

/**
 * Close the bill.
 * 1. If the clock is still running, stop it (server-stamped end time).
 * 2. In a transaction, re-read the session and bill exactly: fee from the stored start/end stamps.
 * method: 'cash' (optional tendered → change), 'gcash', or 'split' (cashPart in cash, rest QRPH).
 * expectedTotal: the total the cashier saw; if the final total differs, nothing is saved and
 * TotalChangedError tells the UI to show the final amount (the clock stays stopped).
 */
export async function completeCheckout(tableId, { method, tendered, cashPart, gcashRef, expectedTotal = null }, user) {
  if (!PAYMENT_METHODS.includes(method) && method !== 'none') throw new Error('Choose a payment method.');
  gcashRefFor(method, gcashRef); // check before the clock is stopped
  await endSession(tableId);

  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t?.session) throw new Error('This table has already been checked out.');
    const s = t.session;
    if (!s.ended || s.endedAt == null || s.startedAt == null) throw new Error('The session end time hasn’t been recorded yet. Try again.');
    const items = s.items || [];
    const products = await Promise.all(items.map((i) => tx.get('products', i.productId)));
    items.forEach((i, k) => {
      const p = products[k];
      if (!p) throw new Error(`${i.name} no longer exists in inventory.`);
      if (p.stock < i.qty) throw new Error(`Not enough ${i.name} in stock (${p.stock} left).`);
    });

    const durationMs = s.endedAt - s.startedAt;
    const cancelled = s.cancelled || null;
    // Billed on the time actually played (booked time never adds to it); a cancelled game has no table fee.
    const { billedMs, tableFee: fee } = billSession(s, durationMs); // the one authoritative bill calculation
    const lines = items.map((i) => ({ ...i, total: round2(i.price * i.qty) }));
    const productTotal = itemsTotal(items);
    const total = round2(fee + productTotal);
    if (expectedTotal != null && round2(expectedTotal) !== total) throw new TotalChangedError(total, durationMs);

    // Nothing to pay (a cancelled game with no items): no payment method is recorded.
    if (total === 0) method = 'none';
    else if (method === 'none') throw new Error('Choose a payment method.');

    let paid = null;
    let payments;
    if (method === 'none') {
      payments = { cash: 0, gcash: 0 };
    } else if (method === 'cash') {
      paid = tendered == null ? total : round2(tendered);
      if (paid < total) throw new Error('Cash tendered is less than the total.');
      payments = { cash: total, gcash: 0 };
    } else if (method === 'gcash') {
      payments = { cash: 0, gcash: total };
    } else {
      const cash = round2(Number(cashPart));
      if (!(cash > 0) || cash >= total) {
        throw new Error(`For a split payment, enter a cash amount between ₱0 and the ₱${total.toFixed(2)} total.`);
      }
      payments = { cash, gcash: round2(total - cash) };
    }

    items.forEach((i, k) => tx.update('products', i.productId, { stock: products[k].stock - i.qty, updatedAt: SERVER_TIME }));
    const id = db.newId('transactions');
    const record = {
      tableId, tableName: t.name, pricing: { ...PRICING },
      startedAt: s.startedAt, endedAt: s.endedAt, durationMs,
      plannedMs: plannedMs(s), billedMs, mode: plannedMs(s) ? 'timed' : 'open',
      rounds: s.rounds || 0,
      tableFee: fee, items: lines, productTotal, total, method, payments,
      tendered: paid, change: paid == null ? null : round2(paid - total),
      gcashRef: gcashRefFor(method, gcashRef),
      cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
      ...(cancelled ? {
        gameCancelled: true, cancelReason: cancelled.reason, cancelNote: cancelled.note || '',
        cancelledById: cancelled.byId, cancelledByName: cancelled.byName,
      } : {}),
      ...(s.transfers?.length ? { transfers: s.transfers } : {}),
    };
    tx.set('transactions', id, record);
    tx.update('tables', tableId, { status: 'available', session: null, lastTxId: id, updatedAt: SERVER_TIME });
    return { id, ...record, createdAt: serverNow() };
  });
}

/**
 * Ring up a walk-in sale: items only, no table, no timer, no table fee. The cart lives only in the
 * view until checkout — stock is checked and deducted here, in the same transaction as the sale,
 * exactly like a table checkout, so two terminals still can't oversell stock.
 */
export function completeQuickSale({ items, method, tendered, cashPart, gcashRef }, user) {
  if (!PAYMENT_METHODS.includes(method)) throw new Error('Choose a payment method.');
  if (!items || !items.length) throw new Error('Add at least one item to the sale.');
  const ref = gcashRefFor(method, gcashRef);

  return db.transaction(async (tx) => {
    const products = await Promise.all(items.map((i) => tx.get('products', i.productId)));
    items.forEach((i, k) => {
      const p = products[k];
      if (!p) throw new Error(`${i.name} no longer exists in inventory.`);
      if (p.stock < i.qty) throw new Error(`Not enough ${i.name} in stock (${p.stock} left).`);
    });

    const lines = items.map((i) => ({ ...i, total: round2(i.price * i.qty) }));
    const productTotal = itemsTotal(items);
    const total = productTotal;

    let paid = null;
    let payments;
    if (method === 'cash') {
      paid = tendered == null ? total : round2(tendered);
      if (paid < total) throw new Error('Cash tendered is less than the total.');
      payments = { cash: total, gcash: 0 };
    } else if (method === 'gcash') {
      payments = { cash: 0, gcash: total };
    } else {
      const cash = round2(Number(cashPart));
      if (!(cash > 0) || cash >= total) {
        throw new Error(`For a split payment, enter a cash amount between ₱0 and the ₱${total.toFixed(2)} total.`);
      }
      payments = { cash, gcash: round2(total - cash) };
    }

    items.forEach((i, k) => tx.update('products', i.productId, { stock: products[k].stock - i.qty, updatedAt: SERVER_TIME }));
    const id = db.newId('transactions');
    const record = {
      tableId: null, tableName: null, pricing: null,
      startedAt: null, endedAt: null, durationMs: null,
      plannedMs: null, billedMs: null, mode: null, rounds: 0,
      tableFee: 0, items: lines, productTotal, total, method, payments,
      tendered: paid, change: paid == null ? null : round2(paid - total),
      gcashRef: ref,
      cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
    };
    tx.set('transactions', id, record);
    return { id, ...record, createdAt: serverNow() };
  });
}

/* ---------- expenses ---------- */

export const EXPENSE_DESCRIPTION_MAX = 120;

/**
 * Log cash taken from the drawer: one or more { description, amount } lines, saved together.
 * Each is stamped with server time, so it lands on the shift that is actually on duty. Expenses can't
 * be edited afterwards; only the owner can remove a mistaken one (see firestore.rules).
 */
export function recordExpenses(lines, user) {
  const items = (lines || []).map((l) => ({ description: String(l.description || '').trim(), amount: round2(Number(l.amount)) }));
  if (!items.length) return Promise.reject(new Error('Add at least one expense.'));
  for (const i of items) {
    if (!i.description) return Promise.reject(new Error('Say what each expense was for.'));
    if (i.description.length > EXPENSE_DESCRIPTION_MAX) return Promise.reject(new Error(`Keep each description under ${EXPENSE_DESCRIPTION_MAX} characters.`));
    if (!Number.isFinite(i.amount) || i.amount <= 0) return Promise.reject(new Error('Enter an amount greater than zero.'));
  }
  return db.transaction(async (tx) => {
    for (const i of items) {
      tx.set('expenses', db.newId('expenses'), {
        description: i.description, amount: i.amount,
        cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
      });
    }
    return items.length;
  });
}

export const removeExpense = (id) => db.remove('expenses', id);

/* ---------- cash drawer PIN (Marimar Inn) ----------
 * The owner sets a PIN; a cashier types it to open the drawer outside a sale (e.g. to count cash).
 * Only a SHA-256 hash is stored (settings/cashDrawer.pinHash), never the PIN. A short numeric PIN isn't
 * strong security, it just stops the drawer being opened without the code the owner gave out.
 */

/** Digits only, including full-width digits some tablet keyboards type. */
export const normalizePin = (pin) => String(pin ?? '').normalize('NFKC').replace(/\D/g, '');

async function hashPin(pin) {
  if (!globalThis.crypto?.subtle) throw new Error('This device can’t check a PIN. Open the app in Chrome.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function setDrawerPin(pin) {
  const digits = normalizePin(pin);
  if (digits.length < 4) throw new Error('Use at least 4 digits.');
  await db.set('settings', 'cashDrawer', { pinHash: await hashPin(digits), updatedAt: SERVER_TIME }, { merge: true });
}

export async function verifyDrawerPin(pin) {
  const digits = normalizePin(pin);
  if (!digits) return false;
  const stored = (await db.get('settings', 'cashDrawer'))?.pinHash;
  return Boolean(stored) && (await hashPin(digits)) === stored;
}

/** Owner switch: one shift per business day (default), or split into Day and Night shifts. */
export const setTwoShifts = (on) =>
  db.set('settings', 'shifts', { twoShifts: !!on, updatedAt: SERVER_TIME }, { merge: true }).then(() => !!on);

/**
 * The hall's own QRPH "Scan to Pay" code, shown at checkout whenever QRPH or Split is chosen. It's
 * a static merchant QR (no amount encoded), the same as a printed one taped at the counter — any
 * QRPH-compatible banking or e-wallet app can scan it, the customer still enters the total themselves,
 * and the cashier still records the last 5 digits of the reference number for the audit trail.
 */
export const setGcashQr = (qrImage) =>
  db.set('settings', 'gcash', { qrImage, updatedAt: SERVER_TIME }, { merge: true });
export const removeGcashQr = () => setGcashQr(null);

/* ---------- tables (owner) ---------- */

export function addTable({ name, number }) {
  return db.add('tables', { name, number, status: 'available', session: null, light: false, updatedAt: SERVER_TIME });
}

export function updateTable(tableId, { name }) {
  return db.update('tables', tableId, { name, updatedAt: SERVER_TIME });
}

/* ---------- inventory (owner) ---------- */

export function addProduct({ name, category, price, stock, reorderLevel }) {
  return db.add('products', { name, category, price, stock, reorderLevel, createdAt: SERVER_TIME, updatedAt: SERVER_TIME });
}

export function updateProduct(productId, { name, category, price, reorderLevel }) {
  return db.update('products', productId, { name, category, price, reorderLevel, updatedAt: SERVER_TIME });
}

export function addStock(productId, qty, user) {
  return db.transaction(async (tx) => {
    const p = await tx.get('products', productId);
    if (!p) throw new Error('Product not found.');
    tx.update('products', productId, { stock: p.stock + qty, lastRestockedAt: SERVER_TIME, updatedAt: SERVER_TIME });
    tx.set('restocks', db.newId('restocks'), {
      productId, productName: p.name, qty, byId: user.uid, byName: user.name, createdAt: SERVER_TIME,
    });
    return p.stock + qty;
  });
}

/* ---------- cue sticks ---------- */
// A separate catalog from products: each cue stick is a unique physical item (not counted stock), so
// selling one just flips it from 'available' to 'sold' rather than decrementing a quantity.

export function addCueStick({ name, brand, weight, price, photo }) {
  return db.add('cueSticks', {
    name, brand, weight, price, photo: photo || null, status: 'available', createdAt: SERVER_TIME, updatedAt: SERVER_TIME,
  });
}

export function updateCueStick(cueStickId, { name, brand, weight, price, photo }) {
  return db.update('cueSticks', cueStickId, { name, brand, weight, price, photo: photo || null, updatedAt: SERVER_TIME });
}

/**
 * Ring up a cue stick sale: one or more specific cues, no table, no timer. Kept apart from Quick
 * Sale/products so it gets its own total in reports. Each cue can only be sold once — the transaction
 * re-checks every one is still 'available' before marking it 'sold', so two terminals can't sell the
 * same physical cue twice.
 */
export function completeCueStickSale({ items, method, tendered, cashPart, gcashRef }, user) {
  if (!PAYMENT_METHODS.includes(method)) throw new Error('Choose a payment method.');
  if (!items || !items.length) throw new Error('Add at least one cue stick to the sale.');
  const ref = gcashRefFor(method, gcashRef);

  return db.transaction(async (tx) => {
    const cues = await Promise.all(items.map((i) => tx.get('cueSticks', i.cueStickId)));
    cues.forEach((c, k) => {
      if (!c) throw new Error(`${items[k].name} no longer exists.`);
      if (c.status !== 'available') throw new Error(`${c.name} has already been sold.`);
    });

    const lines = items.map((i) => ({ ...i, qty: 1, total: round2(i.price) }));
    const total = round2(lines.reduce((s, l) => s + l.total, 0));

    let paid = null;
    let payments;
    if (method === 'cash') {
      paid = tendered == null ? total : round2(tendered);
      if (paid < total) throw new Error('Cash tendered is less than the total.');
      payments = { cash: total, gcash: 0 };
    } else if (method === 'gcash') {
      payments = { cash: 0, gcash: total };
    } else {
      const cash = round2(Number(cashPart));
      if (!(cash > 0) || cash >= total) {
        throw new Error(`For a split payment, enter a cash amount between ₱0 and the ₱${total.toFixed(2)} total.`);
      }
      payments = { cash, gcash: round2(total - cash) };
    }

    const id = db.newId('transactions');
    cues.forEach((c, k) => tx.update('cueSticks', items[k].cueStickId, {
      status: 'sold', soldAt: SERVER_TIME, soldTxId: id, soldByName: user.name, updatedAt: SERVER_TIME,
    }));
    const record = {
      tableId: null, tableName: null, pricing: null,
      startedAt: null, endedAt: null, durationMs: null,
      plannedMs: null, billedMs: null, mode: null, rounds: 0,
      saleType: 'cue-stick',
      tableFee: 0, productTotal: 0, cueStickTotal: total, items: lines, total, method, payments,
      tendered: paid, change: paid == null ? null : round2(paid - total),
      gcashRef: ref,
      cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
    };
    tx.set('transactions', id, record);
    return { id, ...record, createdAt: serverNow() };
  });
}

/* ---------- staff & accounts ---------- */

export async function setupOwner({ name, email, password }) {
  const uid = await auth.createOwner(email, password);
  await db.transaction(async (tx) => {
    if (await tx.get('meta', 'setup')) throw new Error('This hall already has an owner. Sign in instead.');
    tx.set('users', uid, { name, email, role: 'owner', active: true, online: true, lastSeen: SERVER_TIME, createdAt: SERVER_TIME });
    tx.set('meta', 'setup', { ownerId: uid, createdAt: SERVER_TIME });
  });
}

export async function createStaff({ name, email, password, role }) {
  const uid = await auth.createAccount(email, password);
  await db.set('users', uid, { name, email, role, active: true, online: false, lastSeen: 0, createdAt: SERVER_TIME });
  return uid;
}

export const updateStaff = (uid, patch) => db.update('users', uid, patch);

export const setPresence = (uid, online) => db.update('users', uid, { online, lastSeen: SERVER_TIME });

/** Measure server − device clock offset (display only). */
export const syncClock = (uid) => db.syncClock(uid);
