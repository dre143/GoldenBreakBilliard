import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canExtendEndedSession } from '../../js/billing.js';
import { poolCard } from '../../js/views/pool-card.js';

const session = { startedAt: 1000, endedAt: 3601000, plannedMs: 3600000, ended: true, items: [] };
test('only expired, non-cancelled timed sessions can continue', () => {
  assert.equal(canExtendEndedSession(session), true);
  for (const s of [null, { ...session, ended: false }, { ...session, plannedMs: 0 },
    { ...session, endedAt: 3600999 }, { ...session, cancelled: {} }]) {
    assert.equal(canExtendEndedSession(s), false);
  }
});
test('expired table card says Session ended', () => {
  const html = poolCard({ id: 't1', name: 'Table 1', status: 'in_use', session });
  assert.match(html, /Session ended/);
  assert.doesNotMatch(html, /Clock Stopped/);
});
