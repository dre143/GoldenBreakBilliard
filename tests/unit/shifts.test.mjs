// Day/Night shift and business-day rules, checked in hall time (UTC+8) and independent of the device's time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../js/reporting.js';

const at = (y, mo, d, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);

test('exact boundaries: 5:59:59 AM / 6:00:00 AM and 5:59:59 PM / 6:00:00 PM', () => {
  const cases = [
    [at(2026, 9, 19, 5, 59, 59), '2026-09-18', 'night'],
    [at(2026, 9, 19, 6, 0, 0), '2026-09-19', 'day'],
    [at(2026, 9, 19, 17, 59, 59), '2026-09-19', 'day'],
    [at(2026, 9, 19, 18, 0, 0), '2026-09-19', 'night'],
    [at(2026, 9, 20, 0, 30, 0), '2026-09-19', 'night'],
    [at(2026, 9, 20, 5, 59, 59), '2026-09-19', 'night'],
    [at(2026, 9, 20, 6, 0, 0), '2026-09-20', 'day'],
  ];
  for (const [ts, key, shift] of cases) {
    assert.equal(r.dayKey(ts), key, `dayKey at ${new Date(ts).toISOString()}`);
    assert.equal(r.shiftOf(ts), shift, `shiftOf at ${new Date(ts).toISOString()}`);
  }
});

test('every instant is in exactly one shift, and Day + Night always equals the Full day', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 5000; i++) {
    const ts = at(2026, 9, 1, 0) + Math.floor(rnd() * 31 * 86_400_000);
    const key = r.dayKey(ts);
    const inRange = (shift) => { const [a, b] = r.shiftRange(key, shift); return ts >= a && ts < b; };
    assert.ok(inRange('full'));
    assert.notEqual(inRange('day'), inRange('night'), 'in exactly one shift');
    assert.equal(inRange('day') ? 'day' : 'night', r.shiftOf(ts));
  }
  for (let d = 1; d <= 30; d++) {
    const key = `2026-09-${String(d).padStart(2, '0')}`;
    const [fs, fe] = r.shiftRange(key, 'full');
    const [ds, de] = r.shiftRange(key, 'day');
    const [ns, ne] = r.shiftRange(key, 'night');
    assert.deepEqual([ds, de === ns, ne], [fs, true, fe], `${key}: no gap and no overlap`);
    assert.equal(fe - fs, 86_400_000, 'a business day is 24 hours');
  }
});

test('sales and expenses are split by shift with nothing lost or counted twice', () => {
  const sale = (createdAt, cash, gcash = 0, cashierId = 'a') => ({
    createdAt, cashierId, cashierName: cashierId, method: 'cash', total: cash + gcash, tableFee: cash + gcash, productTotal: 0, payments: { cash, gcash }, items: [],
  });
  const key = '2026-09-19';
  const txs = [
    sale(at(2026, 9, 19, 9), 200), sale(at(2026, 9, 19, 17, 59, 59), 300, 100),
    sale(at(2026, 9, 19, 18, 0, 0), 500), sale(at(2026, 9, 20, 1), 250, 50, 'b'), sale(at(2026, 9, 20, 5, 59, 59), 100),
  ];
  const expenses = [
    { createdAt: at(2026, 9, 19, 12), amount: 40, cashierId: 'a', cashierName: 'a' },
    { createdAt: at(2026, 9, 20, 2), amount: 60, cashierId: 'b', cashierName: 'b' },
  ];
  const within = (shift, list) => { const [a, b] = r.shiftRange(key, shift); return list.filter((x) => x.createdAt >= a && x.createdAt < b); };
  const totalsFor = (shift) => r.totals(within(shift, txs), within(shift, expenses));
  const day = totalsFor('day');
  const night = totalsFor('night');
  const full = totalsFor('full');

  assert.deepEqual([day.count, night.count, full.count], [2, 3, 5]);
  assert.equal(day.total + night.total, full.total);
  assert.equal(day.cash + night.cash, full.cash);
  assert.equal(day.gcash + night.gcash, full.gcash);
  assert.equal(day.expenses + night.expenses, full.expenses);
  // Cash to count = cash collected − expenses, per shift.
  assert.equal(day.cashToCount, 500 - 40);
  assert.equal(night.cashToCount, 850 - 60);
  assert.equal(day.net, 600 - 40);
  assert.equal(night.net, 900 - 60);
});

test('shift results do not depend on the device time zone', async () => {
  // Re-run the boundary checks in child processes set to very different zones.
  const { execFileSync } = await import('node:child_process');
  const script = `
    import * as r from ${JSON.stringify(new URL('../../js/reporting.js', import.meta.url).href)};
    const at = (y, mo, d, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);
    const out = [at(2026,9,19,5,59,59), at(2026,9,19,6), at(2026,9,19,17,59,59), at(2026,9,19,18), at(2026,9,20,3)]
      .map((t) => r.dayKey(t) + ' ' + r.shiftOf(t)).join('|');
    console.log(out, r.keyLabel('2026-09-19'), r.keyToStart('2026-09-19'));`;
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz } }).toString().trim();
  const results = ['Asia/Manila', 'UTC', 'Pacific/Auckland', 'America/Los_Angeles'].map(run);
  for (const res of results) assert.equal(res, results[0], 'same answer in every time zone');
  assert.match(results[0], /^2026-09-18 night\|2026-09-19 day\|2026-09-19 day\|2026-09-19 night\|2026-09-19 night /);
});
