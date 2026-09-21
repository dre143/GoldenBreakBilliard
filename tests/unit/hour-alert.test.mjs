import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourAlert, HOUR_MS } from '../../js/billing.js';

const MIN = 60_000;
const SEC = 1_000;
const at = (h, m = 0, s = 0) => h * HOUR_MS + m * MIN + s * SEC;

test('no alert until 5 minutes before the first hour mark', () => {
  assert.equal(hourAlert(0).level, null);
  assert.equal(hourAlert(at(0, 30)).level, null);
  assert.equal(hourAlert(at(0, 54, 59)).level, null, 'just outside the 5-minute window');
});

test('warning from 5 minutes out, critical from 1 minute out', () => {
  assert.equal(hourAlert(at(0, 55)).level, 'warn', 'exactly 5:00 out is inside the window');
  assert.equal(hourAlert(at(0, 58, 59)).level, 'warn');
  assert.equal(hourAlert(at(0, 59)).level, 'crit', 'exactly 1:00 out is critical');
  assert.equal(hourAlert(at(0, 59, 59)).level, 'crit');
});

test('crossing the hour clears the alert immediately', () => {
  assert.equal(hourAlert(at(1)).level, null, 'exactly on the hour');
  assert.equal(hourAlert(at(1, 0, 1)).level, null);
  assert.equal(hourAlert(at(1, 30)).level, null);
});

test('it re-arms for every following hour mark, each with its own boundary number', () => {
  const first = hourAlert(at(0, 56));
  const second = hourAlert(at(1, 56));
  const third = hourAlert(at(2, 59, 30));
  assert.deepEqual([first.level, second.level, third.level], ['warn', 'warn', 'crit']);
  assert.deepEqual([first.boundary, second.boundary, third.boundary], [1, 2, 3]);
});

test('time to the mark is reported', () => {
  assert.equal(hourAlert(at(0, 57)).msToMark, 3 * MIN);
  assert.equal(hourAlert(at(1, 59, 30)).msToMark, 30 * SEC);
});

test('bad input never alerts', () => {
  assert.equal(hourAlert(-5).level, null);
  assert.equal(hourAlert(NaN).level, null);
  assert.equal(hourAlert(undefined).level, null);
});
