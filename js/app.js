import { db, auth, mode } from './db.js';
import { state, set, emit, reset } from './state.js';
import { icon, esc, initials, toast, addDays } from './ui.js';
import { setServerOffset } from './clock.js';
import * as svc from './services.js';
import { renderAuth, renderPending } from './views/auth.js';
import * as tablesView from './views/tables.js';
import * as checkoutView from './views/checkout.js';
import * as quickSaleView from './views/quick-sale.js';
import * as inventoryView from './views/inventory.js';
import * as transactionsView from './views/transactions.js';
import * as dashboardView from './views/dashboard.js';
import * as staffView from './views/staff.js';
import * as reportsView from './views/reports.js';
import * as printer from './printer.js';
import { printerDialog } from './dialogs.js';

const root = document.getElementById('root');

const ROUTES = {
  tables: { label: 'Tables', icon: 'tables', view: tablesView },
  inventory: { label: 'Inventory', icon: 'box', view: inventoryView },
  checkout: { label: 'Checkout', icon: 'receipt', view: checkoutView },
  'quick-sale': { label: 'Quick Sale', icon: 'bag', view: quickSaleView },
  transactions: { label: 'Transactions', icon: 'list', view: transactionsView },
  dashboard: { label: 'Owner Dashboard', icon: 'chart', view: dashboardView, owner: true },
  reports: { label: 'Reports', icon: 'report', view: reportsView },
  staff: { label: 'Staff & Accounts', icon: 'users', view: staffView, owner: true },
};

let sessionCleanups = [];
let viewCleanup = null;
let printerCleanup = null;
let heartbeat = null;

setInterval(() => emit('tick'), 1000);

window.addEventListener('hashchange', () => state.user && route());
window.addEventListener('pagehide', () => { if (state.user) svc.setPresence(state.user.uid, false).catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (state.user && document.visibilityState === 'visible') {
    svc.setPresence(state.user.uid, true).catch(() => {});
    syncClock(); // the device clock may have been changed while the app was in the background
  }
});

/** Keep on-screen timers on server time even if this device's clock is wrong or gets changed. */
function syncClock() {
  if (!state.user) return;
  svc.syncClock(state.user.uid)
    .then((offset) => {
      setServerOffset(offset);
      if (Math.abs(offset) > 60000) toast(`This device’s clock is ${Math.round(Math.abs(offset) / 60000)} min ${offset > 0 ? 'behind' : 'ahead'}. Timers use server time.`, 'error');
    })
    .catch((err) => console.warn('Clock sync failed', err));
}

auth.onChange((authUser) => {
  teardown();
  if (!authUser) {
    renderAuth(root);
    return;
  }
  root.innerHTML = '<div class="boot" role="status"><span class="spinner" aria-hidden="true"></span>Signing in…</div>';
  let shellKey = null;
  const off = db.listenDoc('users', authUser.uid, (profile) => {
    if (!profile) {
      stopData();
      shellKey = null;
      renderPending(root, authUser);
      return;
    }
    if (profile.active === false) {
      toast('This account has been deactivated. Ask the owner for access.', 'error');
      auth.signOut();
      return;
    }
    state.user = { ...profile, uid: authUser.uid };
    const key = `${profile.role}|${profile.name}`;
    if (shellKey === null) {
      shellKey = key;
      startData();
      renderShell();
      route();
    } else if (key !== shellKey) {
      shellKey = key;
      renderShell();
      route();
    }
  }, (err) => {
    root.innerHTML = `<div class="boot" role="alert">Couldn’t load your profile: ${esc(err.message)}</div>`;
  });
  sessionCleanups.push(off);
});

const onDataError = (err) => toast(`Live data error: ${err.message}`, 'error');
let dataCleanups = [];

function startData() {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  dataCleanups = [
    db.listen('tables', (rows) => set('tables', rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || byName(a, b))), {}, onDataError),
    db.listen('products', (rows) => set('products', rows.sort(byName)), {}, onDataError),
    db.listen('users', (rows) => set('users', rows.sort(byName)), {}, onDataError),
    db.listen('restocks', (rows) => set('restocks', rows), { where: [['createdAt', '>=', addDays(Date.now(), -7)]] }, onDataError),
    db.listenDoc('settings', 'shifts', (doc) => set('settings', { ...state.settings, twoShifts: !!doc?.twoShifts }), onDataError),
  ];
  printer.tryReconnect(); // quietly reconnect the last thermal printer, if the browser kept permission
  const beat = () => state.user && svc.setPresence(state.user.uid, true).catch(() => {});
  beat();
  syncClock();
  let beats = 0;
  heartbeat = setInterval(() => {
    beat();
    if (++beats % 10 === 0) syncClock(); // re-measure the server clock offset every 10 minutes
  }, 60000);
}

function stopData() {
  dataCleanups.forEach((f) => f());
  dataCleanups = [];
  clearInterval(heartbeat);
  viewCleanup?.();
  viewCleanup = null;
}

function teardown() {
  stopData();
  sessionCleanups.forEach((f) => f());
  sessionCleanups = [];
  document.querySelectorAll('dialog.modal').forEach((d) => { d.close(); d.remove(); });
  reset();
}

