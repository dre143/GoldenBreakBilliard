import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourAlertFor, visibleHourLevel, dismissHourAlert } from '../../js/hour-alerts.js';
import { state } from '../../js/state.js';
import { updateTableTimers } from '../../js/views/shared.js';

const MIN = 60000;
const START = 1800000000000;
const table = (minutes, extra = {}) => ({ id: 'warning-test', status: 'in_use', session: {
  startedAt: START, ended: false, plannedMs: minutes * MIN, ...extra,
} });

test('booking effects follow time left for 15, 30, 60, 90 and 120-minute bookings', () => {
  for (const minutes of [15, 30, 60, 90, 120]) {
    const t = table(minutes);
    const end = START + minutes * MIN;
    assert.equal(visibleHourLevel(t, end - 5 * MIN - 1), null);
    assert.equal(visibleHourLevel(t, end - 5 * MIN), 'warn');
    assert.equal(visibleHourLevel(t, end - MIN - 1), 'warn');
    assert.equal(visibleHourLevel(t, end - MIN), 'crit');
    assert.equal(visibleHourLevel(t, end - 1), 'crit');
    assert.equal(visibleHourLevel(t, end), null);
    assert.equal(visibleHourLevel({ ...t, session: { ...t.session, ended: true } }, end - MIN), null);
  }
  assert.equal(visibleHourLevel(table(0), START + 59 * MIN), null);
});

test('added time uses the resumed countdown and gets a fresh warning identity', () => {
  const resumedAt = START + 8 * 60 * MIN;
  const t = table(90, { resumedAt, elapsedBeforeResume: 60 * MIN });
  assert.equal(visibleHourLevel(t, resumedAt + 25 * MIN), 'warn');
  assert.equal(visibleHourLevel(t, resumedAt + 29 * MIN), 'crit');
  assert.notEqual(hourAlertFor(table(60), START + 55 * MIN).key,
    hourAlertFor(t, resumedAt + 25 * MIN).key);
});

test('dismissing the five-minute effect does not suppress the one-minute effect', () => {
  const originalNow = Date.now;
  const originalDocument = globalThis.document;
  const t = table(30);
  state.tables = [t];
  globalThis.document = { querySelectorAll: () => [] };
  Date.now = () => START + 25 * MIN;
  try {
    dismissHourAlert(t.id);
    assert.equal(visibleHourLevel(t), null);
    assert.equal(visibleHourLevel(t, START + 29 * MIN), 'crit');
  } finally {
    Date.now = originalNow;
    globalThis.document = originalDocument;
    state.tables = [];
  }
});

test('display timer ticks update warning classes without starting staff sound services', () => {
  const originalNow = Date.now;
  const t = table(90);
  state.tables = [t];
  const classes = new Set();
  const card = { dataset: { pool: t.id }, classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }, querySelector: () => null };
  const root = { querySelectorAll: (selector) => selector === '.pool[data-pool]' ? [card] : [] };
  try {
    Date.now = () => START + 85 * MIN;
    updateTableTimers(root);
    assert.ok(classes.has('pool--hour-warn'));
    Date.now = () => START + 89 * MIN;
    updateTableTimers(root);
    assert.ok(classes.has('pool--hour-crit'));
    assert.ok(!classes.has('pool--hour-warn'));
    t.session.ended = true;
    updateTableTimers(root);
    assert.equal(classes.size, 0);
  } finally {
    Date.now = originalNow;
    state.tables = [];
  }
});
