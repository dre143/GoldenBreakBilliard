// Superadmin: every owner permission, and invisible to owners and cashiers (enforced by the rules, not just hidden).
import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp,
} from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-goldenbreak-superadmin',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });

const as = (uid) => env.authenticatedContext(uid).firestore();

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const user = (name, role, active = true) => ({ name, email: `${name}@x.test`, role, active, online: false, lastSeen: 0 });
    await setDoc(doc(fs, 'users/boss'), user('Boss', 'superadmin'));
    await setDoc(doc(fs, 'users/owner'), user('Marco', 'owner'));
    await setDoc(doc(fs, 'users/joy'), user('Joy', 'cashier'));
    await setDoc(doc(fs, 'products/beer'), { name: 'Beer', price: 85, stock: 10, reorderLevel: 5 });
    await setDoc(doc(fs, 'expenses/e1'), { description: 'Ice', amount: 50, cashierId: 'joy', cashierName: 'Joy' });
    await setDoc(doc(fs, 'tables/t1'), { name: 'Table 01', number: 1, status: 'available', session: null, light: false });
  });
});

const newUser = (role) => ({ name: 'New', email: 'new@x.test', role, active: true, online: false, lastSeen: 0, createdAt: serverTimestamp() });

/* ---------- invisible to owners and cashiers ---------- */

test('owners and cashiers cannot read a superadmin profile', async () => {
  for (const uid of ['owner', 'joy']) await assertFails(getDoc(doc(as(uid), 'users/boss')));
});

test('an unfiltered users list is refused for owners and cashiers; the app’s filtered list works and omits the superadmin', async () => {
  for (const uid of ['owner', 'joy']) {
    await assertFails(getDocs(collection(as(uid), 'users')));
    const snap = await assertSucceeds(getDocs(query(collection(as(uid), 'users'), where('role', '!=', 'superadmin'))));
    assertEqual(snap.docs.map((d) => d.id).sort(), ['joy', 'owner']);
  }
});

test('the superadmin sees everyone, including themself', async () => {
  const snap = await assertSucceeds(getDocs(collection(as('boss'), 'users')));
  assertEqual(snap.docs.map((d) => d.id).sort(), ['boss', 'joy', 'owner']);
});

test('an owner cannot create, edit, deactivate or promote-to a superadmin', async () => {
  const owner = as('owner');
  await assertFails(setDoc(doc(owner, 'users/sneaky'), newUser('superadmin')));
  await assertFails(updateDoc(doc(owner, 'users/boss'), { active: false }));
  await assertFails(updateDoc(doc(owner, 'users/boss'), { role: 'cashier' }));
  await assertFails(updateDoc(doc(owner, 'users/joy'), { role: 'superadmin' }));
  await assertFails(updateDoc(doc(owner, 'users/owner'), { role: 'superadmin' }));
});

test('a cashier cannot promote themself or anyone to superadmin', async () => {
  const joy = as('joy');
  await assertFails(updateDoc(doc(joy, 'users/joy'), { role: 'superadmin' }));
  await assertFails(setDoc(doc(joy, 'users/x'), newUser('superadmin')));
});

test('owners still manage cashiers and other owners as before', async () => {
  const owner = as('owner');
  await assertSucceeds(setDoc(doc(owner, 'users/newcashier'), newUser('cashier')));
  await assertSucceeds(setDoc(doc(owner, 'users/newowner'), newUser('owner')));
  await assertSucceeds(updateDoc(doc(owner, 'users/joy'), { active: false }));
});

/* ---------- superadmin has every owner permission, and more ---------- */

test('the superadmin can manage accounts of every role', async () => {
  const boss = as('boss');
  await assertSucceeds(setDoc(doc(boss, 'users/a'), newUser('cashier')));
  await assertSucceeds(setDoc(doc(boss, 'users/b'), newUser('owner')));
  await assertSucceeds(setDoc(doc(boss, 'users/c'), newUser('superadmin')));
  await assertSucceeds(updateDoc(doc(boss, 'users/owner'), { active: false }));
});

test('the superadmin can do owner-only work: products, tables, deleting an expense', async () => {
  const boss = as('boss');
  await assertSucceeds(setDoc(doc(boss, 'products/chalk'), { name: 'Chalk', price: 20, stock: 5, reorderLevel: 2 }));
  await assertSucceeds(updateDoc(doc(boss, 'products/beer'), { stock: 40, price: 90 }));
  await assertSucceeds(updateDoc(doc(boss, 'tables/t1'), { name: 'VIP', updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(boss, 'expenses/e1')));
});

test('a cashier still cannot do those things', async () => {
  const joy = as('joy');
  await assertFails(setDoc(doc(joy, 'products/chalk'), { name: 'Chalk', price: 20, stock: 5, reorderLevel: 2 }));
  await assertFails(updateDoc(doc(joy, 'tables/t1'), { name: 'VIP', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(joy, 'expenses/e1')));
});

test('everyone, superadmin included, can update only their own presence with server time', async () => {
  for (const uid of ['boss', 'owner', 'joy']) {
    await assertSucceeds(updateDoc(doc(as(uid), `users/${uid}`), { online: true, lastSeen: serverTimestamp() }));
  }
});

test('a deactivated superadmin loses all access', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'users/boss'), { active: false }); });
  await assertFails(getDocs(collection(as('boss'), 'products')));
  await assertFails(setDoc(doc(as('boss'), 'products/chalk'), { name: 'Chalk', price: 20, stock: 5, reorderLevel: 2 }));
});

function assertEqual(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
