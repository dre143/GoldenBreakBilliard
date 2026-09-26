// Security-rule tests for prepaid Set Hours bookings: paying a table fee without ending the session,
// Add time's Pay Now / Pay Later, the balance-aware final checkout, and the 5-minute cancel refund.
// Run with: npm run test:rules  (needs the Firestore emulator, and firebase-tools needs a JDK 21+ runtime).
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { tableFee } from '../../js/billing.js';

const MIN = 60_000;
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-goldenbreak-prepay',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });

const as = (uid) => env.authenticatedContext(uid).firestore();
const ts = (ms) => Timestamp.fromMillis(ms);

async function seed(docs) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    for (const [path, data] of Object.entries(docs)) await setDoc(doc(fs, path), data);
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed({
    'users/joy': { name: 'Joy', role: 'cashier', active: true },
    'users/bea': { name: 'Bea', role: 'cashier', active: true },
  });
});

// A running (not ended) Set Hours session, optionally already prepaid through `paidMs`.
const bookedTable = (startedMs, plannedMs, prepaid = null) => ({
  name: 'Table 01', number: 1, status: 'in_use', light: false,
  session: {
    startedAt: ts(startedMs), ended: false, endedAt: null, plannedMs, items: [], rounds: 0,
    openedBy: 'joy', openedByName: 'Joy', ...(prepaid ? { prepaid } : {}),
  },
});

const prepayTx = ({ tableId = 't1', startedMs, paidFromMs, paidToMs, fee, cashier = 'joy', createdAt = serverTimestamp() }) => ({
  tableId, tableName: 'Table 01', pricing: null, kind: 'prepay',
  startedAt: ts(startedMs), endedAt: null, durationMs: null,
  plannedMs: paidToMs, billedMs: null, mode: 'timed',
  paidFromMs, paidToMs, tableFee: fee, items: [], productTotal: 0, total: fee,
  method: 'cash', payments: { cash: fee, gcash: 0 }, tendered: fee, change: 0,
  cashierId: cashier, cashierName: 'Joy', createdAt,
});

function payBooking(fs, { tableId = 't1', startedMs, paidFromMs, paidToMs, fee, txId = 'p1', cashier = 'joy' }) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'transactions', txId), prepayTx({ tableId, startedMs, paidFromMs, paidToMs, fee, cashier }));
  batch.update(doc(fs, 'tables', tableId), {
    'session.prepaid': { paidMs: paidToMs, lastTxId: txId, refunded: false },
    updatedAt: serverTimestamp(),
  });
  return batch.commit();
}

/* ---------------- paying a running booking ---------------- */

test('pay booking now: the exact fee for the booked length is accepted, wrong amounts are not', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN) });
  const joy = as('joy');
  const fee = tableFee(60 * MIN);
  await assertFails(payBooking(joy, { startedMs, paidFromMs: 0, paidToMs: 60 * MIN, fee: fee - 1 }));
  await assertFails(payBooking(joy, { startedMs, paidFromMs: 0, paidToMs: 60 * MIN, fee: fee + 50 }));
  await assertSucceeds(payBooking(joy, { startedMs, paidFromMs: 0, paidToMs: 60 * MIN, fee }));
});

test('paying does not stop the session or free the table', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN) });
  await assertSucceeds(payBooking(as('joy'), { startedMs, paidFromMs: 0, paidToMs: 60 * MIN, fee: tableFee(60 * MIN) }));
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'tables/t1'));
    data = snap.data();
  });
  assert.equal(data.status, 'in_use');
  assert.equal(data.session.ended, false);
  assert.equal(data.session.prepaid.paidMs, 60 * MIN);
});

test('a booking already fully paid cannot be paid again', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  await assertFails(payBooking(as('joy'), { startedMs, paidFromMs: 60 * MIN, paidToMs: 60 * MIN, fee: 1, txId: 'p2' }));
});

test('a cashier cannot fake a prepaid marker with no linked transaction', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.prepaid': { paidMs: 60 * MIN, lastTxId: 'ghost', refunded: false }, updatedAt: serverTimestamp(),
  }));
});

