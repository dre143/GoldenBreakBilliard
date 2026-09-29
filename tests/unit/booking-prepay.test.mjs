import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedMs, isPrepaid, paidMs, paidFee, balanceDue, tableFee, dueTableFee,
} from '../../js/billing.js';

// Exercise the real services against an isolated, in-memory demo backend (see booking-services.test.mjs).
globalThis.location = { search: '?demo' };
globalThis.self = { addEventListener() {} };
globalThis.localStorage = { getItem: () => '{}', setItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
const { db } = await import('../../js/db.js');
const {
  startSession, payBooking, extendSession, endSession, finishAutoStop, cancelGame, completeCheckout, changeItem,
} = await import('../../js/services.js');

const MIN = 60000;
const joy = { uid: 'joy', name: 'Joy' };

function withClock(startMs, fn) {
  const originalNow = Date.now;
  let now = startMs;
  const advance = (ms) => { now += ms; };
  Date.now = () => now;
  return fn(advance).finally(() => { Date.now = originalNow; });
}

async function freshTable(id = 't1') {
  await db.set('tables', id, { name: 'Table 1', status: 'available', session: null });
  return id;
}

test('payBooking pays the full fee for a fresh 1h booking and keeps the session running', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  const before = await db.get('tables', 't1');
  assert.equal(isPrepaid(before.session), false);

  const receipt = await payBooking('t1', { method: 'cash' }, joy);
  assert.equal(receipt.tableFee, 200);
  assert.equal(receipt.kind, 'prepay');
  assert.equal(receipt.paidFromMs, 0);
  assert.equal(receipt.paidToMs, 60 * MIN);

  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use'); // table stays occupied
  assert.equal(t.session.ended, false); // clock keeps running
  assert.equal(isPrepaid(t.session), true);
  assert.equal(paidMs(t.session), 60 * MIN);
  assert.equal(paidFee(t.session), 200);
  assert.equal(balanceDue(t.session), 0);
}));

test('a second payBooking on the same booking is rejected — no double payment', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy);
  await assert.rejects(payBooking('t1', { method: 'cash' }, joy), /already fully paid/);
}));

test('Open Time can\'t be paid in advance', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 });
  await assert.rejects(payBooking('t1', { method: 'cash' }, joy), /Set Hours booking/);
}));

test('Add time -> Pay Later just grows the booking; a balance opens up, nothing is charged', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy); // paid through 60 min
  advance(10 * MIN);
  const { planned, receipt } = await extendSession('t1', 30 * MIN); // 60 -> 90 min, Pay Later (default)
  assert.equal(planned, 90 * MIN);
  assert.equal(receipt, null); // nothing charged yet

  const t = await db.get('tables', 't1');
  assert.equal(paidMs(t.session), 60 * MIN); // still only 60 min paid for
  assert.equal(balanceDue(t.session), tableFee(90 * MIN) - tableFee(60 * MIN)); // 300 - 200 = 100
  assert.equal(t.status, 'in_use');
}));

test('Add time -> Pay Now charges only the extra amount, never the already-paid time again', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy); // 200 paid for 60 min
  const { planned, receipt } = await extendSession('t1', 30 * MIN, { payNow: true, method: 'cash', user: joy });
  assert.equal(planned, 90 * MIN);
  assert.equal(receipt.tableFee, 100); // fee(90) - fee(60) = 300 - 200
  assert.equal(receipt.paidFromMs, 60 * MIN);
  assert.equal(receipt.paidToMs, 90 * MIN);

  const t = await db.get('tables', 't1');
  assert.equal(balanceDue(t.session), 0);
  assert.equal(paidFee(t.session), 300);
}));

test('Add time -> Pay Now that lands in the same fee bracket charges nothing, but still advances paidMs', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await startSession('t1', joy, { booking: 30 * MIN }); // custom short booking
  await payBooking('t1', { method: 'cash' }, joy); // fee(30) = 200
  const { receipt } = await extendSession('t1', 15 * MIN, { payNow: true, method: 'cash', user: joy }); // 30 -> 45, still fee 200
  assert.equal(receipt, null); // nothing new owed
  const t = await db.get('tables', 't1');
  assert.equal(paidMs(t.session), 45 * MIN);
  assert.equal(balanceDue(t.session), 0);
}));

test('finishAutoStop frees the table automatically once fully paid with no unpaid items', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy);
  const startedAt = (await db.get('tables', 't1')).session.startedAt;
  advance(60 * MIN);
  await finishAutoStop('t1', { expiredBooking: 60 * MIN, startedAt }, joy);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'available'); // closed itself, no cashier action needed
  assert.equal(t.session, null);
}));

test('finishAutoStop leaves the table "Session ended" when a balance or items are still unpaid', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  // Never paid at all: balance == full fee.
  const startedAt = (await db.get('tables', 't1')).session.startedAt;
  advance(60 * MIN);
  await finishAutoStop('t1', { expiredBooking: 60 * MIN, startedAt }, joy);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use'); // still awaiting checkout
  assert.equal(t.session.ended, true);
}));

