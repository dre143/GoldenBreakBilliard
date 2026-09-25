import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../js/billing.js';
import * as r from '../../js/reporting.js';

const MIN = 60_000;
const SEC = 1_000;
const m = (minutes, seconds = 0) => minutes * MIN + seconds * SEC;
const fee = (minutes, seconds = 0) => b.tableFee(m(minutes, seconds));

test('five minutes of grace ends at 1:05:00; saved six-minute pricing stays readable', () => {
  assert.equal(b.tableFee(m(65) - 1), 200);
  assert.equal(b.tableFee(m(65)), 250);
  assert.equal(b.tableFee(m(80) - 1), 250);
  assert.equal(b.tableFee(m(80)), 300);
  const savedPricing = { ...b.PRICING, firstExtraAtMinutes: 66 };
  assert.equal(b.tableFee(m(65), savedPricing), 200);
  assert.equal(b.tableFee(m(66), savedPricing), 250);
});

/* ---------------- the 5-minute grace period: every threshold, on exact seconds ---------------- */

test('owner’s 16 required thresholds (first hour, grace, then ₱50 every 15 minutes)', () => {
  const cases = [
    ['first hour', m(60), 200],
    ['1:00:00', m(60), 200],
    ['1:04:59 (last second of the grace)', m(64, 59), 200],
    ['1:05:00 (grace over)', m(65), 250],
    ['1:19:59', m(79, 59), 250],
    ['1:20:00', m(80), 300],
    ['1:34:59', m(94, 59), 300],
    ['1:35:00', m(95), 350],
    ['1:49:59', m(109, 59), 350],
    ['1:50:00', m(110), 400],
    ['2:04:59', m(124, 59), 400],
    ['2:05:00', m(125), 450],
    ['2:20:00', m(140), 500],
    ['2:35:00', m(155), 550],
    ['2:50:00', m(170), 600],
    ['3:05:00', m(185), 650],
  ];
  assert.equal(cases.length, 16);
  for (const [label, ms, expected] of cases) assert.equal(b.tableFee(ms), expected, `${label} should cost ₱${expected}`);
});

test('thresholds hold to the millisecond: one ms before is the old amount, the exact instant is the new one', () => {
  for (let k = 0; k < 12; k++) {
    const at = m(65) + k * m(15); // 1:05:00, 1:20:00, 1:35:00, ...
    assert.equal(b.tableFee(at - 1), 200 + k * 50, `1 ms before ${at / MIN} min`);
    assert.equal(b.tableFee(at), 250 + k * 50, `exactly ${at / MIN} min`);
    assert.equal(b.tableFee(at + m(14, 59)), 250 + k * 50, `still the same 14:59 later`);
  }
});

test('the old "ceil((d − 60) / 15) from minute 61" rule is gone', () => {
  assert.equal(fee(61), 200, 'inside the grace');
  assert.equal(fee(64), 200);
  assert.equal(fee(70), 250, 'the old rule would already say ₱250 at 1:01 and ₱300 at 1:16');
  assert.equal(fee(76), 250);
  assert.equal(fee(80), 300);
});

test('first hour is a flat ₱200, even for short sessions', () => {
  assert.equal(b.tableFee(0), 200);
  assert.equal(b.tableFee(m(5)), 200);
  assert.equal(b.tableFee(m(59, 59)), 200);
  assert.equal(b.tableFee(-5), 200, 'never below the first hour, even on bad input');
  assert.equal(b.tableFee(Number.NaN), 200);
});

test('long sessions keep the same pattern', () => {
  assert.equal(b.tableFee(m(65 + 15 * 20)), 200 + 21 * 50);
  assert.equal(b.tableFee(m(600)), 200 + (1 + Math.floor((600 - 65) / 15)) * 50);
});