test('open time cannot be paid in advance (no plannedMs to pay for)', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 0) });
  await assertFails(payBooking(as('joy'), { startedMs, paidFromMs: 0, paidToMs: 0, fee: 200 }));
});

/* ---------------- Add time: Pay Now vs Pay Later ---------------- */

test('Add time, Pay Later: plannedMs grows, prepaid.paidMs is untouched (a balance opens up)', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), { 'session.plannedMs': 90 * MIN, updatedAt: serverTimestamp() }));
});

test('Add time, Pay Now: the extra fee (not the whole new booking) is charged, and paidMs catches up', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  const joy = as('joy');
  const extra = tableFee(90 * MIN) - tableFee(60 * MIN);
  const batch = writeBatch(joy);
  batch.set(doc(joy, 'transactions/p2'), prepayTx({ startedMs, paidFromMs: 60 * MIN, paidToMs: 90 * MIN, fee: extra }));
  batch.update(doc(joy, 'tables/t1'), {
    'session.plannedMs': 90 * MIN,
    'session.prepaid': { paidMs: 90 * MIN, lastTxId: 'p2', refunded: false },
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});

test('Add time, Pay Now: charging the full new-booking fee (double-charging the paid part) is rejected', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  const joy = as('joy');
  const fullFee = tableFee(90 * MIN); // wrong: should be just the extra 100, not the whole 300
  const batch = writeBatch(joy);
  batch.set(doc(joy, 'transactions/p2'), prepayTx({ startedMs, paidFromMs: 60 * MIN, paidToMs: 90 * MIN, fee: fullFee }));
  batch.update(doc(joy, 'tables/t1'), {
    'session.plannedMs': 90 * MIN,
    'session.prepaid': { paidMs: 90 * MIN, lastTxId: 'p2', refunded: false },
    updatedAt: serverTimestamp(),
  });
  await assertFails(batch.commit());
});

/* ---------------- final checkout on a prepaid booking ---------------- */

function checkout(fs, { startedMs, endedMs, durationMs, plannedMs, prepaidThroughMs, fee, txId = 'sale1' }) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'transactions', txId), {
    tableId: 't1', tableName: 'Table 01', pricing: null,
    startedAt: ts(startedMs), endedAt: ts(endedMs), durationMs, plannedMs,
    billedMs: durationMs > prepaidThroughMs ? durationMs : prepaidThroughMs, mode: 'timed', rounds: 0,
    tableFee: fee, items: [], productTotal: 0, total: fee,
    method: fee > 0 ? 'cash' : 'none', payments: { cash: fee, gcash: 0 }, tendered: fee > 0 ? fee : null, change: fee > 0 ? 0 : null,
    cashierId: 'joy', cashierName: 'Joy', createdAt: serverTimestamp(),
  });
  batch.update(doc(fs, 'tables', 't1'), { status: 'available', session: null, lastTxId: txId, updatedAt: serverTimestamp() });
  return batch.commit();
}

test('checkout on a fully prepaid booking, ended early: the table fee due is ₱0 (no refund for unused time)', async () => {
  const startedMs = Date.now() - 90 * MIN;
  const endedMs = startedMs + 10 * MIN; // left after 10 minutes of a paid 60-minute booking
  await seed({
    'tables/t1': {
      ...bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }),
      status: 'in_use', session: {
        startedAt: ts(startedMs), ended: true, endedAt: ts(endedMs), plannedMs: 60 * MIN, items: [], rounds: 0,
        openedBy: 'joy', openedByName: 'Joy', prepaid: { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false },
      },
    },
  });
  const joy = as('joy');
  await assertFails(checkout(joy, { startedMs, endedMs, durationMs: 10 * MIN, plannedMs: 60 * MIN, prepaidThroughMs: 60 * MIN, fee: 1 }));
  await assertSucceeds(checkout(joy, { startedMs, endedMs, durationMs: 10 * MIN, plannedMs: 60 * MIN, prepaidThroughMs: 60 * MIN, fee: 0 }));
});

