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
    'users/tv': { name: 'Lobby TV', role: 'display', active: true },
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

function checkout(fs, { durationMs, startedMs, endedMs, fee, plannedMs = 0, billedMs = durationMs, createdAt = serverTimestamp(), txId = 'sale1', cashier = 'joy', extra = {} }) {
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
  ['30 minutes (first hour is flat)', 30 * MIN, 200],
  ['1 hour', 60 * MIN, 200],
  ['1 hour + 1 ms (inside the grace period)', 60 * MIN + 1, 200],
  ['1:05:59.999 (last moment of the grace period)', 66 * MIN - 1, 200],
  ['1:06:00 (grace over, first ₱50)', 66 * MIN, 250],
  ['1:20:59.999', 81 * MIN - 1, 250],
  ['1:21:00', 81 * MIN, 300],
  ['1:35:59.999', 96 * MIN - 1, 300],
  ['1:36:00', 96 * MIN, 350],
  ['1:51:00', 111 * MIN, 400],
  ['2:05:59.999', 126 * MIN - 1, 400],
  ['2:06:00', 126 * MIN, 450],
  ['2:36:00', 156 * MIN, 550],
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

test('QRPH and split payments need the last 5 digits of the QRPH reference number', async () => {
  const joy = as('joy');
  const gcash = (gcashRef, txId) => quickSale(joy, { txId, extra: { method: 'gcash', payments: { cash: 0, gcash: 170 }, tendered: null, change: null, ...(gcashRef === undefined ? {} : { gcashRef }) } });
  const split = (gcashRef, txId) => quickSale(joy, { txId, extra: { method: 'split', payments: { cash: 70, gcash: 100 }, tendered: null, change: null, gcashRef } });
  await assertFails(gcash(undefined, 'g1'));
  await assertFails(gcash(null, 'g2'));
  await assertFails(gcash('1234', 'g3'));
  await assertFails(gcash('123456', 'g4'));
  await assertFails(gcash('12a45', 'g5'));
  await assertFails(gcash(48213, 'g6')); // must be text, so a leading 0 is kept
  await assertSucceeds(gcash('48213', 'g7'));
  await assertSucceeds(gcash('00917', 'g8'));
  await assertFails(split(null, 's1'));
  await assertSucceeds(split('55120', 's2'));
  await assertSucceeds(quickSale(joy, { txId: 'c1', extra: { gcashRef: null } })); // cash needs no reference
});

/* ---------------- booked hours (Set Hours) ---------------- */

test('booked 2h, stopped after 45 min: only the time played is billed (₱200); charging the booked ₱400 is rejected', async () => {
  const startedMs = Date.now() - 50 * MIN;
  const endedMs = startedMs + 45 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 120 * MIN) });
  const joy = as('joy');
  // Try to bill the booking (unused booked time) instead of the time actually played.
  await assertFails(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN, billedMs: 120 * MIN }));
  await assertFails(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN }));
  // Try to claim a smaller booking than the session had.
  await assertFails(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 200, plannedMs: 0 }));
  await assertSucceeds(checkout(joy, { durationMs: 45 * MIN, startedMs, endedMs, fee: 200, plannedMs: 120 * MIN }));
});

test('booked 1h15, ended after 59 seconds: ₱200 (the booked ₱250 is rejected)', async () => {
  const startedMs = Date.now() - 5 * MIN;
  const endedMs = startedMs + 59 * 1000;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 75 * MIN) });
  const joy = as('joy');
  await assertFails(checkout(joy, { durationMs: 59 * 1000, startedMs, endedMs, fee: 250, plannedMs: 75 * MIN }));
  await assertFails(checkout(joy, { durationMs: 59 * 1000, startedMs, endedMs, fee: 250, plannedMs: 75 * MIN, billedMs: 75 * MIN }));
  await assertSucceeds(checkout(joy, { durationMs: 59 * 1000, startedMs, endedMs, fee: 200, plannedMs: 75 * MIN }));
});

test('booked 2h, played 2h 6min: overtime billed → ₱450; ₱400 rejected', async () => {
  const startedMs = Date.now() - 135 * MIN;
  const endedMs = startedMs + 126 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 120 * MIN) });
  const joy = as('joy');
  await assertFails(checkout(joy, { durationMs: 126 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN, billedMs: 120 * MIN }));
  await assertSucceeds(checkout(joy, { durationMs: 126 * MIN, startedMs, endedMs, fee: 450, plannedMs: 120 * MIN }));
});

