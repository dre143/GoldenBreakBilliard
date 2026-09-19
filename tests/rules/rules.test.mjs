// Security-rule tests against the Firestore emulator:  npm run test:rules
// Each "attack" is a write a cashier could send straight to Firestore, bypassing the app.
import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, deleteDoc, getDoc, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { tableFee, PRICING } from '../../js/billing.js';

const MIN = 60_000;
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-goldenbreak',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });

const as = (uid) => env.authenticatedContext(uid).firestore();
const ts = (ms) => Timestamp.fromMillis(ms);

/** Seed documents with rules disabled. */
async function seed(docs) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    for (const [path, data] of Object.entries(docs)) await setDoc(doc(fs, path), data);
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed({
    'users/owner': { name: 'Marco', role: 'owner', active: true },
    'users/joy': { name: 'Joy', role: 'cashier', active: true },
    'users/bea': { name: 'Bea', role: 'cashier', active: true },
    'products/beer': { name: 'Beer', price: 85, stock: 10, reorderLevel: 5 },
  });
});

const freeTable = { name: 'Table 01', number: 1, status: 'available', session: null, light: false };
const runningTable = (startedMs, plannedMs = 0) => ({
  ...freeTable,
  status: 'in_use',
  session: { startedAt: ts(startedMs), ended: false, endedAt: null, plannedMs, items: [], rounds: 0, openedBy: 'joy', openedByName: 'Joy' },
});
const endedTable = (startedMs, endedMs, plannedMs = 0) => ({
  ...runningTable(startedMs, plannedMs),
  session: { ...runningTable(startedMs, plannedMs).session, ended: true, endedAt: ts(endedMs) },
});
const newSession = (plannedMs = 0) => ({
  startedAt: serverTimestamp(), ended: false, endedAt: null, plannedMs, items: [], rounds: 0, openedBy: 'joy', openedByName: 'Joy',
});

/* ---------------- sessions ---------------- */

test('start: open time with a server-stamped start is allowed', async () => {
  await seed({ 'tables/t1': freeTable });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), { status: 'in_use', session: newSession(0), updatedAt: serverTimestamp() }));
});

test('start: set hours in 15-minute steps is allowed; odd lengths are rejected', async () => {
  await seed({ 'tables/t1': freeTable, 'tables/t2': freeTable });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { status: 'in_use', session: newSession(100 * MIN), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { status: 'in_use', session: newSession(-60 * MIN), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t2'), { status: 'in_use', session: newSession(120 * MIN), updatedAt: serverTimestamp() }));
});

test('start: backdated or future start time is rejected', async () => {
  await seed({ 'tables/t1': freeTable });
  for (const fake of [Date.now() + 30 * MIN, Date.now() - 30 * MIN]) {
    await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), {
      status: 'in_use', session: { ...newSession(0), startedAt: ts(fake) }, updatedAt: serverTimestamp(),
    }));
  }
});

test('end: server-stamped end is allowed', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 70 * MIN) });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.ended': true, 'session.endedAt': serverTimestamp(), updatedAt: serverTimestamp(),
  }));
});

test('end: backdated end time (to cut the bill) is rejected', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 70 * MIN) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.ended': true, 'session.endedAt': ts(Date.now() - 20 * MIN), updatedAt: serverTimestamp(),
  }));
});

test('session start time can never be edited (e.g. moved later to shorten play)', async () => {
  const started = Date.now() - 70 * MIN;
  await seed({ 'tables/t1': runningTable(started), 'tables/t2': endedTable(started, Date.now() - MIN) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { 'session.startedAt': ts(started + 30 * MIN), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('owner'), 'tables/t2'), { 'session.startedAt': ts(started + 30 * MIN), updatedAt: serverTimestamp() }));
});

test('an ended clock can’t be restarted or re-ended later', async () => {
  const started = Date.now() - 90 * MIN;
  await seed({ 'tables/t1': endedTable(started, started + 61 * MIN) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { 'session.ended': false, 'session.endedAt': null, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { 'session.endedAt': serverTimestamp(), updatedAt: serverTimestamp() }));
});

test('items and rounds can be edited on an open session', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 10 * MIN) });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), {
    'session.items': [{ productId: 'beer', name: 'Beer', price: 85, qty: 2 }], 'session.rounds': 1, updatedAt: serverTimestamp(),
  }));
});