test('one authoritative function: calculateBilliardBill, and the helpers only read from it', () => {
  const inGrace = b.calculateBilliardBill(m(64, 30));
  assert.equal(inGrace.fee, 200);
  assert.equal(inGrace.inGrace, true);
  assert.equal(inGrace.extraBrackets, 0);
  assert.equal(inGrace.graceEndsAtMs, m(65));
  assert.equal(inGrace.nextIncreaseAtMs, m(65));

  assert.equal(b.calculateBilliardBill(m(59, 59)).inGrace, false, 'the grace starts after the hour is used up');
  assert.equal(b.calculateBilliardBill(m(60)).inGrace, true);
  assert.equal(b.calculateBilliardBill(m(64, 59)).inGrace, true);
  assert.equal(b.calculateBilliardBill(m(65)).inGrace, false);
  assert.equal(b.calculateBilliardBill(m(65)).extraBrackets, 1);

  for (const ms of [0, m(59), m(60), m(64, 59), m(65), m(79, 59), m(80), m(125), m(400)]) {
    const bill = b.calculateBilliardBill(ms);
    assert.equal(b.tableFee(ms), bill.fee);
    assert.equal(b.extraBrackets(ms), bill.extraBrackets);
    assert.equal(b.nextIncreaseAt(ms), bill.nextIncreaseAtMs);
  }
});

test('breakdown and next-increase helpers', () => {
  assert.equal(b.extraBrackets(m(76)), 1);
  assert.equal(b.extraBrackets(m(80)), 2);
  assert.equal(b.feeBreakdown(m(59, 59)), '₱200 first hour');
  assert.match(b.feeBreakdown(m(63)), /grace period/);
  assert.equal(b.feeBreakdown(m(65)), '₱200 first hour + 1 × ₱50');
  assert.equal(b.feeBreakdown(m(80)), '₱200 first hour + 2 × ₱50');
  assert.equal(b.nextIncreaseAt(m(10)), m(65), 'the first ₱50 lands at 1:05:00');
  assert.equal(b.nextIncreaseAt(m(64, 59)), m(65));
  assert.equal(b.nextIncreaseAt(m(65)), m(80), 'at 1:05:00 the next step is 1:20:00');
  assert.equal(b.nextIncreaseAt(m(79, 59)), m(80));
  assert.equal(b.nextIncreaseAt(m(80)), m(95));
  assert.equal(b.tableFee(b.nextIncreaseAt(m(70))), b.tableFee(m(70)) + 50, 'the fee is exactly ₱50 higher at the announced instant');
});

test('sales saved before the grace period still read with the old rule (receipts stay accurate)', () => {
  const { firstExtraAtMinutes, ...legacy } = b.PRICING; // an old snapshot has no grace field
  assert.equal(b.tableFee(m(60), legacy), 200);
  assert.equal(b.tableFee(m(61), legacy), 250);
  assert.equal(b.tableFee(m(76), legacy), 300);
  assert.equal(b.tableFee(m(121), legacy), 450);
  assert.equal(b.feeBreakdown(m(76), legacy), '₱200 first hour + 2 × ₱50');
  assert.equal(b.calculateBilliardBill(m(61), legacy).inGrace, false);
  assert.equal(b.tableFee(m(61)), 200, 'while the same minute under today’s rate is ₱200');
});

/* ---------------- elapsed vs billable: the timer is never held back ---------------- */

test('elapsed time comes only from start/end stamps and is never altered by billing', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: false } }, t0 + m(70)), m(70));
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: true, endedAt: t0 + m(61) } }, t0 + m(500)), m(61), 'ended sessions are frozen');
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: false } }, t0 - 5000), 0, 'never negative');
  assert.equal(b.elapsedMs({ session: null }), 0);

  // Through the grace period the clock keeps counting while the bill holds at ₱200, then steps at 1:05:00.
  const table = { session: { startedAt: t0, ended: false, items: [] } };
  const at = (minutes, seconds) => t0 + m(minutes, seconds);
  assert.equal(b.elapsedMs(table, at(64, 30)), m(64, 30));
  assert.equal(b.currentBill(table, at(64, 30)), 200);
  assert.equal(b.elapsedMs(table, at(64, 59)), m(64, 59));
  assert.equal(b.currentBill(table, at(64, 59)), 200);
  assert.equal(b.elapsedMs(table, at(65, 0)), m(65), 'elapsed reads a true 1:05:00, not a frozen 1:00:00');
  assert.equal(b.currentBill(table, at(65, 0)), 250);
});

