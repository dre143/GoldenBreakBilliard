import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFor } from '../../js/time-alerts.js';

const MIN = 60_000;

// The 15-minute warning was removed: "5 minutes left" (spoken) is the only time-left alert now.
// The booked time actually running out ("expiry") is a separate bell, checked in checkThresholds() —
// see js/time-alerts.js — not alertFor(), which only covers the pre-expiry countdown.
test('time-left alert: 5 minutes left, nothing before or after', () => {
  assert.equal(alertFor(30 * MIN), null, 'plenty of time: no alert');
  assert.equal(alertFor(5 * MIN + 1), null, 'just over 5 minutes: not yet');
  assert.equal(alertFor(5 * MIN).key, '5', 'exactly 5 minutes left');
  assert.equal(alertFor(30_000).key, '5');
  assert.equal(alertFor(0), null, 'time is up: overtime/expiry, not a time-left alert');
  assert.equal(alertFor(-MIN), null);
});