test('a table can’t be freed without recording a sale', async () => {
  const started = Date.now() - 80 * MIN;
  await seed({ 'tables/t1': endedTable(started, started + 76 * MIN) });
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { status: 'available', session: null, updatedAt: serverTimestamp() }));
});

test('light toggle is open to staff; renaming is owner-only', async () => {
  await seed({ 'tables/t1': freeTable });
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), { light: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), { name: 'VIP', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as('owner'), 'tables/t1'), { name: 'VIP', updatedAt: serverTimestamp() }));
});

/* ---------------- checkout: fee verified from server stamps ---------------- */

function checkout(fs, { durationMs, startedMs, endedMs, fee, plannedMs = 0, billedMs = Math.max(durationMs, plannedMs), createdAt = serverTimestamp(), txId = 'sale1', cashier = 'joy', extra = {} }) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'transactions', txId), {
    tableId: 't1', tableName: 'Table 01', pricing: { ...PRICING },
    startedAt: ts(startedMs), endedAt: ts(endedMs), durationMs, plannedMs, billedMs, mode: plannedMs ? 'timed' : 'open',
    rounds: 0, tableFee: fee, items: [], productTotal: 0, total: fee,
    method: 'cash', payments: { cash: fee, gcash: 0 }, tendered: fee, change: 0,
    cashierId: cashier, cashierName: 'Joy', createdAt, ...extra,
  });
  batch.update(doc(fs, 'tables', 't1'), { status: 'available', session: null, lastTxId: txId, updatedAt: serverTimestamp() });
  return batch.commit();
}

const cases = [
  ['1 hour', 60 * MIN, 200],
  ['1 hour + 1 ms', 60 * MIN + 1, 250],
  ['1 hour 15 minutes', 75 * MIN, 250],
  ['1 hour 16 minutes', 76 * MIN, 300],
  ['2 hours 1 minute', 121 * MIN, 450],
];
for (const [label, durationMs, fee] of cases) {
  test(`checkout ${label}: ₱${fee} accepted, anything else rejected`, async () => {
    const startedMs = Date.now() - durationMs - 5 * MIN;
    const endedMs = startedMs + durationMs;
    assert(tableFee(durationMs) === fee, 'app pricing and test expectation agree');
    await seed({ 'tables/t1': endedTable(startedMs, endedMs) });
    const joy = as('joy');
    await assertFails(checkout(joy, { durationMs, startedMs, endedMs, fee: fee - 50 }));
    await assertFails(checkout(joy, { durationMs, startedMs, endedMs, fee: fee + 50 }));
    await assertSucceeds(checkout(joy, { durationMs, startedMs, endedMs, fee }));
  });
}

test('checkout: lying about the duration or the stamps is rejected', async () => {
  const startedMs = Date.now() - 100 * MIN;
  const endedMs = startedMs + 76 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs) });
  const joy = as('joy');
  // Claim a 60-minute session to pay ₱200.
  await assertFails(checkout(joy, { durationMs: 60 * MIN, startedMs, endedMs, fee: 200 }));
  await assertFails(checkout(joy, { durationMs: 60 * MIN, startedMs: startedMs + 16 * MIN, endedMs, fee: 200 }));
  await assertFails(checkout(joy, { durationMs: 60 * MIN, startedMs, endedMs: endedMs - 16 * MIN, fee: 200 }));
});

test('checkout: backdated sale time is rejected', async () => {
  const startedMs = Date.now() - 100 * MIN;
  const endedMs = startedMs + 76 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs) });
  await assertFails(checkout(as('joy'), { durationMs: 76 * MIN, startedMs, endedMs, fee: 300, createdAt: ts(Date.now() - 60 * MIN) }));
});

test('checkout: a still-running clock can’t be billed (server must stop it first)', async () => {
  const startedMs = Date.now() - 76 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs) });
  await assertFails(checkout(as('joy'), { durationMs: 76 * MIN, startedMs, endedMs: startedMs + 76 * MIN, fee: 300 }));
});

test('checkout: cashier can’t record a sale under someone else’s name', async () => {
  const startedMs = Date.now() - 100 * MIN;
  const endedMs = startedMs + 76 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs) });
  await assertFails(checkout(as('joy'), { durationMs: 76 * MIN, startedMs, endedMs, fee: 300, cashier: 'bea' }));
});