test('the table card: "Overtime +00:04:30 / Bill ₱200.00", then "+00:05:00 / ₱250.00"', () => {
  const t0 = 5_000_000;
  const open = { session: { startedAt: t0, ended: false, items: [] } };
  const card = (t, ms) => ({ over: b.overtimeMs(t.session, ms), bill: b.currentBill(t, t0 + ms), sess: b.billSession(t.session, ms) });

  // Open Time: overtime is the time past the first hour.
  const a = card(open, m(64, 30));
  assert.equal(a.sess.elapsedMs, m(64, 30));
  assert.equal(a.sess.inGrace, true);
  assert.equal(a.bill, 200);
  const c = card(open, m(65));
  assert.equal(c.bill, 250);
  assert.equal(c.sess.inGrace, false);

  // Set Hours: same billing, overtime is the time past the booking.
  const booked = { session: { startedAt: t0, ended: false, plannedMs: m(60), items: [] } };
  assert.equal(card(booked, m(64, 30)).over, m(4, 30));
  assert.equal(card(booked, m(64, 30)).bill, 200);
  assert.equal(card(booked, m(65)).over, m(5));
  assert.equal(card(booked, m(65)).bill, 250);
});

/* ---------------- Open Time vs Set Hours: the same central logic ---------------- */

test('Open Time and Set Hours agree at every moment: the booking never changes the amount', () => {
  for (let ms = 0; ms <= m(240); ms += 7 * SEC) {
    const open = b.billSession({ plannedMs: 0 }, ms);
    for (const planned of [m(30), m(75), m(120), m(180)]) {
      const booked = b.billSession({ plannedMs: planned }, ms);
      assert.equal(booked.tableFee, open.tableFee, `${ms / MIN} min played on a ${planned / MIN} min booking`);
      assert.equal(booked.tableFee, b.tableFee(ms));
      assert.equal(booked.billedMs, ms, 'billed time is the time played, not the booked time');
    }
  }
});

test('Open Time: billed on time actually played', () => {
  const open = { startedAt: 0, ended: false };
  assert.equal(b.isTimed(open), false);
  assert.equal(b.remainingMs(open, m(30)), null, 'open time has no countdown');
  assert.equal(b.billSession(open, m(45)).billedMs, m(45));
  assert.equal(b.billSession(open, m(45)).tableFee, 200);
  assert.equal(b.billSession(open, m(64, 59)).tableFee, 200);
  assert.equal(b.billSession(open, m(65)).tableFee, 250);
});

/* Booked (Set Hours) time is NOT billable time. Three separate things: booked duration, actual elapsed time and the
   billable amount, which comes from the actual elapsed time only. Unused booked time is never charged. */
const feeFor = (bookedMs, playedMs) => b.billSession({ startedAt: 0, ended: false, plannedMs: bookedMs }, playedMs).tableFee;

test('owner’s booked-vs-played cases: the customer pays for what was actually consumed', () => {
  const cases = [
    ['1h15 booked / 59 seconds', m(75), m(0, 59), 200],
    ['1h15 booked / 30 minutes', m(75), m(30), 200],
    ['1h15 booked / 59 minutes', m(75), m(59), 200],
    ['1h15 booked / 1h', m(75), m(60), 200],
    ['1h15 booked / 1h04', m(75), m(64), 200],
    ['1h15 booked / 1h04m59s', m(75), m(64, 59), 200],
    ['1h15 booked / 1h05', m(75), m(65), 250],
    ['1h15 booked / 1h15', m(75), m(75), 250],
    ['1h30 booked / 1h05', m(90), m(65), 250],
    ['1h30 booked / 1h30', m(90), m(90), 300],
    ['2h booked / 1h19', m(120), m(79), 250],
  ];
  assert.equal(cases.length, 11);
  for (const [label, booked, played, expected] of cases) {
    assert.equal(feeFor(booked, played), expected, `${label} → ₱${expected}`);
  }
});

test('booked time never causes an extra charge: fee is the same as an Open Time table played that long', () => {
  for (const booked of [m(15), m(60), m(75), m(90), m(120), m(180), m(600)]) {
    for (let played = 0; played <= m(300); played += 13 * SEC) {
      assert.equal(feeFor(booked, played), b.tableFee(played));
    }
  }
});

