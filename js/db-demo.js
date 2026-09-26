// Local demo backend with the same API as db-firebase.js.
// Data persists in localStorage and syncs live across tabs via BroadcastChannel,
// so two open tabs behave like two POS terminals.
import { tableFee, round2, PRICING } from './billing.js';
import { isServerTime } from './clock.js';

const KEY = 'goldenbreak.demo.v1';
const SESSION_KEY = 'goldenbreak.demo.uid';

const clone = (v) => JSON.parse(JSON.stringify(v));
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const write = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage full or blocked */ } };

let data = read();
if (!data) { data = seed(); write(); }

const listeners = new Set();
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('goldenbreak-demo') : null;

function notify(cols) {
  for (const l of listeners) if (!cols || cols.has(l.col)) l.run();
}
function commit(cols) {
  write();
  channel?.postMessage([...cols]);
  notify(cols);
}
if (channel) channel.onmessage = (e) => { data = read() || data; notify(new Set(e.data)); };
self.addEventListener('storage', (e) => { if (e.key === KEY) { data = read() || data; notify(null); } });

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const OPS = {
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
  '>=': (a, b) => a >= b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '<': (a, b) => a < b,
};

function rows(col, opts = {}) {
  let out = Object.entries(data[col] || {}).map(([id, v]) => ({ id, ...clone(v) }));
  for (const [f, op, v] of opts.where || []) out = out.filter((r) => OPS[op](r[f], v));
  if (opts.orderBy) {
    const [f, dir] = opts.orderBy;
    out.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

const getDoc = (col, id) => (data[col]?.[id] ? { id, ...clone(data[col][id]) } : null);

/** SERVER_TIME placeholders become the local time (the demo has no server to trust). */
function resolveTimes(value) {
  if (isServerTime(value)) return Date.now();
  if (Array.isArray(value)) return value.map(resolveTimes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTimes(v)]));
  }
  return value;
}

/** Firestore-style update: keys may be dotted paths ('session.items') that set a nested field only. */
function applyPatch(target, patch) {
  for (const [path, v] of Object.entries(patch)) {
    const keys = path.split('.');
    let node = target;
    for (const k of keys.slice(0, -1)) {
      if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    node[keys.at(-1)] = v;
  }
}

function applyWrite([op, col, id, value], cols) {
  const bucket = (data[col] ||= {});
  if (value !== undefined) value = clone(resolveTimes(value)); // a remove carries no value
  if (op === 'update') {
    if (!bucket[id]) throw new Error(`Document ${col}/${id} not found`);
    applyPatch(bucket[id], value);
  } else if (op === 'set') {
    bucket[id] = value;
  } else if (op === 'remove') {
    delete bucket[id];
  }
  cols.add(col);
}

export const db = {
  newId: () => newId(),

  listen(col, cb, opts = {}) {
    const l = { col, run: () => cb(rows(col, opts)) };
    listeners.add(l);
    setTimeout(() => listeners.has(l) && l.run(), 0);
    return () => listeners.delete(l);
  },

  listenDoc(col, id, cb) {
    const l = { col, run: () => cb(getDoc(col, id)) };
    listeners.add(l);
    setTimeout(() => listeners.has(l) && l.run(), 0);
    return () => listeners.delete(l);
  },

  async get(col, id) { return getDoc(col, id); },
  async syncClock() { return 0; },
  async add(col, value) { const id = newId(); db.run([['set', col, id, value]]); return id; },
  async set(col, id, value, opts = {}) {
    const merged = opts.merge ? { ...(data[col]?.[id] || {}), ...resolveTimes(value) } : value;
    db.run([['set', col, id, merged]]);
  },
  async update(col, id, patch) { db.run([['update', col, id, patch]]); },
  async remove(col, id) { db.run([['remove', col, id]]); },

  run(writes) {
    const cols = new Set();
    for (const w of writes) applyWrite(w, cols);
    commit(cols);
  },

  async transaction(fn) {
    const writes = [];
    const tx = {
      get: async (col, id) => getDoc(col, id),
      set: (col, id, value) => { writes.push(['set', col, id, value]); },
      update: (col, id, patch) => { writes.push(['update', col, id, patch]); },
    };
    const result = await fn(tx);
    for (const [op, col, id] of writes) {
      if (op === 'update' && !data[col]?.[id]) throw new Error(`Document ${col}/${id} not found`);
    }
    db.run(writes);
    return result;
  },
};

const authListeners = new Set();
function sessionUser() {
  const uid = sessionStorage.getItem(SESSION_KEY);
  return uid && data.users?.[uid] ? { uid, email: data.users[uid].email } : null;
}

export const auth = {
  demo: true,
  onChange(cb) {
    authListeners.add(cb);
    setTimeout(() => cb(sessionUser()), 0);
    return () => authListeners.delete(cb);
  },
  async signInAs(uid) {
    sessionStorage.setItem(SESSION_KEY, uid);
    const u = sessionUser();
    authListeners.forEach((cb) => cb(u));
  },
  async signIn() { throw new Error('Demo mode uses the account picker.'); },
  async signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    authListeners.forEach((cb) => cb(null));
  },
  async isSetupDone() { return true; },
  async createOwner() { return newId(); },
  async createAccount() { return `u-${newId()}`; },
  /** Start from zero: no sales, expenses or restocks, every table free, every cue stick unsold. Staff, tables, products and cue sticks stay. */
  clearDemoSales() {
    data.transactions = {};
    data.expenses = {};
    data.restocks = {};
    for (const t of Object.values(data.tables || {})) Object.assign(t, { status: 'available', session: null, light: false, lastTxId: null });
    for (const c of Object.values(data.cueSticks || {})) Object.assign(c, { status: 'available', soldAt: null, soldTxId: null, soldByName: null });
    commit(new Set(['tables', 'cueSticks', 'restocks', 'transactions', 'expenses']));
  },
  resetDemo() {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(SESSION_KEY);
    channel?.postMessage(['tables', 'products', 'cueSticks', 'users', 'restocks', 'transactions', 'expenses']);
    location.reload();
  },
};

