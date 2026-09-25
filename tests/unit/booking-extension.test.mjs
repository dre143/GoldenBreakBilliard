import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canExtendEndedSession } from '../../js/billing.js';
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