test('ending early after a full prepayment forfeits the unused time — no refund, table fee stays at what was paid', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy); // paid 200 for a full hour
  advance(10 * MIN); // customer leaves after only 10 minutes, well past the 5-minute cancel window
  await endSession('t1');
  const sale = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(sale.durationMs, 10 * MIN);
  assert.equal(sale.tableFee, 0); // nothing more owed — but also nothing refunded
  assert.equal(sale.total, 0);
  assert.equal(sale.prepaidAmount, 200);
}));

test('cancel within 5 minutes on a prepaid table fee refunds it via an append-only refund transaction', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy);
  advance(2 * MIN); // inside the 5-minute cancel window
  const result = await cancelGame('t1', { reason: 'Customer decided not to play', refundMethod: 'cash' }, joy);
  assert.equal(result.refunded, true);
  assert.equal(result.refundAmount, 200);
  const t = await db.get('tables', 't1');
  assert.equal(t.session.prepaid.refunded, true);
  await assert.rejects(
    cancelGame('t1', { reason: 'Other', note: 'x' }, joy),
    /already been cancelled/,
  );
}));

test('cancelling a prepaid game without a refund method is rejected', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await payBooking('t1', { method: 'cash' }, joy);
  advance(1 * MIN);
  await assert.rejects(
    cancelGame('t1', { reason: 'Customer decided not to play' }, joy),
    /refunded/,
  );
}));

test('billing.js prepaid helpers: an Open Time table is never "prepaid" and never has a balance', () => {
  assert.equal(isPrepaid(null), false);
  assert.equal(isPrepaid({ plannedMs: 0 }), false);
  assert.equal(paidFee({ plannedMs: 0 }), 0);
  assert.equal(balanceDue({ plannedMs: 0 }), 0);
});

/* ---------------- Open Time regression: no payment action may stop, log out, or clear it ----------------
 * Set Hours prepayment (payBooking / extendSession's payNow / finishAutoStop's auto-close / cancelGame's
 * refund) must never touch an Open Time table. Every one of these already guards on isTimed()/isPrepaid()
 * (see js/billing.js, js/services.js); the tests below prove the table is left completely untouched —
 * still in_use, still running, still with no session.prepaid — after each one is attempted or used.
 */

test('payBooking refuses an Open Time table and leaves the session completely untouched', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 }); // Open Time
  advance(20 * MIN);
  const before = await db.get('tables', 't1');
  await assert.rejects(payBooking('t1', { method: 'cash' }, joy), /Set Hours booking/);
  const after = await db.get('tables', 't1');
  assert.deepEqual(after, before); // no partial write of any kind — not even session.prepaid
  assert.equal(after.status, 'in_use');
  assert.equal(after.session.ended, false);
  assert.equal(isPrepaid(after.session), false);
}));

test('extendSession\'s Pay Now refuses an Open Time table (it was never prepaid) and leaves it running', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 }); // Open Time
  advance(20 * MIN);
  const before = await db.get('tables', 't1');
  await assert.rejects(
    extendSession('t1', 30 * MIN, { payNow: true, method: 'cash', user: joy }),
    /hasn.t been prepaid/,
  );
  const after = await db.get('tables', 't1');
  // plannedMs must not have moved either — a rejected payNow can't leave Open Time half-converted
  // into a Set Hours booking.
  assert.equal(after.session.plannedMs ?? 0, 0);
  assert.equal(after.status, 'in_use');
  assert.equal(after.session.ended, false);
  assert.deepEqual(after, before);
}));

test('finishAutoStop never auto-closes an Open Time table, even if it was ended manually with no items', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 }); // Open Time
  advance(90 * MIN);
  await endSession('t1'); // the cashier's own "End Session" — clock stops, table stays in_use awaiting checkout
  // finishAutoStop is only ever called by auto-stop's own Set-Hours-only loop (js/time-alerts.js
  // checkAutoStop), but calling it directly must still refuse to touch a plain Open Time table.
  await finishAutoStop('t1', { expiredBooking: 0, startedAt: (await db.get('tables', 't1')).session.startedAt }, joy);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use'); // NOT freed — an ended Open Time table always waits for a real checkout
  assert.notEqual(t.session, null);
  assert.equal(t.session.ended, true); // still just "ended", exactly as End Session left it
}));

test('an Open Time table keeps running through every Set Hours payment action tried on it, in sequence', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 });
  advance(15 * MIN);
  await assert.rejects(payBooking('t1', { method: 'cash' }, joy), /Set Hours booking/);
  await assert.rejects(extendSession('t1', 15 * MIN, { payNow: true, method: 'cash', user: joy }), /prepaid/);
  advance(10 * MIN);
  let t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use');
  assert.equal(t.session.ended, false);
  assert.equal(elapsedMs(t), 25 * MIN); // the clock never stopped through any of the above
}));