test('booked 2h, played 2h 5min: still inside the grace period → ₱400; the old ₱450 is rejected', async () => {
  const startedMs = Date.now() - 135 * MIN;
  const endedMs = startedMs + 125 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, endedMs, 120 * MIN) });
  const joy = as('joy');
  await assertFails(checkout(joy, { durationMs: 125 * MIN, startedMs, endedMs, fee: 450, plannedMs: 120 * MIN }));
  await assertSucceeds(checkout(joy, { durationMs: 125 * MIN, startedMs, endedMs, fee: 400, plannedMs: 120 * MIN }));
});

test('expired unpaid booking can continue only with a future booking end and unchanged start', async () => {
  const started = Date.now() - 61 * MIN;
  await seed({ 'tables/t1': endedTable(started, started + 60 * MIN, 60 * MIN) });
  const ref = doc(as('joy'), 'tables/t1');
  const patch = { 'session.ended': false, 'session.endedAt': null, 'session.plannedMs': 90 * MIN, updatedAt: serverTimestamp() };
  await assertFails(updateDoc(ref, { ...patch, 'session.startedAt': serverTimestamp() }));
  await assertFails(updateDoc(ref, { ...patch, 'session.plannedMs': 60 * MIN }));
  await assertSucceeds(updateDoc(ref, patch));
});

test('auto-stop clock skew allows continuation up to two seconds before expiry', async () => {
  const started = Date.now() - 61 * MIN;
  await seed({
    'tables/t1': endedTable(started, started + 60 * MIN - 1000, 60 * MIN),
    'tables/t2': endedTable(started, started + 60 * MIN - 2000, 60 * MIN),
    'tables/t3': endedTable(started, started + 60 * MIN - 2001, 60 * MIN),
  });
  const patch = { 'session.ended': false, 'session.endedAt': null, 'session.plannedMs': 90 * MIN, updatedAt: serverTimestamp() };
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), patch));
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t2'), patch));
  await assertFails(updateDoc(doc(as('joy'), 'tables/t3'), patch));
});

test('early stopped or cancelled bookings cannot continue', async () => {
  const started = Date.now() - 61 * MIN;
  const early = endedTable(started, started + 30 * MIN, 60 * MIN);
  const expired = endedTable(started, started + 60 * MIN, 60 * MIN);
  await seed({ 'tables/t1': early, 'tables/t2': { ...expired, session: { ...expired.session, cancelled: { reason: 'Other' } } } });
  const patch = { 'session.ended': false, 'session.endedAt': null, 'session.plannedMs': 90 * MIN, updatedAt: serverTimestamp() };
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), patch));
  await assertFails(updateDoc(doc(as('joy'), 'tables/t2'), patch));
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

/* ---------------- cue sticks (a separate catalog from products) ---------------- */

const cueStick = (overrides = {}) => ({
  name: 'Predator Sport II', brand: 'Predator', weight: '19oz', price: 8500, photo: null,
  status: 'available', createdAt: ts(Date.now() - MIN), updatedAt: ts(Date.now() - MIN), ...overrides,
});

test('owner can add a cue stick; a cashier cannot', async () => {
  await assertSucceeds(setDoc(doc(as('owner'), 'cueSticks/c1'), cueStick()));
  await assertFails(setDoc(doc(as('joy'), 'cueSticks/c2'), cueStick()));
});

test('a cue stick photo over ~900KB is rejected', async () => {
  await assertFails(setDoc(doc(as('owner'), 'cueSticks/big'), cueStick({ photo: 'x'.repeat(1_000_000) })));
  await assertSucceeds(setDoc(doc(as('owner'), 'cueSticks/small'), cueStick({ photo: 'x'.repeat(1000) })));
});

