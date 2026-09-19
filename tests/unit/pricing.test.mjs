import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../js/billing.js';

const MIN = 60_000;
const SEC = 1_000;
const m = (minutes, seconds = 0) => minutes * MIN + seconds * SEC;

test('owner’s required examples', () => {
  const cases = [
    ['1 hour', m(60), 200],
    ['1 hour 1 minute', m(61), 250],
    ['1 hour 10 minutes', m(70), 250],
    ['1 hour 15 minutes', m(75), 250],
    ['1 hour 16 minutes', m(76), 300],
    ['1 hour 30 minutes', m(90), 300],
    ['1 hour 31 minutes', m(91), 350],
    ['1 hour 45 minutes', m(105), 350],
    ['1 hour 46 minutes', m(106), 400],
    ['2 hours', m(120), 400],
    ['2 hours 1 minute', m(121), 450],
  ];
  for (const [label, ms, fee] of cases) assert.equal(b.tableFee(ms), fee, `${label} should cost ₱${fee}`);
});

test('first hour is a flat ₱200, even for short sessions', () => {
  assert.equal(b.tableFee(0), 200);
  assert.equal(b.tableFee(m(5)), 200);
  assert.equal(b.tableFee(m(59, 59)), 200);
});

test('partial brackets always round UP, never to the nearest', () => {
  assert.equal(b.tableFee(m(60) + 1), 250, '1 ms past the hour starts a bracket');
  assert.equal(b.tableFee(m(60, 30)), 250);
  assert.equal(b.tableFee(m(67, 29)), 250, 'nearest-15 rounding would give ₱200');
  assert.equal(b.tableFee(m(75) + 1), 300);
  assert.equal(b.tableFee(m(82, 31)), 300, 'nearest-15 rounding would give ₱350');
  assert.equal(b.tableFee(m(180)), 600);
  assert.equal(b.tableFee(m(180) + 1), 650);
  assert.equal(b.tableFee(m(600)), 200 + 36 * 50);
});

test('breakdown and next-increase helpers', () => {
  assert.equal(b.extraBrackets(m(76)), 2);
  assert.equal(b.feeBreakdown(m(60)), '₱200 first hour');
  assert.equal(b.feeBreakdown(m(76)), '₱200 first hour + 2 × ₱50');
  assert.equal(b.nextIncreaseAt(m(10)), m(60));
  assert.equal(b.nextIncreaseAt(m(60)), m(60));
  assert.equal(b.nextIncreaseAt(m(61)), m(75));
  assert.equal(b.nextIncreaseAt(m(75)), m(75));
  assert.equal(b.nextIncreaseAt(m(75) + 1), m(90));
});

test('elapsed time comes only from start/end stamps', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: false } }, t0 + m(70)), m(70));
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: true, endedAt: t0 + m(61) } }, t0 + m(500)), m(61), 'ended sessions are frozen');
  assert.equal(b.elapsedMs({ session: { startedAt: t0, ended: false } }, t0 - 5000), 0, 'never negative');
  assert.equal(b.elapsedMs({ session: null }), 0);
  assert.equal(b.currentBill({ session: { startedAt: t0, ended: true, endedAt: t0 + m(76), items: [{ price: 85, qty: 2 }] } }), 470);
});

test('booked hours are a minimum charge; overtime is billed by the same rule', () => {
  const open = { startedAt: 0, ended: false };
  const booked2h = { startedAt: 0, ended: false, plannedMs: m(120) };

  assert.equal(b.isTimed(open), false);
  assert.equal(b.isTimed(booked2h), true);
  assert.equal(b.remainingMs(open, m(30)), null, 'open time has no countdown');

  // Stopped early: still pays for the 2 hours booked (₱400).
  assert.equal(b.billableMs(booked2h, m(45)), m(120));
  assert.equal(b.tableFee(b.billableMs(booked2h, m(45))), 400);
  assert.equal(b.remainingMs(booked2h, m(45)), m(75));
  assert.equal(b.overtimeMs(booked2h, m(45)), 0);

  // Exactly on time.
  assert.equal(b.billableMs(booked2h, m(120)), m(120));
  assert.equal(b.remainingMs(booked2h, m(120)), 0);

  // Overtime: 2h 1min played on a 2h booking → ₱450, same rounding-up rule.
  assert.equal(b.billableMs(booked2h, m(121)), m(121));
  assert.equal(b.tableFee(b.billableMs(booked2h, m(121))), 450);
  assert.equal(b.overtimeMs(booked2h, m(121)), m(1));

  // Open time is unaffected.
  assert.equal(b.billableMs(open, m(45)), m(45));
  assert.equal(b.tableFee(b.billableMs(open, m(45))), 200);

  assert.equal(b.currentBill({ session: { startedAt: 0, ended: true, endedAt: m(45), plannedMs: m(120), items: [{ price: 85, qty: 1 }] } }), 485);
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