/* ---------------- quick sale (walk-in, no table) ---------------- */

function quickSale(fs, { productTotal = 170, fee = 0, total = productTotal, cashier = 'joy', createdAt = serverTimestamp(), txId = 'qs1', extra = {} }) {
  return setDoc(doc(fs, 'transactions', txId), {
    tableId: null, tableName: null, pricing: null,
    startedAt: null, endedAt: null, durationMs: null,
    plannedMs: null, billedMs: null, mode: null, rounds: 0,
    tableFee: fee, items: [{ productId: 'beer', name: 'Beer', price: 85, qty: 2, total: 170 }],
    productTotal, total, method: 'cash', payments: { cash: total, gcash: 0 }, tendered: total, change: 0,
    cashierId: cashier, cashierName: 'Joy', createdAt, ...extra,
  });
}

test('quick sale: a walk-in item sale with no table fee is allowed', async () => {
  await assertSucceeds(quickSale(as('joy'), {}));
});

test('quick sale: a fabricated table fee is rejected — walk-in sales never carry one', async () => {
  await assertFails(quickSale(as('joy'), { fee: 200, total: 370 }));
});

test('quick sale: total must equal the product subtotal exactly', async () => {
  await assertFails(quickSale(as('joy'), { total: 200 }));
});

test('quick sale: cashier can’t record it under someone else’s name', async () => {
  await assertFails(quickSale(as('joy'), { cashier: 'bea' }));
});

test('quick sale: backdated sale time is rejected, same as a table sale', async () => {
  await assertFails(quickSale(as('joy'), { createdAt: ts(Date.now() - 60 * MIN) }));
});

/* ---------------- booked hours (Set Hours) ---------------- */

test('booked 2h, stopped after 45 min: ₱400 (booking is the minimum); ₱200 rejected', async () => {
  const startedMs = Date.now() - 50 * MIN;
  const endedMs = startedMs + 45 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 120 * MIN) });
  const joy = as('joy');
  // Try to bill actual time only (ignore the booking).
  await assertFails(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 200, plannedMs: 120 * MIN, billedMs: 45 * MIN }));
  // Try to claim a smaller booking than the session had.
  await assertFails(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 200, plannedMs: 0 }));
  await assertSucceeds(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN }));
});

test('booked 2h, played 2h 1min: overtime billed → ₱450; ₱400 rejected', async () => {
  const startedMs = Date.now() - 130 * MIN;
  const endedMs = startedMs + 121 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 120 * MIN) });
  const joy = as('joy');
  await assertFails(checkout(joy, { durationMs: 121 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN, billedMs: 120 * MIN }));
  await assertSucceeds(checkout(joy, { durationMs: 121 * MIN, startedMs, endedMs, fee: 450, plannedMs: 120 * MIN }));
});

test('booked time can be extended but never cut', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 30 * MIN, 120 * MIN) });
  const joy = as('joy');
  await assertFails(updateDoc(doc(joy, 'tables/t1'), { 'session.plannedMs': 60 * MIN, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(joy, 'tables/t1'), { 'session.plannedMs': 0, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(joy, 'tables/t1'), { 'session.plannedMs': 130 * MIN, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(joy, 'tables/t1'), { 'session.plannedMs': 180 * MIN, updatedAt: serverTimestamp() }));
});

/* ---------------- cancel game (first 5 minutes, before payment) ----------------
 * The cashier cancels on the table itself: the table fee becomes ₱0, the running clock stops in the
 * same write, and the window is measured on server time. Items stay on the bill. A completed sale
 * can never be changed afterwards. */

const cancelled = (uid = 'joy', extra = {}) => ({
  reason: 'Customer decided not to play', note: '', byId: uid, byName: uid, at: serverTimestamp(), ...extra,
});
const cancelRunning = (fs, extra = {}) => updateDoc(doc(fs, 'tables/t1'), {
  'session.ended': true, 'session.endedAt': serverTimestamp(), 'session.cancelled': cancelled('joy', extra), updatedAt: serverTimestamp(),
});

test('cancel game: allowed in the first 5 minutes, stopping the clock in the same write', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 2 * MIN) });
  await assertSucceeds(cancelRunning(as('joy')));
});