test('a cashier can mark an available cue stick sold with a server timestamp, not a fabricated one', async () => {
  await seed({ 'cueSticks/c1': cueStick() });
  await assertFails(updateDoc(doc(as('joy'), 'cueSticks/c1'), {
    status: 'sold', soldAt: ts(Date.now() - MIN), soldTxId: 'x1', soldByName: 'Joy', updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(doc(as('joy'), 'cueSticks/c1'), {
    status: 'sold', soldAt: serverTimestamp(), soldTxId: 'x1', soldByName: 'Joy', updatedAt: serverTimestamp(),
  }));
});

test('a cashier cannot change any other field while marking a cue stick sold', async () => {
  await seed({ 'cueSticks/c1': cueStick() });
  await assertFails(updateDoc(doc(as('joy'), 'cueSticks/c1'), {
    status: 'sold', price: 1, soldAt: serverTimestamp(), soldTxId: 'x1', soldByName: 'Joy', updatedAt: serverTimestamp(),
  }));
});

test('a cashier cannot sell the same cue stick twice, or un-sell one', async () => {
  await seed({ 'cueSticks/c1': cueStick({ status: 'sold', soldAt: ts(Date.now() - MIN), soldTxId: 'x0', soldByName: 'Joy' }) });
  await assertFails(updateDoc(doc(as('joy'), 'cueSticks/c1'), {
    status: 'sold', soldAt: serverTimestamp(), soldTxId: 'x1', soldByName: 'Bea', updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(as('joy'), 'cueSticks/c1'), {
    status: 'available', soldAt: null, soldTxId: null, soldByName: null, updatedAt: serverTimestamp(),
  }));
});

test('the owner can still fix a cue stick’s details after it is sold; only the owner can delete one', async () => {
  await seed({ 'cueSticks/c1': cueStick({ status: 'sold', soldAt: ts(Date.now() - MIN), soldTxId: 'x0', soldByName: 'Joy' }) });
  await assertSucceeds(updateDoc(doc(as('owner'), 'cueSticks/c1'), { price: 8000, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(as('joy'), 'cueSticks/c1')));
  await assertSucceeds(deleteDoc(doc(as('owner'), 'cueSticks/c1')));
});

/* ---------------- cue stick sale (its own walk-in sale type, apart from Quick Sale) ---------------- */

function cueStickSale(fs, {
  cueStickTotal = 8500, fee = 0, productTotal = 0, total = cueStickTotal, cashier = 'joy', createdAt = serverTimestamp(), txId = 'cs1', extra = {},
}) {
  return setDoc(doc(fs, 'transactions', txId), {
    tableId: null, tableName: null, pricing: null,
    startedAt: null, endedAt: null, durationMs: null,
    plannedMs: null, billedMs: null, mode: null, rounds: 0,
    saleType: 'cue-stick',
    tableFee: fee, productTotal, cueStickTotal,
    items: [{ cueStickId: 'c1', name: 'Predator Sport II', brand: 'Predator', price: 8500, qty: 1, total: 8500 }],
    total, method: 'cash', payments: { cash: total, gcash: 0 }, tendered: total, change: 0,
    cashierId: cashier, cashierName: 'Joy', createdAt, ...extra,
  });
}

test('cue stick sale: a walk-in sale with no table fee and no product total is allowed', async () => {
  await assertSucceeds(cueStickSale(as('joy'), {}));
});

test('cue stick sale: a fabricated table fee is rejected', async () => {
  await assertFails(cueStickSale(as('joy'), { fee: 200, total: 8700 }));
});

test('cue stick sale: total must equal cueStickTotal exactly', async () => {
  await assertFails(cueStickSale(as('joy'), { total: 8000 }));
});

test('cue stick sale: a fabricated product total is rejected — it stays apart from Quick Sale', async () => {
  await assertFails(cueStickSale(as('joy'), { productTotal: 100, total: 8600 }));
});

test('cue stick sale: cashier can’t record it under someone else’s name', async () => {
  await assertFails(cueStickSale(as('joy'), { cashier: 'bea' }));
});

/* ---------------- transfer table ----------------
 * A live (unended) session moves to a different table, keeping its start time, items and rounds — the
 * bill continues without interruption. Both table writes happen in the same batch: the source frees
 * (recording which table received it), the destination gets the session verbatim plus one more entry on
 * `transfers`. Neither half is valid alone, mirroring how checkout's closesWithSale/saleMatchesSession
 * cross-check each other. */

const table2 = { name: 'Table 02', number: 2, status: 'available', session: null, light: false };

// `at` is a client timestamp, not serverTimestamp() (Firestore doesn't allow that sentinel inside an
// array element, and `transfers` is one — see the matching comment in firestore.rules/services.js), so
// tests use a concrete Timestamp close to "now" by default, same as the app itself would send.
function transferEntry(startedMs, { fromId = 't1', fromName = 'Table 01', byId = 'joy', byName = 'Joy', at = ts(Date.now()) } = {}) {
  return { fromTableId: fromId, fromTableName: fromName, at, byId, byName };
}

function transferBatch(fs, {
  fromId = 't1', toId = 't2', fromName = 'Table 01', startedMs, plannedMs = 0, items = [], rounds = 0,
  priorTransfers = [], entry, sourcePatch = {}, destPatch = {},
} = {}) {
  const batch = writeBatch(fs);
  batch.update(doc(fs, 'tables', fromId), {
    status: 'available', session: null, lastTransferToId: toId, updatedAt: serverTimestamp(), ...sourcePatch,
  });
  batch.update(doc(fs, 'tables', toId), {
    status: 'in_use',
    session: {
      startedAt: ts(startedMs), ended: false, endedAt: null, plannedMs, items, rounds,
      openedBy: 'joy', openedByName: 'Joy',
      transfers: [...priorTransfers, entry ?? transferEntry(startedMs, { fromId, fromName })],
    },
    updatedAt: serverTimestamp(),
    ...destPatch,
  });
  return batch.commit();
}

test('transfer: a live session moves to an available table, start time and items unchanged', async () => {
  const startedMs = Date.now() - 20 * MIN;
  const items = [{ productId: 'beer', name: 'Beer', price: 85, qty: 2 }];
  // The destination must carry over exactly what the source actually had on its bill.
  await seed({ 'tables/t1': { ...runningTable(startedMs), session: { ...runningTable(startedMs).session, items } }, 'tables/t2': table2 });
  await assertSucceeds(transferBatch(as('joy'), { startedMs, items }));
});

test('transfer: the destination must actually be available', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': { ...table2, status: 'in_use', session: runningTable(startedMs).session } });
  await assertFails(transferBatch(as('joy'), { startedMs }));
});

test('transfer: an ended session (clock stopped, awaiting payment) can’t be transferred', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': endedTable(startedMs, Date.now() - 5 * MIN), 'tables/t2': table2 });
  await assertFails(transferBatch(as('joy'), { startedMs }));
});

test('transfer: the start time can’t change in the move (no shortening or backdating the bill)', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': table2 });
  await assertFails(transferBatch(as('joy'), { startedMs: startedMs + 10 * MIN }));
});

test('transfer: items and rounds must match exactly — no adding free items or rounds along the way', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': { ...runningTable(startedMs), session: { ...runningTable(startedMs).session, rounds: 1 } }, 'tables/t2': table2 });
  await assertFails(transferBatch(as('joy'), { startedMs, items: [{ productId: 'beer', name: 'Beer', price: 85, qty: 5 }] }), 'extra items smuggled in');
  await assertFails(transferBatch(as('joy'), { startedMs, rounds: 4 }), 'extra rounds smuggled in');
  await assertSucceeds(transferBatch(as('joy'), { startedMs, rounds: 1 }));
});

