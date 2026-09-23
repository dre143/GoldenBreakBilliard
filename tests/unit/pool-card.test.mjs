import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolCard } from '../../js/views/pool-card.js';
import { tableFee } from '../../js/billing.js';

// The card has no separate "overtime" colour or state: past the first hour (or the booked time) it just
// keeps showing the running bill and an "Extra time" readout, the same look as any other running table.
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const at = (m, s = 0) => m * MIN + s * 1000;

function renderAt(elapsed, session = {}) {
  const realNow = Date.now;
  Date.now = () => T0 + elapsed;
  try {
    return poolCard({ id: 't-02', name: 'Table 02', status: 'in_use', session: { startedAt: T0, ended: false, items: [], ...session } });
  } finally { Date.now = realNow; }
}
const classOf = (html) => (html.match(/<article class="([^"]*)"/) || [])[1] || '';
const noOvertimeClasses = (html) => !/\bpool--(overtime|approaching|threshold)\b/.test(classOf(html));

const cases = [
  // [minutes, seconds, fee] (1h booking or Open Time)
  [54, 59, 200],
  [55, 0, 200],
  [60, 0, 200],   // exactly 1:00:00: the hour is used up but not yet exceeded
  [60, 1, 200],   // past the hour, grace period still keeps the bill at ₱200
  [64, 30, 200],
  [65, 59, 200],
  [66, 0, 250],
  [76, 0, 250],
  [80, 59, 250],
  [81, 0, 300],
  [91, 0, 300],
  [95, 59, 300],
  [96, 0, 350],
];

for (const session of [{}, { plannedMs: 60 * MIN }]) {
  const mode = session.plannedMs ? 'Set Hours 1h' : 'Open Time';
  for (const [mm, ss, fee] of cases) {
    test(`${mode}: ${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')} → no overtime colour, ₱${fee}`, () => {
      const html = renderAt(at(mm, ss), session);
      assert.equal(tableFee(at(mm, ss)), fee, 'the billing engine agrees');
      assert.ok(noOvertimeClasses(html), 'never a pool--overtime/approaching/threshold class');
      assert.ok(html.includes(`₱${fee}.00`), `the same card shows the bill ₱${fee}.00`);
    });
  }
}

test('past the first hour (Open Time) or the booking (Set Hours), the readout switches to "Extra time"', () => {
  const open = renderAt(at(70));
  assert.match(open, /<dt[^>]*>Extra time<\/dt>/);
  assert.match(open, /\+00:10:00/);

  const booked = renderAt(at(70), { plannedMs: 60 * MIN });
  assert.match(booked, /<dt[^>]*>Extra time<\/dt>/);
  assert.match(booked, /\+00:10:00/);
});

test('before the threshold, the readout is "Rate" (Open Time) or "Time left" (Set Hours)', () => {
  const open = renderAt(at(30));
  assert.match(open, /<dt[^>]*>Rate<\/dt>/);

  const booked = renderAt(at(30), { plannedMs: 60 * MIN });
  assert.match(booked, /<dt[^>]*>Time left<\/dt>/);
});

test('a stopped clock or an idle table never carries an overtime class', () => {
  const stopped = renderAt(at(70), { ended: true, endedAt: T0 + at(70) });
  assert.ok(noOvertimeClasses(stopped));
  const idle = poolCard({ id: 't-03', name: 'Table 03', status: 'available', session: null });
  assert.ok(noOvertimeClasses(idle));
  assert.ok(!idle.includes('data-alert'));
});
