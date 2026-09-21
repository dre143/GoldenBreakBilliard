import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerLevel, isSuperadmin, roleLabel, visibleUsers, usersQuery } from '../../js/roles.js';

const users = [
  { id: 'a', name: 'Boss', role: 'superadmin' },
  { id: 'b', name: 'Marco', role: 'owner' },
  { id: 'c', name: 'Joy', role: 'cashier' },
];

test('a superadmin has owner-level access; a cashier does not', () => {
  assert.equal(isOwnerLevel({ role: 'superadmin' }), true);
  assert.equal(isOwnerLevel({ role: 'owner' }), true);
  assert.equal(isOwnerLevel({ role: 'cashier' }), false);
  assert.equal(isOwnerLevel(null), false);
  assert.equal(isSuperadmin({ role: 'owner' }), false);
});

test('superadmin accounts are invisible to everyone but a superadmin', () => {
  assert.deepEqual(visibleUsers(users, { role: 'owner' }).map((u) => u.id), ['b', 'c']);
  assert.deepEqual(visibleUsers(users, { role: 'cashier' }).map((u) => u.id), ['b', 'c']);
  assert.deepEqual(visibleUsers(users, null).map((u) => u.id), ['b', 'c']);
  assert.deepEqual(visibleUsers(users, { role: 'superadmin' }).map((u) => u.id), ['a', 'b', 'c']);
});

test('the database query filters superadmins out for everyone else', () => {
  assert.deepEqual(usersQuery({ role: 'superadmin' }), {});
  assert.deepEqual(usersQuery({ role: 'owner' }), { where: [['role', '!=', 'superadmin']] });
  assert.deepEqual(usersQuery(null), { where: [['role', '!=', 'superadmin']] });
});

test('role labels', () => {
  assert.deepEqual(['superadmin', 'owner', 'cashier', undefined].map(roleLabel), ['Superadmin', 'Owner', 'Cashier', 'Cashier']);
});