test('transfer: a live session can’t just be discarded — freeing the source needs a real, matching destination', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': table2 });
  // Only the source half of the batch: no table actually receives the session.
  await assertFails(updateDoc(doc(as('joy'), 'tables/t1'), {
    status: 'available', session: null, lastTransferToId: 't2', updatedAt: serverTimestamp(),
  }));
});

test('transfer: a table can’t receive an invented session without a real source paying it out', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': table2 });
  // Only the destination half: t1 is never actually freed for it.
  await assertFails(updateDoc(doc(as('joy'), 'tables/t2'), {
    status: 'in_use',
    session: {
      startedAt: ts(startedMs), ended: false, endedAt: null, plannedMs: 0, items: [], rounds: 0,
      openedBy: 'joy', openedByName: 'Joy', transfers: [transferEntry(startedMs)],
    },
    updatedAt: serverTimestamp(),
  }));
});

test('transfer: the log entry must name the cashier actually doing it, server-stamped, not backdated', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': table2 });
  await assertFails(transferBatch(as('joy'), { startedMs, entry: transferEntry(startedMs, { byId: 'bea', byName: 'Bea' }) }), 'attributed to someone else');
  await assertFails(transferBatch(as('joy'), { startedMs, entry: { ...transferEntry(startedMs), at: ts(Date.now() - 20 * MIN) } }), 'backdated well beyond a synced clock’s tolerance');
});

test('transfer: can’t transfer a table to itself', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs) });
  await assertFails(transferBatch(as('joy'), { fromId: 't1', toId: 't1', startedMs }));
});