/* ---------- seed data ---------- */

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  const now = Date.now();
  const MIN = 60000, H = 3600000, D = 86400000;
  const rnd = mulberry32(20260917);
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const today0 = day0.getTime();

  const users = {
    'u-owner': { name: 'Marco Reyes', email: 'owner@goldenbreak.demo', role: 'owner', active: true, online: false, lastSeen: now - 2 * H, createdAt: now - 400 * D },
    'u-super': { name: 'System Admin', email: 'super@goldenbreak.demo', role: 'superadmin', active: true, online: false, lastSeen: 0, createdAt: now - 300 * D },
    'u-joy': { name: 'Joy Santos', email: 'joy@goldenbreak.demo', role: 'cashier', active: true, online: true, demoPresence: true, lastSeen: now, createdAt: now - 200 * D },
    'u-bea': { name: 'Bea Lim', email: 'bea@goldenbreak.demo', role: 'cashier', active: true, online: true, demoPresence: true, lastSeen: now, createdAt: now - 90 * D },
    'u-paolo': { name: 'Paolo Cruz', email: 'paolo@goldenbreak.demo', role: 'cashier', active: true, online: false, lastSeen: now - 19 * H, createdAt: now - 150 * D },
    'u-tv': { name: 'Lobby TV', email: 'tv@goldenbreak.demo', role: 'display', active: true, online: false, lastSeen: now - 5 * H, createdAt: now - 40 * D },
  };

  const P = [
    ['p-smb', 'San Miguel Pale Pilsen', 'Beverages', 85, 48, 24],
    ['p-rh', 'Red Horse Beer 500ml', 'Beverages', 95, 30, 24],
    ['p-sml', 'San Mig Light', 'Beverages', 85, 20, 24],
    ['p-coke', 'Coca-Cola 330ml', 'Beverages', 45, 9, 24],
    ['p-water', 'Bottled Water 500ml', 'Beverages', 30, 60, 20],
    ['p-tea', 'House Iced Tea', 'Beverages', 50, 18, 12],
    ['p-nachos', 'Nachos Overload', 'Snacks', 120, 12, 8],
    ['p-chich', 'Chicharon Bulaklak', 'Snacks', 60, 5, 10],
    ['p-nuts', 'Salted Peanuts', 'Snacks', 40, 30, 15],
    ['p-fries', 'Cheese Fries', 'Snacks', 110, 14, 10],
    ['p-sisig', 'Sisig Rice Bowl', 'Food', 180, 10, 6],
    ['p-wings', 'Buffalo Wings (6 pcs)', 'Food', 220, 8, 6],
    ['p-chalk', 'Cue Chalk', 'Accessories', 25, 3, 10],
    ['p-tip', 'Cue Tip Replacement', 'Accessories', 150, 8, 4],
    ['p-glove', 'Billiard Glove', 'Accessories', 180, 6, 4],
  ];
  const products = {};
  for (const [id, name, category, price, stock, reorderLevel] of P) {
    products[id] = { name, category, price, stock, reorderLevel, createdAt: now - 120 * D, updatedAt: now - 2 * D };
  }
  const item = (pid, qty) => {
    const p = products[pid];
    return { productId: pid, name: p.name, category: p.category, price: p.price, qty };
  };

  const tables = {};
  for (let n = 1; n <= 5; n++) {
    const id = `t-0${n}`;
    tables[id] = { number: n, name: `Table 0${n}`, status: 'available', session: null, light: false, updatedAt: now };
  }
  // endedAgo: null = clock running; otherwise the session was ended (clock stopped) that long ago.
  const open = (id, startedAgo, endedAgo, items, by = ['u-joy', 'Joy Santos'], booking = 0) => {
    const startedAt = now - startedAgo;
    const ended = endedAgo != null;
    tables[id].status = 'in_use';
    tables[id].light = true;
    tables[id].session = {
      startedAt,
      ended,
      endedAt: ended ? now - endedAgo : null,
      plannedMs: booking,
      rounds: Math.max(1, Math.floor(startedAgo / (20 * MIN))),
      items,
      openedBy: by[0],
      openedByName: by[1],
    };
  };
  open('t-02', 72 * MIN + 14000, null, [item('p-smb', 3), item('p-nachos', 1)]);
  open('t-03', 22 * MIN + 41000, null, [item('p-water', 2)], ['u-bea', 'Bea Lim'], 2 * H); // booked 2 hours
  open('t-05', 51 * MIN, 4 * MIN, [item('p-coke', 2)]);
  open('t-04', 125 * MIN + 3000, null, [item('p-rh', 4), item('p-wings', 1), item('p-chalk', 1)], ['u-bea', 'Bea Lim'], 2 * H); // booked 2h, now in overtime

  const cueSticks = {
    'cs-1': { name: 'Predator Sport II', brand: 'Predator', weight: '19oz', price: 8500, photo: null, status: 'available', createdAt: now - 40 * D, updatedAt: now - 40 * D },
    'cs-2': { name: 'Players C-960', brand: 'Players', weight: '20oz', price: 4200, photo: null, status: 'available', createdAt: now - 30 * D, updatedAt: now - 30 * D },
    'cs-3': { name: 'House Cue (Maple)', brand: null, weight: '18oz', price: 1200, photo: null, status: 'available', createdAt: now - 20 * D, updatedAt: now - 20 * D },
    'cs-4': { name: 'McDermott G-Core', brand: 'McDermott', weight: '19.5oz', price: 9800, photo: null, status: 'sold', soldAt: now - 6 * D, soldTxId: 'x-cue-sample', soldByName: 'Joy Santos', createdAt: now - 60 * D, updatedAt: now - 6 * D },
  };

  const restocks = {
    'r-1': { productId: 'p-water', productName: 'Bottled Water 500ml', qty: 24, byId: 'u-owner', byName: 'Marco Reyes', createdAt: now - 2 * D },
    'r-2': { productId: 'p-smb', productName: 'San Miguel Pale Pilsen', qty: 24, byId: 'u-owner', byName: 'Marco Reyes', createdAt: now - 3 * D },
    'r-3': { productId: 'p-nuts', productName: 'Salted Peanuts', qty: 20, byId: 'u-owner', byName: 'Marco Reyes', createdAt: now - 5 * D },
  };

  const cashiers = [['u-joy', 'Joy Santos'], ['u-bea', 'Bea Lim'], ['u-paolo', 'Paolo Cruz']];
  const transactions = {};
  for (let d = 13; d >= 0; d--) {
    const start = new Date(today0); start.setDate(start.getDate() - d);
    const dayStart = start.getTime();
    const dow = start.getDay();
    let count = Math.round((dow === 5 || dow === 6 ? 15 : dow === 0 ? 12 : 8) + rnd() * 5);
    if (d === 0) count = Math.max(3, Math.round(count * Math.min(1, (now - dayStart) / D + 0.25)));
    for (let i = 0; i < count; i++) {
      const createdAt = d === 0
        ? dayStart + Math.floor(rnd() * Math.max(now - dayStart - 5 * MIN, H))
        : dayStart + 11 * H + Math.floor(rnd() * 12.5 * H);
      if (createdAt > now) continue;
      const tn = 1 + Math.floor(rnd() * 5);
      const durationMs = (30 + Math.floor(rnd() * 150)) * MIN + Math.floor(rnd() * 60) * 1000;
      const booked = rnd() < 0.35 ? (1 + Math.floor(rnd() * 3)) * H : 0; // some customers book hours
      const billedMs = durationMs; // billed on time actually played
      const fee = tableFee(billedMs);
      const lines = [];
      const nLines = Math.floor(rnd() * 4);
      for (let k = 0; k < nLines; k++) {
        const p = P[Math.floor(rnd() * P.length)];
        if (lines.some((l) => l.productId === p[0])) continue;
        const qty = 1 + Math.floor(rnd() * 3);
        lines.push({ productId: p[0], name: p[1], category: p[2], price: p[3], qty, total: round2(p[3] * qty) });
      }
      const productTotal = round2(lines.reduce((s, l) => s + l.total, 0));
      const total = round2(fee + productTotal);
      const r = rnd();
      const method = r < 0.5 ? 'cash' : r < 0.85 ? 'gcash' : 'split';
      const tendered = method === 'cash' ? Math.ceil(total / 100) * 100 : null;
      const splitCash = Math.min(total - 50, Math.max(50, Math.round((total * (0.35 + rnd() * 0.3)) / 50) * 50));
      const payments = method === 'cash' ? { cash: total, gcash: 0 }
        : method === 'gcash' ? { cash: 0, gcash: total }
          : { cash: splitCash, gcash: round2(total - splitCash) };
      const [cashierId, cashierName] = cashiers[Math.floor(rnd() * cashiers.length)];
      transactions[`x-${d}-${i}`] = {
        tableId: `t-0${tn}`, tableName: `Table 0${tn}`, pricing: { ...PRICING },
        startedAt: createdAt - durationMs, endedAt: createdAt, durationMs,
        plannedMs: booked, billedMs, mode: booked ? 'timed' : 'open',
        tableFee: fee, items: lines, productTotal, total, method, payments,
        tendered, change: tendered == null ? null : round2(tendered - total),
        cashierId, cashierName, createdAt,
      };
    }
  }

  // One game cancelled yesterday within its first 5 minutes, so Transactions and Reports show how it
  // appears: the customer bought a bottled water, then decided not to play. No table fee; the water
  // is still sold and paid for.
  {
    const createdAt = today0 - D + 19 * H + 12 * MIN;
    const durationMs = 3 * MIN + 10000; // under the 5-minute limit
    const productTotal = 30; // 1x Bottled Water
    transactions['x-cancel-sample'] = {
      tableId: 't-05', tableName: 'Table 05', pricing: { ...PRICING },
      startedAt: createdAt - durationMs, endedAt: createdAt, durationMs,
      plannedMs: 0, billedMs: durationMs, mode: 'open', rounds: 0,
      tableFee: 0, items: [{ productId: 'p-water', name: 'Bottled Water 500ml', category: 'Beverages', price: 30, qty: 1, total: 30 }],
      productTotal, total: productTotal, method: 'cash', payments: { cash: productTotal, gcash: 0 },
      tendered: productTotal, change: 0,
      cashierId: 'u-joy', cashierName: 'Joy Santos', createdAt,
      gameCancelled: true, cancelReason: 'Customer decided not to play', cancelNote: '',
      cancelledById: 'u-joy', cancelledByName: 'Joy Santos',
    };
  }
  // A cue stick sold a few days ago, matching cs-4's soldTxId, so its receipt and the Cue Stick Sales
  // report line have something to show.
  {
    const createdAt = now - 6 * D;
    const cueStickTotal = 9800;
    transactions['x-cue-sample'] = {
      tableId: null, tableName: null, pricing: null,
      startedAt: null, endedAt: null, durationMs: null,
      plannedMs: null, billedMs: null, mode: null, rounds: 0,
      saleType: 'cue-stick',
      tableFee: 0, productTotal: 0, cueStickTotal,
      items: [{ cueStickId: 'cs-4', name: 'McDermott G-Core', brand: 'McDermott', price: cueStickTotal, qty: 1, total: cueStickTotal }],
      total: cueStickTotal, method: 'gcash', payments: { cash: 0, gcash: cueStickTotal },
      tendered: null, change: null, gcashRef: '48213',
      cashierId: 'u-joy', cashierName: 'Joy Santos', createdAt,
    };
  }
  // Cash paid out of the drawer by whoever was on duty: a few small expenses most days.
  const EXPENSES = [['Drinking water refill', 60], ['Ice', 80], ['Tricycle fare (supplies)', 40], ['Cleaning supplies', 150], ['Chalk (market)', 120], ['LPG refill', 950]];
  const expenses = {};
  for (let d = 13; d >= 0; d--) {
    const start = new Date(today0); start.setDate(start.getDate() - d);
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const createdAt = start.getTime() + 10 * H + Math.floor(rnd() * 13 * H);
      if (createdAt > now) continue;
      const [description, amount] = EXPENSES[Math.floor(rnd() * EXPENSES.length)];
      const [cashierId, cashierName] = cashiers[Math.floor(rnd() * cashiers.length)];
      expenses[`e-${d}-${i}`] = { description, amount, cashierId, cashierName, createdAt };
    }
  }

  return {
    users, products, cueSticks, tables, restocks, transactions, expenses, meta: { setup: { ownerId: 'u-owner', createdAt: now } },
  };
}
