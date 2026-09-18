import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../js/reporting.js';

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('business day starts at 6:00 AM', () => {
  assert.equal(r.dayKey(at(2026, 9, 18, 1, 30)), '2026-09-17');
  assert.equal(r.dayKey(at(2026, 9, 18, 5, 59)), '2026-09-17');
  assert.equal(r.dayKey(at(2026, 9, 18, 6, 0)), '2026-09-18');
  assert.deepEqual(r.dayKeys('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  assert.equal(r.keyToStart('2026-09-17'), at(2026, 9, 17, 6));
});

test('totals, days, payment methods, shifts, products', () => {
  const txs = [
    { createdAt: at(2026, 9, 17, 20), cashierId: 'a', cashierName: 'Ann', method: 'cash', total: 300, tableFee: 200, productTotal: 100, payments: { cash: 300, gcash: 0 }, items: [{ productId: 'p', name: 'Beer', qty: 2, price: 50, total: 100 }], durationMs: 3_600_000, rounds: 2 },
    { createdAt: at(2026, 9, 18, 1), cashierId: 'a', cashierName: 'Ann', method: 'split', total: 500.5, tableFee: 500.5, productTotal: 0, payments: { cash: 200, gcash: 300.5 }, items: [] },
    { createdAt: at(2026, 9, 18, 15), cashierId: 'b', cashierName: 'Ben', method: 'card', total: 99.99, tableFee: 99.99, productTotal: 0, items: [{ productId: 'p', name: 'Beer', qty: 1, price: 50 }] },
  ];
  const t = r.totals(txs);
  assert.equal(t.total, 900.49);
  assert.equal(t.cash, 500);
  assert.equal(t.gcash, 300.5);
  assert.equal(t.other, 99.99);
  assert.deepEqual(r.byDay(txs, '2026-09-16', '2026-09-18').map((d) => [d.key, d.count, d.total]),
    [['2026-09-16', 0, 0], ['2026-09-17', 2, 800.5], ['2026-09-18', 1, 99.99]]);
  assert.equal(r.byMethod(txs).split.cash, 200);
  assert.deepEqual(r.byShift(txs).map((s) => [s.id, s.count, s.cash]), [['2026-09-18_b', 1, 0], ['2026-09-17_a', 2, 500]]);
  assert.equal(r.topProducts(txs)[0].qty, 3);
});

test('CSV escaping', () => {
  assert.equal(r.toCsv([['a', 'b,c'], ['say "hi"', null]]), 'a,"b,c"\r\n"say ""hi""",');
});

test('voidedSales / voidedTotals: the owner’s audit trail for waived table fees', () => {
  const txs = [
    { id: 'a', total: 30, tableFeeVoided: true, refundAmount: 200, tableFeeVoidedAt: 100 },
    { id: 'b', total: 500, tableFeeVoided: false },
    { id: 'c', total: 50, tableFeeVoided: true, refundAmount: 200, tableFeeVoidedAt: 300 },
  ];
  assert.deepEqual(r.voidedSales(txs).map((t) => t.id), ['c', 'a'], 'most recently voided first');
  assert.deepEqual(r.voidedTotals(txs), { count: 2, refunded: 400 });
  assert.deepEqual(r.voidedTotals([]), { count: 0, refunded: 0 });
});
