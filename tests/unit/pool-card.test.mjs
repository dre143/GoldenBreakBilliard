import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolCard, billingAlertInner, BILLING_ALERT_TEXT } from '../../js/views/pool-card.js';
import { tableFee } from '../../js/billing.js';

// The table card shows the billing status as words, from the same calculation as the bill.
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const at = (m, s = 0) => m * MIN + s * 1000;
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function renderAt(elapsed, session = {}) {
  const realNow = Date.now;
  Date.now = () => T0 + elapsed;
  try {
    return poolCard({ id: 't-02', name: 'Table 02', status: 'in_use', session: { startedAt: T0, ended: false, items: [], ...session } });
  } finally { Date.now = realNow; }
}

const APPROACHING = 'APPROACHING BILLING THRESHOLD';
const REACHED = 'BILLING THRESHOLD REACHED / OVERTIME';

const cases = [
  // [minutes, seconds, expected status, expected fee]
  [1 * 60 + 1, 0, 'approaching', 200],
  [1 * 60 + 5, 59, 'approaching', 200],
  [1 * 60 + 6, 0, 'reached', 250],
  [1 * 60 + 16, 0, 'approaching', 250],
  [1 * 60 + 20, 59, 'approaching', 250],
  [1 * 60 + 21, 0, 'reached', 300],
  [1 * 60 + 31, 0, 'approaching', 300],
  [1 * 60 + 35, 59, 'approaching', 300],
  [1 * 60 + 36, 0, 'reached', 350],
];

for (const session of [{}, { plannedMs: 60 * MIN }]) {
  const mode = session.plannedMs ? 'Set Hours 1h' : 'Open Time';
  for (const [mm, ss, state, fee] of cases) {
    test(`${mode}: 01:${String(mm - 60).padStart(2, '0')}:${String(ss).padStart(2, '0')} → ${state}, ₱${fee}`, () => {
      const html = renderAt(at(mm, ss), session);
      const words = text(html);
      assert.equal(tableFee(at(mm, ss)), fee, 'the billing engine agrees');
      if (state === 'approaching') {
        assert.ok(words.includes(APPROACHING), 'card says APPROACHING BILLING THRESHOLD');
        assert.ok(!words.includes('REACHED'), 'and not REACHED');
        assert.match(html, /pool--approaching/);
        assert.doesNotMatch(html, /pool--threshold/);
      } else {
        assert.ok(words.includes(REACHED), 'card says BILLING THRESHOLD REACHED / OVERTIME');
        assert.ok(!words.includes('APPROACHING'), 'and not APPROACHING');
        assert.match(html, /pool--threshold/);
        assert.doesNotMatch(html, /pool--approaching/);
      }
      assert.ok(html.includes(`₱${fee}.00`), `the same card shows the bill ₱${fee}.00`);
      assert.doesNotMatch(html, /data-alert="t-02"[^>]* hidden/, 'the alert is visible');
    });
  }
}

test('01:00:00 is normal: no billing text, alert hidden', () => {
  for (const session of [{}, { plannedMs: 60 * MIN }]) {
    const html = renderAt(at(60), session);
    assert.ok(!text(html).includes('BILLING THRESHOLD'));
    assert.match(html, /data-alert="t-02"[^>]* hidden/);
    assert.doesNotMatch(html, /pool--(approaching|threshold)/);
  }
});

test('a stopped clock or an idle table has no billing alert', () => {
  assert.ok(!text(renderAt(at(66), { ended: true, endedAt: T0 + at(66) })).includes('BILLING THRESHOLD'));
  const idle = poolCard({ id: 't-03', name: 'Table 03', status: 'available', session: null });
  assert.ok(!idle.includes('data-alert'));
});

test('the status text is written out and reads as one phrase', () => {
  assert.equal(text(billingAlertInner('approaching')), APPROACHING);
  assert.equal(text(billingAlertInner('reached')), REACHED);
  assert.equal(billingAlertInner('normal'), '');
  assert.deepEqual(BILLING_ALERT_TEXT.approaching, ['APPROACHING', 'BILLING THRESHOLD']);
});
