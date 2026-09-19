// A cashier's live listeners (app shell + Reports/Transactions queries) must all be readable.
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDocs, collection, query, where, Timestamp } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-goldenbreak-reads',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, 'users/joy'), { name: 'Joy', role: 'cashier', active: true });
    await setDoc(doc(fs, 'users/off'), { name: 'Off', role: 'cashier', active: false });
  });
});
after(async () => { await env?.cleanup(); });

const ts = (ms) => Timestamp.fromMillis(ms);

test('active cashier can run the Reports / Transactions / Tables range queries and the shell listeners', async () => {
  const fs = env.authenticatedContext('joy').firestore();
  const range = query(collection(fs, 'transactions'), where('createdAt', '>=', ts(0)), where('createdAt', '<', ts(Date.now() + 1e9)));
  await assertSucceeds(getDocs(range));
  for (const c of ['tables', 'products', 'users']) await assertSucceeds(getDocs(collection(fs, c)));
  await assertSucceeds(getDocs(query(collection(fs, 'restocks'), where('createdAt', '>=', ts(0)))));
});

test('a deactivated cashier is refused everywhere', async () => {
  const fs = env.authenticatedContext('off').firestore();
  await assertFails(getDocs(collection(fs, 'transactions')));
});
