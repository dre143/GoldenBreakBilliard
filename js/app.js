import { db, auth, mode } from './db.js';
import { state, set, emit, reset, on } from './state.js';
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
import { watchStackedTables } from './responsive.js';
import { startTimeAlerts } from './time-alerts.js';
import { mountPrinterPanel, mountDrawerPanel } from './dialogs.js';

const root = document.getElementById('root');

// Wide tables reflow into stacked cards on phones (labels are copied onto cells; see responsive.js).
watchStackedTables(document.body);

// Offline safety net (sw.js): lets the app reopen from its saved copy when the tablet has no internet.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

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
let quickbarCleanup = null;
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
    db.listenDoc('settings', 'cashDrawer', (doc) => set('settings', { ...state.settings, drawerPinSet: !!doc?.pinHash }), onDataError),
  ];
  printer.tryReconnect(); // quietly reconnect the last thermal printer, if the browser kept permission
  dataCleanups.push(startTimeAlerts()); // 15- and 5-minutes-left chimes for booked tables
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
  quickbarCleanup?.();
  quickbarCleanup = null;
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
    <img class="brand__mark-img brand__mark--rail" src="assets/logo-mark.png" alt="" width="160" height="160">
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
    return `<a class="nav__link" href="#/${key}" data-route="${key}" aria-label="${r.label}" title="${r.label}">${icon(r.icon)}<span>${r.label}</span></a>`;
  };
  root.innerHTML = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell">
      <header class="topbar">
        <button type="button" class="icon-btn icon-btn--light" data-action="toggle-nav" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">${icon('menu')}</button>
        ${brandCompact()}
        <div class="quickbar">
          <span class="quickbar__clock" data-region="clock"></span>
          <span class="quickbar__net" data-region="net" role="status"></span>
          <div class="qb-menu">
            <button type="button" class="qb-btn" data-qb="printer" aria-haspopup="true" aria-expanded="false" aria-controls="qb-printer">
              ${icon('print')}<span class="qb-dot" data-region="printer-dot" aria-hidden="true"></span>
              <span class="sr-only" data-region="printer-label">Thermal printer</span>
            </button>
            <div class="qb-pop" id="qb-printer" data-pop="printer" hidden>
              <p class="qb-pop__title">Thermal printer</p>
              <div data-region="printer-panel"></div>
            </div>
          </div>
          <div class="qb-menu">
            <button type="button" class="qb-btn" data-qb="drawer" aria-haspopup="true" aria-expanded="false" aria-controls="qb-drawer">
              ${icon('cash')}<span class="qb-dot" data-region="drawer-dot" aria-hidden="true"></span>
              <span class="sr-only" data-region="drawer-label">Cash drawer</span>
            </button>
            <div class="qb-pop" id="qb-drawer" data-pop="drawer" hidden>
              <p class="qb-pop__title">Cash drawer</p>
              <div data-region="drawer-panel"></div>
            </div>
          </div>
        </div>
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
  quickbarCleanup?.();
  quickbarCleanup = mountQuickbar(root.querySelector('.quickbar'));
  root.querySelector('[data-action=clear-demo]')?.addEventListener('click', () => {
    if (!confirm('Clear all demo sales, expenses and open tables? Staff, tables and products stay.')) return;
    auth.clearDemoSales();
    toast('All demo sales cleared. Everything starts at zero.');
  });
  toggle.addEventListener('click', () => setNav(!shell.classList.contains('nav-open')));
  root.querySelector('[data-action=close-nav]').addEventListener('click', () => setNav(false));
  shell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('nav-open')) { setNav(false); toggle.focus(); } });
}

/**
 * Top bar (like Marimar Inn's header), on every screen: date and time, online/offline, and the thermal
 * printer and cash drawer menus. Each menu drops down its panel in place, so a cashier can open the
 * drawer with the PIN from any page (end of shift, emergencies) without leaving what they're doing.
 */
function mountQuickbar(bar) {
  const $ = (sel) => bar.querySelector(sel);
  const cleanups = [];
  let openMenu = null; // { key, cleanup }

  const renderClock = () => {
    $('[data-region=clock]').textContent = new Date().toLocaleString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const renderNet = () => {
    const online = navigator.onLine;
    const el = $('[data-region=net]');
    el.className = `quickbar__net ${online ? '' : 'is-offline'}`;
    el.innerHTML = `${icon(online ? 'wifi' : 'wifiOff')}<span class="${online ? 'sr-only' : ''}">${online ? 'Online' : 'Offline'}</span>`;
    // Starting a table and taking payment use database transactions, which need the internet.
    el.title = online ? 'Online' : 'Offline: starting tables and taking payments need the internet';
  };
  const renderDots = () => {
    const s = printer.getPrinterState();
    $('[data-region=printer-dot]').classList.toggle('is-on', Boolean(s.kind));
    $('[data-region=printer-label]').textContent = `Thermal printer, ${s.kind ? `connected: ${s.name}` : 'not connected'}`;
    // Same as Marimar Inn: the drawer dot is green while "On cash pay" is on.
    $('[data-region=drawer-dot]').classList.toggle('is-on', printer.isDrawerEnabled());
    $('[data-region=drawer-label]').textContent = `Cash drawer, on cash pay ${printer.isDrawerEnabled() ? 'on' : 'off'}`;
  };

  function close() {
    if (!openMenu) return;
    openMenu.cleanup();
    $(`[data-pop=${openMenu.key}]`).hidden = true;
    $(`[data-qb=${openMenu.key}]`).setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  function open(key) {
    close();
    const pop = $(`[data-pop=${key}]`);
    const region = pop.querySelector('[data-region]');
    const cleanup = key === 'printer' ? mountPrinterPanel(region) : mountDrawerPanel(region);
    pop.hidden = false;
    $(`[data-qb=${key}]`).setAttribute('aria-expanded', 'true');
    openMenu = { key, cleanup };
  }

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-qb]');
    if (!btn) return;
    if (openMenu?.key === btn.dataset.qb) close();
    else open(btn.dataset.qb);
  });
  // Close on a tap outside, Escape, or moving to another page.
  const onDocDown = (e) => {
    if (openMenu && !e.target.closest('.qb-menu') && !e.target.closest('dialog')) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && openMenu) { const key = openMenu.key; close(); $(`[data-qb=${key}]`).focus(); }
  };
  document.addEventListener('pointerdown', onDocDown);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  window.addEventListener('online', renderNet);
  window.addEventListener('offline', renderNet);
  cleanups.push(
    () => document.removeEventListener('pointerdown', onDocDown),
    () => document.removeEventListener('keydown', onKey),
    () => window.removeEventListener('hashchange', close),
    () => window.removeEventListener('online', renderNet),
    () => window.removeEventListener('offline', renderNet),
    on('tick', renderClock),
    printer.subscribePrinter(renderDots),
    close,
  );
  renderClock();
  renderNet();
  return () => cleanups.forEach((fn) => fn());
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
