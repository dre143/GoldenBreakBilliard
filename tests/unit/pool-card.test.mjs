import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolCard, billingAlertInner, billingClass, BILLING_ALERT_TEXT } from '../../js/views/pool-card.js';
import { tableFee } from '../../js/billing.js';

// The table card turns red for overtime measured from the BOOKED time, whatever the grace period does to the bill.
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
const red = (html) => /\bpool--threshold\b/.test(classOf(html));
const yellow = (html) => /\bpool--approaching\b/.test(classOf(html));

const cases = [
  // [minutes, seconds, red?, yellow?, fee]  (1h booking or Open Time)
  [54, 59, false, false, 200],
  [55, 0, false, true, 200],
  [60, 0, false, true, 200],   // exactly 1:00:00: the hour is used up but not yet exceeded
  [60, 1, true, false, 200],   // overtime → red, and the grace period still keeps the bill at ₱200
  [64, 30, true, false, 200],
  [65, 59, true, false, 200],
  [66, 0, true, false, 250],
  [76, 0, true, false, 250],   // stays red while the next step is near
  [80, 59, true, false, 250],
  [81, 0, true, false, 300],
  [91, 0, true, false, 300],
  [95, 59, true, false, 300],
  [96, 0, true, false, 350],
];

for (const session of [{}, { plannedMs: 60 * MIN }]) {
  const mode = session.plannedMs ? 'Set Hours 1h' : 'Open Time';
  for (const [mm, ss, isRed, isYellow, fee] of cases) {
    test(`${mode}: ${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')} → ${isRed ? 'RED' : isYellow ? 'yellow' : 'normal'}, ₱${fee}`, () => {
      const html = renderAt(at(mm, ss), session);
      assert.equal(tableFee(at(mm, ss)), fee, 'the billing engine agrees');
      assert.equal(red(html), isRed, 'red');
      assert.equal(yellow(html), isYellow, 'yellow');
      assert.ok(html.includes(`₱${fee}.00`), `the same card shows the bill ₱${fee}.00`);
      assert.doesNotMatch(html, /pool--(approaching|threshold)[^"]*pool--(approaching|threshold)/, 'never both at once');
    });
  }
}

test('a 2h booking stays normal well past the first hour, goes red only after 2:00:00', () => {
  const two = { plannedMs: 120 * MIN };
  assert.ok(!red(renderAt(at(90), two)) && !yellow(renderAt(at(90), two)));
  assert.ok(yellow(renderAt(at(117), two)));
  assert.ok(red(renderAt(at(125, 59), two)));
  assert.ok(renderAt(at(125, 59), two).includes('₱400.00'), 'red, yet the grace period still bills ₱400');
  assert.ok(renderAt(at(126), two).includes('₱450.00'));
  assert.ok(red(renderAt(at(126), two)));
});

test('a stopped clock or an idle table has no overtime colour', () => {
  const stopped = renderAt(at(70), { ended: true, endedAt: T0 + at(70) });
  assert.ok(!red(stopped) && !yellow(stopped));
  const idle = poolCard({ id: 't-03', name: 'Table 03', status: 'available', session: null });
  assert.ok(!idle.includes('data-alert'));
});

test('no text banner is drawn; the state is screen-reader text only', () => {
  const html = renderAt(at(70));
  assert.doesNotMatch(html, /pool__alert-line|pool__alert-dot/);
  assert.match(html, /<span class="sr-only">|class="pool__alert pool__alert--reached"[^>]*>OVERTIME</);
  assert.equal(billingAlertInner('reached'), 'OVERTIME');
  assert.equal(billingAlertInner('approaching'), 'APPROACHING OVERTIME');
  assert.equal(billingAlertInner('normal'), '');
  assert.deepEqual(BILLING_ALERT_TEXT.reached, ['OVERTIME']);
  assert.equal(billingClass('reached'), 'pool--threshold');
  assert.equal(billingClass('approaching'), 'pool--approaching');
});
