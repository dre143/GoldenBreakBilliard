// Security-rule tests against the Firestore emulator:  npm run test:rules
// Each "attack" is a write a cashier could send straight to Firestore, bypassing the app.
import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp,
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

/* ---------------- table-fee void ----------
 * Voiding only ever waives the table charge (refunded through whichever payment channel covered it);
 * items are never touched and stay charged. Eligibility is based on how long the table was actually
 * used (sale.durationMs <= 5 min), not on how much real time has passed since checkout. */

async function seedSale({ durationMs, cashier = 'joy', method = 'cash', cash, gcash, createdMs = Date.now() - 30_000 }) {
  const endedMs = createdMs;
  const startedMs = endedMs - durationMs;
  const fee = tableFee(durationMs);
  const productTotal = 170; // 2x beer
  const total = fee + productTotal;
  const payments = method === 'split' ? { cash, gcash } : method === 'gcash' ? { cash: 0, gcash: total } : { cash: total, gcash: 0 };
  await seed({
    'tables/t1': freeTable,
    'transactions/sale1': {
      tableId: 't1', tableName: 'Table 01', startedAt: ts(startedMs), endedAt: ts(endedMs), durationMs,
      plannedMs: 0, billedMs: durationMs, mode: 'open',
      rounds: 0, tableFee: fee, items: [{ productId: 'beer', name: 'Beer', price: 85, qty: 2, total: 170 }],
      productTotal, total, method, payments,
      cashierId: cashier, cashierName: 'Joy', createdAt: ts(createdMs),
    },
  });
  return { fee, productTotal, total, startedMs, endedMs };
}

// `payments` is always overridden per call site (there's no single correct default once a sale can be
// cash, GCash or split), so the base here is just a placeholder that every test replaces.
const voidPatch = (uid, sale, extra = {}) => ({
  tableFeeVoided: true, tableFeeVoidedAt: serverTimestamp(), tableFeeVoidedById: uid, tableFeeVoidedByName: uid,
  voidReason: 'Customer decided not to play', voidNote: '',
  originalTableFee: sale.fee, originalTotal: sale.total,
  tableFee: 0, total: sale.productTotal,
  payments: { cash: 0, gcash: 0 },
  refundAmount: sale.fee, refundMethod: 'cash',
  ...extra,
});

test('table-fee void: table used 5 min or less, own sale — table fee waived, items untouched', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  await assertSucceeds(updateDoc(doc(as('joy'), 'transactions/sale1'),
    voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } })));
});

test('table-fee void: table used more than 5 min is never voidable, even for the owner', async () => {
  const sale = await seedSale({ durationMs: 5 * MIN + 1000 });
  const patch = voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } });
  await assertFails(updateDoc(doc(as('joy'), 'transactions/sale1'), patch));
  await assertFails(updateDoc(doc(as('owner'), 'transactions/sale1'), { ...patch, tableFeeVoidedById: 'owner', tableFeeVoidedByName: 'owner' }));
});

test('table-fee void: eligibility does not decay in real time (short session voidable even long after checkout)', async () => {
  const sale = await seedSale({ durationMs: 2 * MIN, createdMs: Date.now() - 2 * 24 * 60 * MIN });
  await assertSucceeds(updateDoc(doc(as('joy'), 'transactions/sale1'),
    voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } })));
});

test('table-fee void: another cashier can’t void; the owner can', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  const patch = voidPatch('bea', sale, { payments: { cash: sale.productTotal, gcash: 0 } });
  await assertFails(updateDoc(doc(as('bea'), 'transactions/sale1'), patch));
  await assertSucceeds(updateDoc(doc(as('owner'), 'transactions/sale1'),
    { ...patch, tableFeeVoidedById: 'owner', tableFeeVoidedByName: 'owner' }));
});

test('table-fee void: can’t void twice, backdate the void, or touch items/productTotal', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  const joy = as('joy');
  const base = voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } });
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'), { ...base, tableFeeVoidedAt: ts(Date.now() - 3 * MIN) }));
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'), { ...base, productTotal: 0 }));
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'), { ...base, items: [] }));
  await assertSucceeds(updateDoc(doc(joy, 'transactions/sale1'), base));
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'), base)); // already voided
});

test('table-fee void: refund must equal the table fee exactly, deducted from the stated channel only', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  const joy = as('joy');
  // Claim less/more refund than the actual table fee.
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundAmount: sale.fee - 50, payments: { cash: sale.productTotal + 50, gcash: 0 } })));
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundAmount: sale.fee + 50, payments: { cash: sale.productTotal - 50, gcash: 0 } })));
  // Refund method says cash but the GCash side moved instead.
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundMethod: 'cash', payments: { cash: sale.fee + sale.productTotal, gcash: -sale.fee } })));
  await assertSucceeds(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } })));
});

test('table-fee void: split payment refunds from the chosen channel only, and only if it covers the fee', async () => {
  // fee = tableFee(3 min) = 200, items = 170, total = 370 = cash(170) + gcash(200).
  const sale = await seedSale({ durationMs: 3 * MIN, method: 'split', cash: 170, gcash: 200 });
  const joy = as('joy');
  // Refund via cash: only ₱170 was paid in cash, less than the ₱200 fee — not enough there.
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundMethod: 'cash', payments: { cash: 170 - sale.fee, gcash: 200 } })));
  // Wrong channel moved (says gcash refund, but the cash number changed instead).
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundMethod: 'gcash', payments: { cash: 170 - sale.fee, gcash: 200 } })));
  // Refund via GCash (₱200 covers the ₱200 fee exactly): cash untouched, GCash drops to 0.
  await assertSucceeds(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { refundMethod: 'gcash', payments: { cash: 170, gcash: 200 - sale.fee } })));
});

test('table-fee void never returns stock — a cashier can no longer raise stock at all', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  const joy = as('joy');
  await assertFails(updateDoc(doc(joy, 'products/beer'), { stock: 12, updatedAt: serverTimestamp() }));
  // Even alongside a legitimate void in the same batch, raising stock is not part of the contract.
  const batch = writeBatch(joy);
  batch.update(doc(joy, 'products/beer'), { stock: 12, updatedAt: serverTimestamp() });
  batch.update(doc(joy, 'transactions/sale1'), voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 } }));
  await assertFails(batch.commit());
});

test('table-fee void has no "reopen": can’t restore the old session stamps, and the old reopen fields are gone', async () => {
  const sale = await seedSale({ durationMs: 3 * MIN });
  const joy = as('joy');
  // "Reopening" a table with the voided sale's original (now stale) start/end stamps is not a thing
  // any more: startsSession() only accepts startedAt == request.time, with no fallback path.
  await assertFails(updateDoc(doc(joy, 'tables/t1'), {
    status: 'in_use',
    session: {
      startedAt: ts(sale.startedMs), ended: true, endedAt: ts(sale.endedMs),
      plannedMs: 0, items: [], rounds: 0, openedBy: 'joy', openedByName: 'Joy',
    },
    updatedAt: serverTimestamp(),
  }));
  // The old reopen-tracking fields no longer exist on the void write at all.
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 }, voidReopenedTable: false })));
  await assertFails(updateDoc(doc(joy, 'transactions/sale1'),
    voidPatch('joy', sale, { payments: { cash: sale.productTotal, gcash: 0 }, reopenedFromVoid: 'sale1' })));
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