test('booked screenshot case: 00:00:59 played on 1h15 booked is ₱200, explained as the first hour only', () => {
  const s = b.billSession({ startedAt: 0, ended: false, plannedMs: m(75) }, m(0, 59));
  assert.equal(s.tableFee, 200);
  assert.equal(s.elapsedMs, m(0, 59));
  assert.equal(s.billedMs, m(0, 59));
  assert.equal(b.feeBreakdown(s.billedMs), '₱200 first hour', 'not "₱200 first hour + 1 × ₱50"');
  assert.equal(b.currentBill({ session: { startedAt: 0, ended: true, endedAt: m(0, 59), plannedMs: m(75), items: [] } }), 200);
  assert.equal(b.nextIncreaseAt(s.billedMs), m(65), 'the next step is counted on time played: ₱250 at 1:05:00');
});

test('Set Hours: the booking controls the countdown and overtime, not the amount', () => {
  const booked1h = { startedAt: 0, ended: false, plannedMs: m(60) };
  const booked2h = { startedAt: 0, ended: false, plannedMs: m(120) };

  assert.equal(b.isTimed(booked2h), true);
  // Stopped early: only the time played is billed.
  assert.equal(b.billSession(booked2h, m(45)).tableFee, 200);
  assert.equal(b.remainingMs(booked2h, m(45)), m(75));
  assert.equal(b.overtimeMs(booked2h, m(45)), 0);
  assert.equal(b.remainingMs(booked2h, m(120)), 0);

  // 1h booked: 4:59 over is inside the grace; exactly 5 minutes over is not.
  assert.equal(b.billSession(booked1h, m(64, 59)).tableFee, 200);
  assert.equal(b.billSession(booked1h, m(64, 59)).inGrace, true);
  assert.equal(b.billSession(booked1h, m(65)).tableFee, 250);

  // 2h booked, played to the end: 2:00:00 is ₱400; 2:04:59 still ₱400; 2:05:00 ₱450.
  assert.equal(b.billSession(booked2h, m(120)).tableFee, 400);
  assert.equal(b.billSession(booked2h, m(124, 59)).tableFee, 400);
  assert.equal(b.billSession(booked2h, m(125)).tableFee, 450);
  assert.equal(b.overtimeMs(booked2h, m(125)), m(5));
  assert.equal(b.billSession(booked2h, m(125)).billedMs, m(125));

  assert.equal(b.currentBill({ session: { startedAt: 0, ended: true, endedAt: m(45), plannedMs: m(120), items: [{ price: 85, qty: 1 }] } }), 285);
  assert.equal(b.currentBill({ session: { startedAt: 0, ended: true, endedAt: m(76), items: [{ price: 85, qty: 2 }] } }), 420);
});

/* ---------------- closing a session: the sale record ---------------- */

/** What completeCheckout stores, computed from the same central function (see js/services.js). */
function closeSession(session, itemsTotal = 0) {
  const durationMs = b.elapsedMs({ session });
  const { billedMs, tableFee } = b.billSession(session, durationMs);
  return { durationMs, billedMs, tableFee, total: tableFee + itemsTotal, pricing: { ...b.PRICING } };
}

