// Business operations. Every state change that touches more than one field or document runs in a
// transaction so two terminals can't double-bill a table or oversell stock.
//
// Time integrity: session start/end and sale times are written as SERVER_TIME (the database server's
// clock), never the device clock. The table fee is computed only from those stored stamps, and
// firestore.rules re-computes and verifies it, so changing a till's clock can't change a bill.
import { db, auth } from './db.js';
import {
  elapsedMs, tableFee, round2, itemsTotal, canVoidTableFee, VOID_REASONS, PRICING,
  billableMs, plannedMs, BOOKING_STEP_MS,
} from './billing.js';
import { SERVER_TIME, serverNow } from './clock.js';

/* ---------- table sessions ---------- */

const validBooking = (ms) => Number.isInteger(ms) && ms > 0 && ms % BOOKING_STEP_MS === 0;

/**
 * Open a table. booking = 0 → open time (runs until stopped, billed on actual play).
 * booking > 0 → the customer books that many milliseconds; those hours are the minimum charge and
 * any extra play is billed on top. Bookings are whole 15-minute steps.
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

/** Per-session game counter (a running count of racks played). */
export function logRound(tableId, delta = 1) {
  return db.transaction(async (tx) => {
    const t = await tx.get('tables', tableId);
    if (!t?.session) throw new Error('This table has no open session.');
    const rounds = Math.max(0, (t.session.rounds || 0) + delta);
    tx.update('tables', tableId, { 'session.rounds': rounds, updatedAt: SERVER_TIME });
    return rounds;
  });
}

/** Physical table light. Lives on the table, not the session, so it persists between games. */
export const setLight = (tableId, on) => db.update('tables', tableId, { light: on, updatedAt: SERVER_TIME });

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
 * method: 'cash' (optional tendered → change), 'gcash', or 'split' (cashPart in cash, rest GCash).
 * expectedTotal: the total the cashier saw; if the final total differs, nothing is saved and
 * TotalChangedError tells the UI to show the final amount (the clock stays stopped).
 */
export async function completeCheckout(tableId, { method, tendered, cashPart, expectedTotal = null }, user) {
  if (!PAYMENT_METHODS.includes(method)) throw new Error('Choose a payment method.');
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
    const billedMs = billableMs(s, durationMs); // booked hours are the minimum charge
    const fee = tableFee(billedMs);
    const lines = items.map((i) => ({ ...i, total: round2(i.price * i.qty) }));
    const productTotal = itemsTotal(items);
    const total = round2(fee + productTotal);
    if (expectedTotal != null && round2(expectedTotal) !== total) throw new TotalChangedError(total, durationMs);

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
      tableId, tableName: t.name, pricing: { ...PRICING },
      startedAt: s.startedAt, endedAt: s.endedAt, durationMs,
      plannedMs: plannedMs(s), billedMs, mode: plannedMs(s) ? 'timed' : 'open',
      rounds: s.rounds || 0,
      tableFee: fee, items: lines, productTotal, total, method, payments,
      tendered: paid, change: paid == null ? null : round2(paid - total),
      cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
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
export function completeQuickSale({ items, method, tendered, cashPart }, user) {
  if (!PAYMENT_METHODS.includes(method)) throw new Error('Choose a payment method.');
  if (!items || !items.length) throw new Error('Add at least one item to the sale.');

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
      cashierId: user.uid, cashierName: user.name, createdAt: SERVER_TIME,
    };
    tx.set('transactions', id, record);
    return { id, ...record, createdAt: serverNow() };
  });
}

/**
 * Waive the table fee on a completed sale, once, if the table was used for
 * billing.VOID_ELIGIBLE_DURATION_MS (5 minutes) or less — e.g. the customer decided not to play
 * after all. Items on the sale are never touched: no stock is returned, and their charge stays owed.
 * The waived amount is refunded through whichever payment channel (cash/GCash) covers it; for a
 * split payment the caller picks the channel (refundMethod), otherwise it's inferred.
 */
export function voidTableFee(txId, { reason, note = '', refundMethod } = {}, user) {
  if (!VOID_REASONS.includes(reason)) return Promise.reject(new Error('Choose a reason for the void.'));
  if (reason === 'Other' && !note.trim()) return Promise.reject(new Error('Add a note explaining the void.'));
  return db.transaction(async (tx) => {
    const sale = await tx.get('transactions', txId);
    if (!sale) throw new Error('Transaction not found.');
    if (sale.tableFeeVoided) throw new Error('The table fee for this sale has already been voided.');
    if (user.role !== 'owner' && sale.cashierId !== user.uid) {
      throw new Error('Only the cashier who completed this sale or the owner can void the table fee.');
    }
    if (!canVoidTableFee(sale, user)) {
      throw new Error('The table was used for more than 5 minutes, so the table fee can no longer be voided.');
    }

    const refund = sale.tableFee;
    const payments = { cash: sale.payments?.cash || 0, gcash: sale.payments?.gcash || 0 };
    const method = refundMethod || (payments.cash >= refund ? 'cash' : 'gcash');
    if (method !== 'cash' && method !== 'gcash') throw new Error('Choose how the refund was given.');
    if (round2(payments[method]) < round2(refund)) {
      throw new Error(`Not enough was paid via ${method === 'cash' ? 'cash' : 'GCash'} to refund ₱${refund.toFixed(2)} that way.`);
    }
    payments[method] = round2(payments[method] - refund);

    tx.update('transactions', txId, {
      tableFeeVoided: true, tableFeeVoidedAt: SERVER_TIME, tableFeeVoidedById: user.uid, tableFeeVoidedByName: user.name,
      voidReason: reason, voidNote: note.trim(),
      originalTableFee: sale.tableFee, originalTotal: sale.total,
      tableFee: 0, total: round2(sale.productTotal || 0),
      payments, refundAmount: round2(refund), refundMethod: method,
    });
    return { tableName: sale.tableName, refund: round2(refund), method };
  });
}

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