test('cancel game: after 5 minutes it is refused, even for the owner', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 6 * MIN) });
  await assertFails(cancelRunning(as('joy')));
  await assertFails(updateDoc(doc(as('owner'), 'tables/t1'), {
    'session.ended': true, 'session.endedAt': serverTimestamp(), 'session.cancelled': cancelled('owner'), updatedAt: serverTimestamp(),
  }));
});

test('cancel game: a stopped clock can be cancelled only if it ran 5 minutes or less', async () => {
  const now = Date.now();
  await seed({ 'tables/t1': endedTable(now - 60 * MIN, now - 57 * MIN), 'tables/t2': endedTable(now - 60 * MIN, now - 54 * MIN) });
  const joy = as('joy');
  await assertSucceeds(updateDoc(doc(joy, 'tables/t1'), { 'session.cancelled': cancelled(), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(joy, 'tables/t2'), { 'session.cancelled': cancelled(), updatedAt: serverTimestamp() }));
});

test('cancel game: once only, under your own name, server-stamped, and no other session changes', async () => {
  await seed({ 'tables/t1': runningTable(Date.now() - 2 * MIN) });
  const joy = as('joy');
  await assertFails(cancelRunning(joy, { byId: 'bea' }));
  await assertFails(cancelRunning(joy, { at: ts(Date.now() - MIN) }));
  await assertFails(cancelRunning(joy, { reason: '' }));
  await assertFails(updateDoc(doc(joy, 'tables/t1'), {
    'session.ended': true, 'session.endedAt': serverTimestamp(), 'session.cancelled': cancelled(), 'session.startedAt': ts(Date.now()), updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(cancelRunning(joy));
  await assertFails(updateDoc(doc(joy, 'tables/t1'), { 'session.cancelled': cancelled(), updatedAt: serverTimestamp() }), 'already cancelled');
});

test('cancel game: checkout records ₱0 table fee; a normal game can’t claim ₱0 or "cancelled"', async () => {
  const now = Date.now();
  const startedMs = now - 10 * MIN;
  const endedMs = startedMs + 3 * MIN;
  const cancelledSession = { ...endedTable(startedMs, endedMs).session, cancelled: { reason: 'Accidental start', note: '', byId: 'joy', byName: 'Joy', at: ts(endedMs) } };
  await seed({ 'tables/t1': { ...endedTable(startedMs, endedMs), session: cancelledSession } });
  const joy = as('joy');
  const cancelExtra = { gameCancelled: true, cancelReason: 'Accidental start', cancelNote: '', cancelledById: 'joy', cancelledByName: 'Joy' };
  // A cancelled game must not be billed the rate, and must carry the cancelled flag.
  await assertFails(checkout(joy, { durationMs: 3 * MIN, startedMs, endedMs, fee: 200, extra: cancelExtra }));
  await assertFails(checkout(joy, { durationMs: 3 * MIN, startedMs, endedMs, fee: 0, extra: { method: 'none', payments: { cash: 0, gcash: 0 }, tendered: null, change: null } }));
  await assertSucceeds(checkout(joy, { durationMs: 3 * MIN, startedMs, endedMs, fee: 0, extra: { ...cancelExtra, method: 'none', payments: { cash: 0, gcash: 0 }, tendered: null, change: null } }));
});

test('cancel game: an ordinary short game still pays the first hour and can’t pose as cancelled', async () => {
  const startedMs = Date.now() - 10 * MIN;
  const endedMs = startedMs + 3 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs) });
  const joy = as('joy');
  await assertFails(checkout(joy, { durationMs: 3 * MIN, startedMs, endedMs, fee: 0, extra: { gameCancelled: true, method: 'none', payments: { cash: 0, gcash: 0 } } }));
  await assertSucceeds(checkout(joy, { durationMs: 3 * MIN, startedMs, endedMs, fee: 200 }));
});

test('a completed sale can never be changed or deleted (no void after payment)', async () => {
  await seed({
    'transactions/sale1': {
      tableId: 't1', tableName: 'Table 01', durationMs: 3 * MIN, tableFee: 200, productTotal: 0, total: 200,
      method: 'cash', payments: { cash: 200, gcash: 0 }, cashierId: 'joy', cashierName: 'Joy', createdAt: ts(Date.now() - MIN),
    },
  });
  await assertFails(updateDoc(doc(as('joy'), 'transactions/sale1'), { tableFee: 0, total: 0 }));
  await assertFails(updateDoc(doc(as('owner'), 'transactions/sale1'), { tableFee: 0, total: 0 }));
  await assertFails(deleteDoc(doc(as('owner'), 'transactions/sale1')));
});

test('cashiers can never raise stock', async () => {
  await assertFails(updateDoc(doc(as('joy'), 'products/beer'), { stock: 12, updatedAt: serverTimestamp() }));
});
/* ---------------- expenses ---------------- */

const expense = (uid, name, extra = {}) => ({
  description: 'Drinking water', amount: 60, cashierId: uid, cashierName: name, createdAt: serverTimestamp(), ...extra,
});

test('expenses: staff log their own, server-stamped, with a description and a positive amount', async () => {
  const joy = as('joy');
  await assertSucceeds(setDoc(doc(joy, 'expenses/e1'), expense('joy', 'Joy')));
  await assertSucceeds(setDoc(doc(as('owner'), 'expenses/e2'), expense('owner', 'Marco', { amount: 12.5 })));
  await assertFails(setDoc(doc(joy, 'expenses/e3'), expense('bea', 'Bea')), 'under someone else’s name');
  await assertFails(setDoc(doc(joy, 'expenses/e4'), expense('joy', 'Joy', { createdAt: ts(Date.now() - 12 * 60 * MIN) })), 'backdated to another shift');
  await assertFails(setDoc(doc(joy, 'expenses/e5'), expense('joy', 'Joy', { amount: 0 })));
  await assertFails(setDoc(doc(joy, 'expenses/e6'), expense('joy', 'Joy', { amount: -50 })));
  await assertFails(setDoc(doc(joy, 'expenses/e7'), expense('joy', 'Joy', { amount: '60' })));
  await assertFails(setDoc(doc(joy, 'expenses/e8'), expense('joy', 'Joy', { description: '' })));
  await assertFails(setDoc(doc(joy, 'expenses/e9'), expense('joy', 'Joy', { description: 'x'.repeat(121) })));
  await assertFails(setDoc(doc(joy, 'expenses/e10'), expense('joy', 'Joy', { approved: true })), 'unknown fields');
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'expenses/e11'), expense('joy', 'Joy')));
});