test('closing a session: a stopped clock is frozen and billed by the same rule', () => {
  const start = 1_000_000;
  const ended = (minutes, seconds, extra = {}) => ({ startedAt: start, ended: true, endedAt: start + m(minutes, seconds), items: [], ...extra });

  // Staff can’t make time pass: the stopped clock reads exactly what the server stamped.
  const late = closeSession(ended(64, 59));
  assert.equal(late.durationMs, m(64, 59));
  assert.equal(late.tableFee, 200);
  assert.equal(closeSession(ended(65)).tableFee, 250);
  assert.equal(closeSession(ended(65)).durationMs, m(65), 'the stored duration is the true elapsed time');
  assert.equal(closeSession(ended(65, 0), 85).total, 335);

  // Booked: billed on the time actually played; the booking is only stored for reference.
  const b2 = closeSession(ended(124, 59, { plannedMs: m(120) }));
  assert.equal(b2.durationMs, m(124, 59));
  assert.equal(b2.billedMs, m(124, 59));
  assert.equal(b2.tableFee, 400);
  assert.equal(closeSession(ended(125, 0, { plannedMs: m(120) })).tableFee, 450);
  assert.equal(closeSession(ended(20, 0, { plannedMs: m(120) })).tableFee, 200, 'ended early: the unused booked time is not charged');
  const early = closeSession(ended(0, 59, { plannedMs: m(75) }), 0);
  assert.equal(early.durationMs, m(0, 59), 'actual duration is stored');
  assert.equal(early.billedMs, m(0, 59));
  assert.equal(early.tableFee, 200);
  assert.equal(early.total, 200);

  // A cancelled game has no table fee whatever its time.
  const cancelled = closeSession(ended(3, 0, { cancelled: { reason: 'x' } }));
  assert.equal(cancelled.tableFee, 0);
  assert.equal(cancelled.billedMs, cancelled.durationMs);

  // New sales carry the new pricing snapshot; that snapshot reproduces the stored fee on a receipt.
  const sale = closeSession(ended(65));
  assert.equal(sale.pricing.firstExtraAtMinutes, 65);
  assert.equal(b.tableFee(sale.billedMs, sale.pricing), sale.tableFee);
});

test('one customer, one session, one transaction: the grace is not transferable time', () => {
  // Restarting after the hour just starts a new session, which pays its own first-hour ₱200.
  const first = closeSession({ startedAt: 0, ended: true, endedAt: m(64, 59), items: [] });
  const second = closeSession({ startedAt: 0, ended: true, endedAt: m(20), items: [] });
  assert.equal(first.tableFee, 200);
  assert.equal(second.tableFee, 200, 'a new session never inherits leftover grace minutes');
  assert.equal(first.tableFee + second.tableFee, 400);
  // …and the same 85:59 as one continuous session would cost ₱300, so the grace can't be stretched into a free extra game.
  assert.equal(b.tableFee(m(64, 59) + m(20)), 300);
});

/* ---------------- receipts, history, dashboard, reports: they read what was stored ---------------- */

test('receipt: breakdown uses the sale’s own pricing snapshot, old or new', () => {
  const newSale = { billedMs: m(64, 30), durationMs: m(64, 30), tableFee: 200, pricing: { ...b.PRICING } };
  assert.match(b.feeBreakdown(newSale.billedMs, newSale.pricing), /grace period/);
  const newer = { billedMs: m(80), tableFee: 300, pricing: { ...b.PRICING } };
  assert.equal(b.feeBreakdown(newer.billedMs, newer.pricing), '₱200 first hour + 2 × ₱50');

  const { firstExtraAtMinutes, ...oldPricing } = b.PRICING;
  const oldSale = { billedMs: m(76), tableFee: 300, pricing: oldPricing };
  assert.equal(b.tableFee(oldSale.billedMs, oldSale.pricing), oldSale.tableFee, 'an old ₱300 receipt still reproduces');
  assert.equal(b.feeBreakdown(oldSale.billedMs, oldSale.pricing), '₱200 first hour + 2 × ₱50');
});

