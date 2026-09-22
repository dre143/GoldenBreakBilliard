import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, onSnapshot, query, where, orderBy, limit,
  getDoc, getDocFromServer, addDoc, setDoc, updateDoc, deleteDoc, runTransaction,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, setPersistence, inMemoryPersistence,
  browserLocalPersistence, browserSessionPersistence, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { isServerTime } from './clock.js';

const app = initializeApp(firebaseConfig);
const fs = getFirestore(app);
const fa = getAuth(app);

/*
 * The app works with epoch-millisecond numbers. Firestore stores times as Timestamps so security rules
 * can compare them with request.time. Conversion happens only here:
 *   write: SERVER_TIME → serverTimestamp(); a number in a time field → Timestamp
 *   read:  Timestamp → milliseconds (pending server times use the local estimate)
 */
const TIME_FIELDS = new Set([
  'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'voidedAt', 'lastSeen', 'lastRestockedAt', 't', 'at',
]);
const leaf = (key) => String(key).split('.').pop();

function toDb(value, key = '') {
  if (isServerTime(value)) return serverTimestamp();
  if (typeof value === 'number' && TIME_FIELDS.has(leaf(key))) return Timestamp.fromMillis(value);
  if (Array.isArray(value)) return value.map((v) => toDb(v));
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toDb(v, k)]));
  }
  return value;
}

function toApp(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(toApp);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toApp(v)]));
  }
  return value;
}

const fromSnap = (s) => (s.exists() ? { id: s.id, ...toApp(s.data({ serverTimestamps: 'estimate' })) } : null);

export const db = {
  newId: (col) => doc(collection(fs, col)).id,

  listen(col, cb, opts = {}, onError) {
    const constraints = [];
    for (const [field, op, value] of opts.where || []) constraints.push(where(field, op, toDb(value, field)));
    if (opts.orderBy) constraints.push(orderBy(opts.orderBy[0], opts.orderBy[1] || 'asc'));
    if (opts.limit) constraints.push(limit(opts.limit));
    return onSnapshot(
      query(collection(fs, col), ...constraints),
      (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...toApp(d.data({ serverTimestamps: 'estimate' })) }))),
      (err) => { console.error(`[${col}]`, err); onError?.(err); },
    );
  },

  listenDoc(col, id, cb, onError) {
    return onSnapshot(doc(fs, col, id), (s) => cb(fromSnap(s)), (err) => { console.error(err); onError?.(err); });
  },

  get: async (col, id) => fromSnap(await getDoc(doc(fs, col, id))),
  add: async (col, value) => (await addDoc(collection(fs, col), toDb(value))).id,
  set: (col, id, value, opts = {}) => setDoc(doc(fs, col, id), toDb(value), opts.merge ? { merge: true } : {}),
  /** Keys may be dotted field paths ('session.items') so nested fields change without rewriting siblings. */
  update: (col, id, patch) => updateDoc(doc(fs, col, id), toDb(patch)),
  remove: (col, id) => deleteDoc(doc(fs, col, id)),

  transaction: (fn) => runTransaction(fs, (t) => fn({
    get: async (col, id) => fromSnap(await t.get(doc(fs, col, id))),
    set: (col, id, value) => { t.set(doc(fs, col, id), toDb(value)); },
    update: (col, id, patch) => { t.update(doc(fs, col, id), toDb(patch)); },
  })),

  /**
   * Estimate server clock − device clock by stamping a private doc with the server time and reading it back.
   * Used only to show accurate timers; billing uses the stored server stamps.
   */
  async syncClock(uid) {
    const ref = doc(fs, 'clock', uid);
    const before = Date.now();
    await setDoc(ref, { t: serverTimestamp() });
    const after = Date.now();
    const stamped = (await getDocFromServer(ref)).get('t');
    return stamped ? stamped.toMillis() - Math.round((before + after) / 2) : 0;
  },
};

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/email-already-in-use': 'That email already has an account.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
};
const friendly = (err) => new Error(AUTH_MESSAGES[err.code] || err.message);

export const auth = {
  demo: false,
  onChange: (cb) => onAuthStateChanged(fa, (u) => cb(u ? { uid: u.uid, email: u.email } : null)),
  /**
   * remember=true keeps the session across browser restarts (local persistence); remember=false
   * (an unchecked "Remember me", e.g. a shared till) drops it once the browser tab closes.
   */
  async signIn(email, password, { remember = true } = {}) {
    try {
      await setPersistence(fa, remember ? browserLocalPersistence : browserSessionPersistence);
      return await signInWithEmailAndPassword(fa, email, password);
    } catch (e) { throw friendly(e); }
  },
  signOut: () => signOut(fa),

  /** Always resolves without revealing whether the address has an account (standard practice). */
  async sendPasswordReset(email) {
    try {
      await sendPasswordResetEmail(fa, email);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw friendly(e);
    }
  },

  async isSetupDone() {
    return (await getDoc(doc(fs, 'meta', 'setup'))).exists();
  },

  /** First-run owner sign-up (signs the owner in). */
  async createOwner(email, password) {
    try {
      return (await createUserWithEmailAndPassword(fa, email, password)).user.uid;
    } catch (e) { throw friendly(e); }
  },

  /** Owner creates a staff login without being signed out: use a throwaway secondary app. */
  async createAccount(email, password) {
    const secondary = initializeApp(firebaseConfig, `staff-${Date.now()}`);
    const secondaryAuth = getAuth(secondary);
    try {
      await setPersistence(secondaryAuth, inMemoryPersistence);
      return (await createUserWithEmailAndPassword(secondaryAuth, email, password)).user.uid;
    } catch (e) {
      throw friendly(e);
    } finally {
      await signOut(secondaryAuth).catch(() => {});
      await deleteApp(secondary).catch(() => {});
    }
  },
};