test('cancel game on Open Time never refunds (nothing was ever prepaid) and behaves exactly as before', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 }); // Open Time
  advance(1 * MIN); // inside the 5-minute cancel window
  const result = await cancelGame('t1', { reason: 'Customer decided not to play' }, joy);
  assert.equal(result.refunded, false);
  assert.equal(result.refundAmount, 0);
  const t = await db.get('tables', 't1');
  assert.equal(t.session.prepaid, undefined); // cancelling never invents a prepaid marker
}));

test('Stop & Bill (completeCheckout) on Open Time still ends and frees the table exactly as before — this IS the intended payment action for Open Time', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 0 }); // Open Time
  advance(75 * MIN); // past the first hour: ₱200 + one ₱50 bracket
  const sale = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(sale.durationMs, 75 * MIN);
  assert.equal(sale.tableFee, tableFee(75 * MIN)); // calculateBilliardBill() logic unchanged
  assert.equal(sale.mode, 'open');
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'available'); // freed — this is Stop & Bill, the only way Open Time ever pays
  assert.equal(t.session, null);
}));

/* ---------------- unified Complete Transaction: one button, pays without ending Set Hours ----------------
 * "Stop & Bill" as a name coupling payment with ending the session was the actual mistake (per the
 * cashier's own report of Table 3 ending right after paying): there is no separate "Pay booking now"
 * button any more. completeCheckout() itself now pays a still-running Set Hours booking without
 * ending it; only auto-stop reaching the booked time, or explicit endSession(), ever ends one.
 */

test('completeCheckout on a running Set Hours booking pays without ending it — no separate button needed', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  advance(9 * MIN); // Table 3's exact report: pay a few minutes into a 1h booking
  const sale = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(sale.tableFee, 200);
  assert.equal(sale.total, 200);
  assert.equal(sale.kind, 'prepay');
  assert.equal(sale.endedAt, null); // nothing was stopped
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use'); // still occupied
  assert.equal(t.session.ended, false); // clock still running — this was the regression
  assert.equal(paidFee(t.session), 200);
  assert.equal(balanceDue(t.session), 0);
}));

test('completeCheckout on a running 2h booking charges the full booked length, not just the few seconds played — what is shown must match what is charged', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 120 * MIN });
  advance(13 * 1000); // paid 13 seconds in — the flat first-hour rate must not undercharge a 2h booking
  const t0 = await db.get('tables', 't1');
  // What the checkout screen displays must equal what paying actually charges (the bug this guards
  // against: showing ₱200 — the elapsed-time rate — while a 2h booking should charge ₱400).
  assert.equal(dueTableFee(t0.session, elapsedMs(t0)), 400);
  const sale = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(sale.tableFee, 400);
  assert.equal(sale.total, 400);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use');
  assert.equal(t.session.ended, false);
}));

test('completeCheckout on a running booking with items on the bill settles the balance and the items together, then clears the bill, still without ending', () => withClock(1_700_000_000_000, async () => {
  await freshTable();
  await db.set('products', 'water', { name: 'Water', category: 'Beverages', price: 20, stock: 5 });
  await startSession('t1', joy, { booking: 60 * MIN });
  await changeItem('t1', 'water', 2); // 2 waters, ₱40
  const sale = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(sale.tableFee, 200);
  assert.equal(sale.productTotal, 40);
  assert.equal(sale.total, 240);
  assert.equal((await db.get('products', 'water')).stock, 3); // stock deducted
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use');
  assert.equal(t.session.ended, false);
  assert.deepEqual(t.session.items, []); // items settled and cleared, not carried forward
}));

test('completeCheckout again once fully paid with nothing on the bill is a safe no-op — no duplicate charge, no receipt', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await completeCheckout('t1', { method: 'cash' }, joy); // pays ₱200
  advance(5 * MIN);
  const again = await completeCheckout('t1', { method: 'cash' }, joy);
  assert.equal(again.id, null);
  assert.equal(again.alreadyPaid, true);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'in_use');
  assert.equal(t.session.ended, false);
  assert.equal(paidFee(t.session), 200); // unchanged — no second charge
}));

test('after paying via completeCheckout, auto-stop still closes the table once the booked time is up', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await completeCheckout('t1', { method: 'cash' }, joy); // paid in full, no items
  const startedAt = (await db.get('tables', 't1')).session.startedAt;
  advance(60 * MIN);
  await finishAutoStop('t1', { expiredBooking: 60 * MIN, startedAt }, joy);
  const t = await db.get('tables', 't1');
  assert.equal(t.status, 'available'); // closes itself, exactly like the prior payBooking-based flow
  assert.equal(t.session, null);
}));

test('End Session is still the only way to end a running Set Hours booking early — Complete Transaction never does', () => withClock(1_700_000_000_000, async (advance) => {
  await freshTable();
  await startSession('t1', joy, { booking: 60 * MIN });
  await completeCheckout('t1', { method: 'cash' }, joy);
  advance(3 * MIN);
  let t = await db.get('tables', 't1');
  assert.equal(t.session.ended, false); // paying alone never ended it
  await endSession('t1');
  t = await db.get('tables', 't1');
  assert.equal(t.session.ended, true); // only the explicit End Session action does
}));