async function signOut(button) {
  button.disabled = true;
  if (state.user) await svc.setPresence(state.user.uid, false).catch(() => {});
  await auth.signOut();
}

// Full wordmark lockup: used wherever there's room to show it (the sidebar, expanded or as the
// mobile drawer). The logo art already spells out the name, so there's no separate text alongside it.
const brand = () => `
  <a class="brand" href="#/tables" aria-label="Golden Break Billiard Hall, go to Tables">
    <img class="brand__logo" src="assets/logo-golden-break.png" alt="Golden Break Billiard Hall" width="1200" height="528">
  </a>`;

// Compact fallback for the slim mobile topbar, where the full lockup would be too wide: the
// 8-ball cropped from the same logo file, not a generic placeholder mark.
const brandCompact = () => `
  <a class="brand" href="#/tables" aria-label="Golden Break Billiard Hall, go to Tables">
    <img class="brand__mark-img" src="assets/logo-mark.png" alt="Golden Break Billiard Hall" width="160" height="160">
  </a>`;

function renderShell() {
  const u = state.user;
  const owner = u.role === 'owner';
  const link = (key) => {
    const r = ROUTES[key];
    return `<a class="nav__link" href="#/${key}" data-route="${key}">${icon(r.icon)}<span>${r.label}</span></a>`;
  };
  root.innerHTML = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell">
      <header class="topbar">
        <button type="button" class="icon-btn icon-btn--light" data-action="toggle-nav" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">${icon('menu')}</button>
        ${brandCompact()}
      </header>
      <aside class="sidebar" id="sidebar">
        ${brand()}
        <nav class="nav" aria-label="Primary">
          ${['tables', 'inventory', 'checkout', 'quick-sale', 'transactions', 'reports'].map(link).join('')}
          ${owner ? `<p class="nav__label">Owner</p>${['dashboard', 'staff'].map(link).join('')}` : ''}
        </nav>
        <div class="sidebar__spacer"></div>
        ${mode === 'demo' ? `<div class="demo-note">Demo mode · data is stored in this browser
          <button type="button" class="demo-note__btn" data-action="clear-demo">${icon('x')}Clear all sales</button></div>` : ''}
        <button type="button" class="printer-btn" data-action="printer">
          ${icon('print')}<span class="printer-btn__text">Thermal printer</span>
          <span class="printer-dot" data-region="printer-dot" aria-hidden="true"></span>
          <span class="sr-only" data-region="printer-state"></span>
        </button>
        <div class="user-chip">
          <span class="avatar" aria-hidden="true">${esc(initials(u.name))}</span>
          <span class="user-chip__text">
            <span class="user-chip__name">${esc(u.name)}</span>
            <span class="user-chip__role">${owner ? 'Owner' : 'Cashier'}</span>
          </span>
          <button type="button" class="icon-btn icon-btn--light" data-action="sign-out" aria-label="Sign out">${icon('logout')}</button>
        </div>
      </aside>
      <div class="scrim" data-action="close-nav" hidden></div>
      <main class="main" id="main" tabindex="-1"></main>
    </div>`;

  const shell = root.querySelector('.shell');
  const toggle = root.querySelector('[data-action=toggle-nav]');
  root.querySelector('[data-action=sign-out]').addEventListener('click', (e) => signOut(e.currentTarget));
  root.querySelector('[data-action=printer]').addEventListener('click', () => { setNav(false); printerDialog(); });
  printerCleanup?.();
  printerCleanup = printer.subscribePrinter((s) => {
    const dot = root.querySelector('[data-region=printer-dot]');
    if (!dot) return;
    dot.classList.toggle('is-on', Boolean(s.kind));
    root.querySelector('[data-region=printer-state]').textContent = s.kind ? `, connected: ${s.name}` : ', not connected';
  });
  root.querySelector('[data-action=clear-demo]')?.addEventListener('click', () => {
    if (!confirm('Clear all demo sales, expenses and open tables? Staff, tables and products stay.')) return;
    auth.clearDemoSales();
    toast('All demo sales cleared. Everything starts at zero.');
  });
  toggle.addEventListener('click', () => setNav(!shell.classList.contains('nav-open')));
  root.querySelector('[data-action=close-nav]').addEventListener('click', () => setNav(false));
  shell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('nav-open')) { setNav(false); toggle.focus(); } });
}

function setNav(open) {
  const shell = root.querySelector('.shell');
  if (!shell) return;
  shell.classList.toggle('nav-open', open);
  root.querySelector('.scrim').hidden = !open;
  const toggle = root.querySelector('[data-action=toggle-nav]');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}

function route() {
  const main = document.getElementById('main');
  if (!main || !state.user) return;
  let [name, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const r = ROUTES[name];
  if (!r || (r.owner && state.user.role !== 'owner')) {
    name = 'tables';
    params = [];
    history.replaceState(null, '', '#/tables');
  }

  viewCleanup?.();
  const el = document.createElement('div');
  el.className = 'view';
  main.replaceChildren(el);
  root.querySelectorAll('.nav__link').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  setNav(false);
  window.scrollTo(0, 0);
  document.title = `${ROUTES[name].label} · Golden Break`;
  viewCleanup = ROUTES[name].view.mount(el, { params: params.map(decodeURIComponent), user: state.user }) || null;
}