test('checkout on a partially prepaid booking that ran to term: only the unpaid balance is charged', async () => {
  const startedMs = Date.now() - 100 * MIN;
  const endedMs = startedMs + 90 * MIN; // ran the full extended booking
  await seed({
    'tables/t1': {
      name: 'Table 01', number: 1, status: 'in_use', light: false,
      session: {
        startedAt: ts(startedMs), ended: true, endedAt: ts(endedMs), plannedMs: 90 * MIN, items: [], rounds: 0,
        openedBy: 'joy', openedByName: 'Joy', prepaid: { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false },
      },
    },
  });
  const joy = as('joy');
  const balance = tableFee(90 * MIN) - tableFee(60 * MIN);
  await assertFails(checkout(joy, { startedMs, endedMs, durationMs: 90 * MIN, plannedMs: 90 * MIN, prepaidThroughMs: 60 * MIN, fee: tableFee(90 * MIN) }));
  await assertSucceeds(checkout(joy, { startedMs, endedMs, durationMs: 90 * MIN, plannedMs: 90 * MIN, prepaidThroughMs: 60 * MIN, fee: balance }));
});

/* ---------------- cancel within 5 minutes: refund ---------------- */

function cancelAndRefund(fs, { startedMs, paidMs: paid, fee, refundTxId = 'r1', cancelledAt = serverTimestamp() }) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'transactions', refundTxId), {
    tableId: 't1', tableName: 'Table 01', pricing: null, kind: 'refund', refundOfTxId: 'p0',
    startedAt: ts(startedMs), endedAt: serverTimestamp(), durationMs: 2 * MIN,
    plannedMs: 60 * MIN, billedMs: null, mode: 'timed',
    tableFee: -fee, items: [], productTotal: 0, total: -fee,
    method: 'cash', payments: { cash: -fee, gcash: 0 }, tendered: null, change: null,
    cashierId: 'joy', cashierName: 'Joy', createdAt: serverTimestamp(),
    gameCancelled: true, cancelReason: 'Customer decided not to play', cancelNote: '',
    cancelledById: 'joy', cancelledByName: 'Joy',
  });
  batch.update(doc(fs, 'tables', 't1'), {
    'session.ended': true, 'session.endedAt': cancelledAt,
    'session.cancelled': { reason: 'Customer decided not to play', note: '', byId: 'joy', byName: 'Joy', at: cancelledAt },
    'session.prepaid': { paidMs: paid, lastTxId: 'p0', refunded: true, refundTxId },
    updatedAt: serverTimestamp(),
  });
  return batch.commit();
}

test('cancel within 5 minutes on a prepaid booking: the exact prepaid amount is refunded, once', async () => {
  const startedMs = Date.now() - 2 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  const joy = as('joy');
  await assertFails(cancelAndRefund(joy, { startedMs, paidMs: 60 * MIN, fee: tableFee(60 * MIN) - 1 }));
  await assertSucceeds(cancelAndRefund(joy, { startedMs, paidMs: 60 * MIN, fee: tableFee(60 * MIN) }));
});

test('cancel within 5 minutes on an UNPAID booking still needs no refund transaction (unchanged behavior)', async () => {
  const startedMs = Date.now() - 2 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN) });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.ended': true, 'session.endedAt': serverTimestamp(),
    'session.cancelled': { reason: 'Customer decided not to play', note: '', byId: 'joy', byName: 'Joy', at: serverTimestamp() },
    updatedAt: serverTimestamp(),
  }));
});

test('a cashier cannot mark a booking refunded without a matching refund transaction', async () => {
  const startedMs = Date.now() - 2 * MIN;
  await seed({ 'tables/t1': bookedTable(startedMs, 60 * MIN, { paidMs: 60 * MIN, lastTxId: 'p0', refunded: false }) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.ended': true, 'session.endedAt': serverTimestamp(),
    'session.cancelled': { reason: 'Customer decided not to play', note: '', byId: 'joy', byName: 'Joy', at: serverTimestamp() },
    'session.prepaid': { paidMs: 60 * MIN, lastTxId: 'p0', refunded: true, refundTxId: 'ghost' },
    updatedAt: serverTimestamp(),
  }));
});