test('transfer: a booking’s length carries over, and a second hop keeps the full history and the original start time', async () => {
  const startedMs = Date.now() - 80 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs, 60 * MIN), 'tables/t2': table2, 'tables/t3': { ...table2, name: 'Table 03', number: 3 } });
  await assertSucceeds(transferBatch(as('joy'), { startedMs, plannedMs: 60 * MIN }));
  // Second hop: t2 -> t3, carrying the first transfer entry forward and appending a second.
  const first = transferEntry(startedMs);
  await assertFails(transferBatch(as('bea'), {
    fromId: 't2', toId: 't3', startedMs, plannedMs: 60 * MIN, priorTransfers: [first],
    entry: transferEntry(startedMs, { fromId: 't2', fromName: 'Table 02', byId: 'joy', byName: 'Joy' }),
  }), 'attributed to someone else again');
  await assertSucceeds(transferBatch(as('bea'), {
    fromId: 't2', toId: 't3', startedMs, plannedMs: 60 * MIN, priorTransfers: [first],
    entry: transferEntry(startedMs, { fromId: 't2', fromName: 'Table 02', byId: 'bea', byName: 'Bea' }),
  }));
});

test('transfer: the freed source table is immediately available for a brand-new session', async () => {
  const startedMs = Date.now() - 20 * MIN;
  await seed({ 'tables/t1': runningTable(startedMs), 'tables/t2': table2 });
  await assertSucceeds(transferBatch(as('joy'), { startedMs }));
  await assertSucceeds(updateDoc(doc(as('joy'), 'tables/t1'), { status: 'in_use', session: newSession(0), updatedAt: serverTimestamp() }));
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

test('settings: only the owner sets the cash drawer PIN; staff can read it to check a PIN', async () => {
  await assertFails(setDoc(doc(as('joy'), 'settings/cashDrawer'), { pinHash: 'x' }));
  await assertSucceeds(setDoc(doc(as('owner'), 'settings/cashDrawer'), { pinHash: 'abc123' }));
  await assertSucceeds(getDoc(doc(as('joy'), 'settings/cashDrawer')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'settings/cashDrawer')));
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

/* ---------------- display role (an unattended screen, e.g. a TV running Showcase) ---------------- */

test('a display account can read tables and cue sticks, same as any staff', async () => {
  await seed({ 'tables/t1': freeTable, 'cueSticks/c1': { name: 'Cue', status: 'available', price: 1000 } });
  const tv = as('tv');
  await assertSucceeds(getDoc(doc(tv, 'tables/t1')));
  await assertSucceeds(getDoc(doc(tv, 'cueSticks/c1')));
});

test('a display account cannot read products, transactions, expenses, settings or other staff', async () => {
  await seed({
    'transactions/x1': { tableId: null, tableFee: 0, productTotal: 0, total: 0, method: 'none', cashierId: 'joy', cashierName: 'Joy', createdAt: ts(Date.now()) },
    'expenses/e1': { description: 'Ice', amount: 50, cashierId: 'joy', cashierName: 'Joy', createdAt: ts(Date.now()) },
    'settings/shifts': { twoShifts: false },
  });
  const tv = as('tv');
  await assertFails(getDoc(doc(tv, 'products/beer')));
  await assertFails(getDoc(doc(tv, 'transactions/x1')));
  await assertFails(getDoc(doc(tv, 'expenses/e1')));
  await assertFails(getDoc(doc(tv, 'settings/shifts')));
  await assertFails(getDoc(doc(tv, 'users/joy')));
});

test('a display account cannot start, end or otherwise write a table, or sell a cue stick', async () => {
  await seed({ 'tables/t1': freeTable, 'cueSticks/c1': { name: 'Cue', status: 'available', price: 1000 } });
  const tv = as('tv');
  await assertFails(updateDoc(doc(tv, 'tables/t1'), { status: 'in_use', session: newSession(0), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(tv, 'cueSticks/c1'), {
    status: 'sold', soldAt: serverTimestamp(), soldTxId: 'x1', soldByName: 'Lobby TV', updatedAt: serverTimestamp(),
  }));
});

test('a display account can still update only its own presence, like any signed-in account', async () => {
  const tv = as('tv');
  await assertSucceeds(updateDoc(doc(tv, 'users/tv'), { online: true, lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(doc(tv, 'users/joy'), { online: true, lastSeen: serverTimestamp() }));
});

function assert(ok, msg) { if (!ok) throw new Error(msg); }