test('expenses: nobody edits one; only the owner can remove a mistaken one', async () => {
  await seed({ 'expenses/e1': { description: 'Ice', amount: 80, cashierId: 'joy', cashierName: 'Joy', createdAt: ts(Date.now()) } });
  await assertSucceeds(getDoc(doc(as('bea'), 'expenses/e1')));
  await assertFails(updateDoc(doc(as('joy'), 'expenses/e1'), { amount: 8 }));
  await assertFails(updateDoc(doc(as('owner'), 'expenses/e1'), { amount: 8 }));
  await assertFails(deleteDoc(doc(as('joy'), 'expenses/e1')), 'the cashier who logged it');
  await assertSucceeds(deleteDoc(doc(as('owner'), 'expenses/e1')));
});

test('settings: staff read, only the owner switches Day/Night shifts', async () => {
  await assertFails(setDoc(doc(as('joy'), 'settings/shifts'), { twoShifts: true }));
  await assertSucceeds(setDoc(doc(as('owner'), 'settings/shifts'), { twoShifts: true }));
  await assertSucceeds(getDoc(doc(as('joy'), 'settings/shifts')));
});

/* ---------------- clock & presence ---------------- */

test('clock probe and presence must use server time', async () => {
  const joy = as('joy');
  await assertSucceeds(setDoc(doc(joy, 'clock/joy'), { t: serverTimestamp() }));
  await assertFails(setDoc(doc(joy, 'clock/joy'), { t: ts(Date.now() - 10 * MIN) }));
  await assertFails(setDoc(doc(joy, 'clock/bea'), { t: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(joy, 'users/joy'), { online: true, lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(doc(joy, 'users/joy'), { online: true, lastSeen: ts(Date.now() + 60 * MIN) }));
});

function assert(ok, msg) { if (!ok) throw new Error(msg); }
