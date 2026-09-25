import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canExtendEndedSession, elapsedMs, bookingEndsAt } from '../../js/billing.js';
import { poolCard } from '../../js/views/pool-card.js';

const session = { startedAt: 1000, endedAt: 3601000, plannedMs: 3600000, ended: true, items: [] };
test('only expired, non-cancelled timed sessions can continue', () => {
  assert.equal(canExtendEndedSession(session), true);
  for (const s of [null, { ...session, ended: false }, { ...session, plannedMs: 0 },
    { ...session, endedAt: 3598999 }, { ...session, cancelled: {} }]) {
    assert.equal(canExtendEndedSession(s), false);
  }
});
test('auto-stop just before the booking boundary still offers Add time', () => {
  for (const earlyMs of [1, 1000, 1999, 2000]) {
    assert.equal(canExtendEndedSession({ ...session, endedAt: session.endedAt - earlyMs }), true);
  }
});
test('expired table card says Session ended', () => {
  const html = poolCard({ id: 't1', name: 'Table 1', status: 'in_use', session });
  assert.match(html, /Session ended/);
  assert.doesNotMatch(html, /Clock Stopped/);
});

test('legacy 59:59 auto-stop displays exactly one hour', () => {
  const s = { ...session, endedAt: session.endedAt - 1000 };
  assert.equal(elapsedMs({ session: s }), 3600000);
  assert.match(poolCard({ id: 't1', name: 'Table 1', status: 'in_use', session: s }), />01:00:00</);
});

test('added time starts at resume, excluding the waiting gap across repeated extensions', () => {
  const resumedAt = session.endedAt + 10 * 3600000;
  const s = { ...session, ended: false, endedAt: null, resumedAt, elapsedBeforeResume: 3600000, plannedMs: 5400000 };
  assert.equal(elapsedMs({ session: s }, resumedAt), 3600000);
  assert.equal(bookingEndsAt(s), resumedAt + 1800000);
  assert.equal(elapsedMs({ session: s }, resumedAt + 60000), 3660000);
  const ended = { ...s, ended: true, endedAt: bookingEndsAt(s) };
  assert.equal(elapsedMs({ session: ended }), 5400000);
  assert.equal(canExtendEndedSession(ended), true);
  const again = { ...ended, ended: false, endedAt: null, resumedAt: resumedAt + 20 * 3600000, elapsedBeforeResume: 5400000, plannedMs: 7200000 };
  assert.equal(bookingEndsAt(again) - again.resumedAt, 1800000);
});