test('history, dashboard and reports add up the stored fees (old and new sales together)', () => {
  const at = (h) => new Date(2026, 8, 22, h).getTime();
  const txs = [
    { id: 'old', createdAt: at(10), cashierId: 'a', cashierName: 'Ann', method: 'cash', tableFee: 300, productTotal: 0, total: 300, payments: { cash: 300, gcash: 0 }, items: [], durationMs: m(76), pricing: { basePrice: 200, baseMinutes: 60, bracketMinutes: 15, bracketPrice: 50 } },
    { id: 'grace', createdAt: at(11), cashierId: 'a', cashierName: 'Ann', method: 'cash', tableFee: 200, productTotal: 0, total: 200, payments: { cash: 200, gcash: 0 }, items: [], durationMs: m(64, 59), pricing: { ...b.PRICING } },
    { id: 'after', createdAt: at(12), cashierId: 'b', cashierName: 'Ben', method: 'gcash', tableFee: 250, productTotal: 85, total: 335, payments: { cash: 0, gcash: 335 }, items: [{ productId: 'p', name: 'Beer', qty: 1, price: 85, total: 85 }], durationMs: m(65), pricing: { ...b.PRICING } },
  ];
  const t = r.totals(txs);
  assert.equal(t.count, 3);
  assert.equal(t.tableFee, 750, 'reports never recompute: 300 (old) + 200 (grace) + 250');
  assert.equal(t.productTotal, 85);
  assert.equal(t.total, 835);
  assert.equal(t.cash, 500);
  assert.equal(t.gcash, 335);

  const day = r.byDay(txs, r.dayKey(at(10)), r.dayKey(at(10)))[0];
  assert.equal(day.total, 835, 'dashboard / daily sheet revenue');
  assert.equal(r.byMethod(txs).gcash.total, 335);
  assert.equal(r.byShift(txs).find((row) => row.cashierId === 'a').tableFee, 500);
  assert.equal(r.totals(txs, [{ amount: 35 }]).net, 800);
});
test('cancel game: only within the first 5 minutes, running or stopped, and only once', () => {
  const start = 1_000_000;
  const running = (session = {}) => ({ session: { startedAt: start, ended: false, endedAt: null, items: [], ...session } });
  const at = (ms) => start + ms;

  assert.equal(b.canCancelGame(running(), at(5 * 60_000)), true, 'exactly 5 minutes is still allowed');
  assert.equal(b.canCancelGame(running(), at(5 * 60_000 + 1)), false, '1 ms over 5 minutes is not');
  assert.equal(b.cancelTimeLeft(running(), at(60_000)), 4 * 60_000);
  assert.equal(b.cancelTimeLeft(running(), at(9 * 60_000)), 0);

  // A stopped clock is judged on the time actually played, however long ago it was stopped.
  const stopped = running({ ended: true, endedAt: at(3 * 60_000) });
  assert.equal(b.canCancelGame(stopped, at(60 * 60_000)), true);
  assert.equal(b.canCancelGame(running({ ended: true, endedAt: at(6 * 60_000) }), at(6 * 60_000)), false);

  assert.equal(b.canCancelGame(running({ cancelled: { reason: 'x' } }), at(60_000)), false, 'only once');
  assert.equal(b.canCancelGame({ session: null }, at(0)), false);
  assert.equal(b.canCancelGame(null, at(0)), false);

  // A cancelled game has no table fee; items stay on the bill.
  const cancelled = { session: { startedAt: start, ended: true, endedAt: at(2 * 60_000), cancelled: { reason: 'x' }, items: [{ price: 30, qty: 2 }] } };
  assert.equal(b.sessionFee(cancelled.session, 2 * 60_000), 0);
  assert.equal(b.currentBill(cancelled, at(2 * 60_000)), 60);
  assert.equal(b.sessionFee({ plannedMs: 0 }, 2 * 60_000), 200, 'a normal short game still pays the first hour');

  assert.deepEqual(b.activeSales([{ id: 1 }, { id: 2, voided: true }]).map((x) => x.id), [1]);
});

/* ---------------- overtime colour on the table card: follows the BOOKED time; the grace period only affects the bill ---------------- */

const stateAt = (session, minutes, seconds = 0) => b.billingStatus(session, m(minutes, seconds)).state;
const open = { startedAt: 0, ended: false, items: [] };
const booked30 = { ...open, plannedMs: m(30) };
const booked1h = { ...open, plannedMs: m(60) };
const booked2h = { ...open, plannedMs: m(120) };

test('overtime starts at the booked time (Set Hours) or the first hour (Open Time)', () => {
  assert.equal(b.overtimeStartMs(open), m(60));
  assert.equal(b.overtimeStartMs(booked1h), m(60));
  assert.equal(b.overtimeStartMs(booked2h), m(120));
  assert.equal(b.overtimeStartMs(booked30), m(30));
});