/* ---------------- unified Complete Transaction: table fee + items together, session stays running ---------------- */

// A running Set Hours session with items already on the bill.
const bookedTableWithItems = (startedMs, plannedMs, items) => ({
  name: 'Table 01', number: 1, status: 'in_use', light: false,
  session: {
    startedAt: ts(startedMs), ended: false, endedAt: null, plannedMs, items, rounds: 0,
    openedBy: 'joy', openedByName: 'Joy',
  },
});

function payBookingWithItems(fs, { tableId = 't1', startedMs, paidToMs, fee, productTotal, txId = 'p1', cashier = 'joy' }) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'transactions', txId), {
    tableId, tableName: 'Table 01', pricing: null, kind: 'prepay',
    startedAt: ts(startedMs), endedAt: null, durationMs: null,
    plannedMs: paidToMs, billedMs: null, mode: 'timed',
    paidFromMs: 0, paidToMs, tableFee: fee,
    items: [{ productId: 'water', name: 'Water', category: 'Beverages', price: 20, qty: 2, total: 40 }],
    productTotal, total: fee + productTotal,
    method: 'cash', payments: { cash: fee + productTotal, gcash: 0 }, tendered: fee + productTotal, change: 0,
    cashierId: cashier, cashierName: 'Joy', createdAt: serverTimestamp(),
  });
  batch.update(doc(fs, 'tables', tableId), {
    'session.prepaid': { paidMs: paidToMs, lastTxId: txId, refunded: false },
    'session.items': [],
    updatedAt: serverTimestamp(),
  });
  return batch.commit();
}

test('Complete Transaction on a running booking can settle the table fee and items together, clearing the bill, without ending', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({
    'tables/t1': bookedTableWithItems(startedMs, 60 * MIN, [{ productId: 'water', name: 'Water', category: 'Beverages', price: 20, qty: 2 }]),
  });
  const joy = as('joy');
  const fee = tableFee(60 * MIN);
  await assertSucceeds(payBookingWithItems(joy, { startedMs, paidToMs: 60 * MIN, fee, productTotal: 40 }));
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), 'tables/t1'))).data();
  });
  assert.equal(data.status, 'in_use');
  assert.equal(data.session.ended, false);
  assert.deepEqual(data.session.items, []); // settled and cleared, not carried forward
});

test('a payment that charges for items but leaves them on the table\'s bill is rejected (no double-charging later)', async () => {
  const startedMs = Date.now() - 5 * MIN;
  await seed({
    'tables/t1': bookedTableWithItems(startedMs, 60 * MIN, [{ productId: 'water', name: 'Water', category: 'Beverages', price: 20, qty: 2 }]),
  });
  const joy = as('joy');
  const fee = tableFee(60 * MIN);
  const batch = writeBatch(joy);
  batch.set(doc(joy, 'transactions/p1'), {
    tableId: 't1', tableName: 'Table 01', pricing: null, kind: 'prepay',
    startedAt: ts(startedMs), endedAt: null, durationMs: null,
    plannedMs: 60 * MIN, billedMs: null, mode: 'timed',
    paidFromMs: 0, paidToMs: 60 * MIN, tableFee: fee,
    items: [{ productId: 'water', name: 'Water', category: 'Beverages', price: 20, qty: 2, total: 40 }],
    productTotal: 40, total: fee + 40,
    method: 'cash', payments: { cash: fee + 40, gcash: 0 }, tendered: fee + 40, change: 0,
    cashierId: 'joy', cashierName: 'Joy', createdAt: serverTimestamp(),
  });
  // Items are charged for in the sale but NOT cleared from the table — this must be rejected.
  batch.update(doc(joy, 'tables/t1'), {
    'session.prepaid': { paidMs: 60 * MIN, lastTxId: 'p1', refunded: false },
    updatedAt: serverTimestamp(),
  });
  await assertFails(batch.commit());
});
