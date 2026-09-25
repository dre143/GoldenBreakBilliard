import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedMs, bookingEndsAt } from '../../js/billing.js';

// Exercise the real services against an isolated, in-memory demo backend.
globalThis.location = { search: '?demo' };
globalThis.self = { addEventListener() {} };
globalThis.localStorage = { getItem: () => '{}', setItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
const { db } = await import('../../js/db.js');
const { extendSession, endSession, completeCheckout } = await import('../../js/services.js');
const MIN = 60000;

test('long-wait Add time, exact auto-stop, repeated extension and checkout preserve played time and items', async () => {
  const originalNow = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  try {
    const startedAt = now - 12 * 60 * MIN;
    await db.set('products', 'water', { name: 'Water', price: 20, stock: 5 });
    await db.set('tables', 't1', { name: 'Table 1', status: 'in_use', session: {
      startedAt, ended: true, endedAt: startedAt + 60 * MIN - 1000, plannedMs: 60 * MIN,
      items: [{ productId: 'water', name: 'Water', price: 20, qty: 1 }],
    } });
    await extendSession('t1', 30 * MIN);
    let t = await db.get('tables', 't1');
    assert.equal(elapsedMs(t), 60 * MIN);
    assert.equal(bookingEndsAt(t.session), now + 30 * MIN);
    assert.equal(t.session.startedAt, startedAt);
    // An auto-stop from the previous booking must not stop the resumed session.
    await endSession('t1', { expiredBooking: 60 * MIN, startedAt });
    assert.equal((await db.get('tables', 't1')).session.ended, false);
    now += 30 * MIN + 850;
    await endSession('t1', { expiredBooking: 90 * MIN, startedAt });
    t = await db.get('tables', 't1');
    assert.equal(elapsedMs(t), 90 * MIN);
    now += 2 * 60 * MIN;
    await extendSession('t1', 30 * MIN);
    now += 30 * MIN + 1500;
    await endSession('t1', { expiredBooking: 120 * MIN, startedAt });
    const sale = await completeCheckout('t1', { method: 'cash' }, { uid: 'joy', name: 'Joy' });
    assert.equal(sale.durationMs, 120 * MIN);
    assert.equal(sale.tableFee, 400);
    assert.equal(sale.total, 420);
    assert.equal((await db.get('products', 'water')).stock, 4);
    assert.equal((await db.get('tables', 't1')).status, 'available');
  } finally {
    Date.now = originalNow;
  }
});