test('red the moment the booked time is used up, while the grace period keeps the bill at ₱200', () => {
  for (const session of [open, booked1h]) {
    assert.equal(stateAt(session, 59, 59), 'approaching');
    assert.equal(stateAt(session, 60), 'approaching', 'exactly 1:00:00 is not yet overtime');
    assert.equal(b.billingStatus(session, m(60) + 1).state, 'reached', '1 ms past the hour is overtime');
    // 1:00:01 - 1:04:59: red, and the grace still applies (bill ₱200, no new charge yet).
    for (const [mm, ss] of [[60, 1], [62, 30], [64, 30], [64, 59]]) {
      const s = b.billingStatus(session, m(mm, ss));
      assert.equal(s.state, 'reached', `${mm}:${ss} is red`);
      assert.equal(s.tableFee, 200, `${mm}:${ss} is still ₱200 (grace)`);
      assert.equal(s.inGrace, true);
    }
    // 1:05:00: the first ₱50, still red.
    assert.equal(stateAt(session, 65), 'reached');
    assert.equal(b.billingStatus(session, m(65)).tableFee, 250);
  }
});

test('once in overtime the card stays red for the rest of the session (never back to yellow)', () => {
  for (const session of [open, booked30, booked1h, booked2h]) {
    const start = b.overtimeStartMs(session);
    for (let ms = start + 1; ms <= m(400); ms += 500) {
      assert.equal(b.billingStatus(session, ms).state, 'reached', `${ms / MIN} min is red`);
    }
  }
  // The fee steps (1:20:00, 1:35:00, ...) don't change the colour: it is red just before and just after each.
  for (const at of [m(65), m(80), m(95), m(110), m(125)]) {
    assert.equal(b.billingStatus(open, at - 1).state, 'reached');
    assert.equal(b.billingStatus(open, at).state, 'reached');
  }
});

test('grace-period billing is unchanged by the colour rule (same fees at every threshold)', () => {
  const fees = [[60, 0, 200], [64, 59, 200], [65, 0, 250], [79, 59, 250], [80, 0, 300], [94, 59, 300], [95, 0, 350], [109, 59, 350], [110, 0, 400], [124, 59, 400], [125, 0, 450]];
  for (const [mm, ss, fee] of fees) {
    assert.equal(b.billingStatus(open, m(mm, ss)).tableFee, fee);
    assert.equal(b.tableFee(m(mm, ss)), fee);
  }
});

test('a 2h booking: yellow in the last 5 minutes, red after 2:00:00, bill steps up at 2:05:00', () => {
  assert.equal(stateAt(booked2h, 90), 'normal');
  assert.equal(stateAt(booked2h, 114, 59), 'normal');
  assert.equal(stateAt(booked2h, 115), 'approaching');
  assert.equal(stateAt(booked2h, 120), 'approaching');
  assert.equal(b.billingStatus(booked2h, m(120) + 1).state, 'reached');
  assert.equal(b.billingStatus(booked2h, m(124, 59)).tableFee, 400, 'grace: still the booked ₱400');
  assert.equal(stateAt(booked2h, 124, 59), 'reached');
  assert.equal(b.billingStatus(booked2h, m(125)).tableFee, 450);
  assert.equal(stateAt(booked2h, 125), 'reached');
});

test('a booking shorter than the hour goes red at its own end; the flat ₱200 still holds', () => {
  assert.equal(stateAt(booked30, 25), 'approaching');
  assert.equal(stateAt(booked30, 29, 59), 'approaching');
  assert.equal(stateAt(booked30, 31), 'reached');
  assert.equal(b.billingStatus(booked30, m(31)).tableFee, 200);
  assert.equal(b.billingStatus(booked30, m(64, 59)).tableFee, 200);
  assert.equal(b.billingStatus(booked30, m(65)).tableFee, 250);
});

test('status: normal early on; stopped or cancelled clocks show nothing', () => {
  assert.equal(stateAt(open, 0), 'normal');
  assert.equal(stateAt(open, 30), 'normal');
  assert.equal(stateAt(open, 54, 59), 'normal');
  assert.equal(stateAt(open, 55), 'approaching');
  assert.equal(b.billingStatus({ ...open, ended: true, endedAt: m(70) }, m(70)).state, 'normal');
  assert.equal(b.billingStatus({ ...open, cancelled: { reason: 'x' } }, m(70)).state, 'normal');
  assert.equal(b.billingStatus(null, m(70)).state, 'normal');
});
