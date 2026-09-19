import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFor } from '../../js/time-alerts.js';

const MIN = 60_000;

test('time-left alerts: 15 minutes, then 5 minutes, nothing before or after', () => {
  assert.equal(alertFor(30 * MIN), null, 'plenty of time: no alert');
  assert.equal(alertFor(15 * MIN + 1), null, 'just over 15 minutes: not yet');
  assert.equal(alertFor(15 * MIN).key, '15', 'exactly 15 minutes left');
  assert.equal(alertFor(6 * MIN).key, '15');
  assert.equal(alertFor(5 * MIN).key, '5', 'exactly 5 minutes left');
  assert.equal(alertFor(30_000).key, '5');
  assert.equal(alertFor(0), null, 'time is up: overtime, not a time-left alert');
  assert.equal(alertFor(-MIN), null);
});