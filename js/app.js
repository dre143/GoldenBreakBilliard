import { db, auth, mode } from './db.js';
import { state, set, emit, reset } from './state.js';
import { icon, esc, initials, toast, addDays, toolIcons } from './ui.js';
import { setServerOffset } from './clock.js';
import * as svc from './services.js';
import { renderAuth, renderPending } from './views/auth.js';
import * as tablesView from './views/tables.js';
import * as checkoutView from './views/checkout.js';
import * as quickSaleView from './views/quick-sale.js';
import * as inventoryView from './views/inventory.js';
import * as cueSticksView from './views/cue-sticks.js';
import * as showcaseView from './views/showcase.js';
import * as transactionsView from './views/transactions.js';
import * as dashboardView from './views/dashboard.js';
import * as staffView from './views/staff.js';
import * as reportsView from './views/reports.js';
import * as printer from './printer.js';
import { startTimeAlerts } from './time-alerts.js';
import { startHourAlerts } from './hour-alerts.js';
import { isOwnerLevel, isDisplay, roleLabel, usersQuery } from './roles.js';
import { printerDialog, cashDrawerDialog, gcashQrDialog } from './dialogs.js';

const root = document.getElementById('root');

// Phones, tablets (either orientation) and narrow windows get the top bar + slide-out menu; a desktop with
// a mouse keeps the sidebar. Detected here because tablet browsers/WebViews don't reliably report a
// touch screen through CSS media queries.
const isTouchTablet = /Android|iPad|iPhone|Tablet/i.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const narrow = window.matchMedia('(max-width: 1180px)');
const syncCompactNav = () => document.documentElement.classList.toggle('compact-nav', isTouchTablet || narrow.matches);
syncCompactNav();
narrow.addEventListener('change', syncCompactNav);

// Offline safety net (sw.js): lets the app reopen from its saved copy when the tablet has no internet.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const ROUTES = {
  tables: { label: 'Tables', icon: 'tables', view: tablesView },
  inventory: { label: 'Inventory', icon: 'box', view: inventoryView },
  checkout: { label: 'Checkout', icon: 'receipt', view: checkoutView },
  'quick-sale': { label: 'Quick Sale', icon: 'bag', view: quickSaleView },
  'cue-sticks': { label: 'Cue Sticks', icon: 'cue', view: cueSticksView },
  // Not in the sidebar nav (see below) — a fullscreen TV display, reached from a link on Cue Sticks.
  showcase: { label: 'Cue Stick Showcase', icon: 'cue', view: showcaseView },
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
    // #/showcase has no owner guard (a staff account can open it deliberately via the Cue Sticks page),
    // so a hash left over from whoever last used this device — a Display account, or someone testing —
    // would otherwise carry straight into a brand new sign-in. Only strip it at the moment an identity
    // is newly established, not on every route() call, so a deliberate visit mid-session is untouched.
    if (!isDisplay(state.user) && location.hash.replace(/^#\/?/, '').split('/')[0] === 'showcase') {
      history.replaceState(null, '', '#/tables');
    }
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
  // A display account's firestore.rules only allow reading tables and cue sticks (see isWorkingStaff()) —
  // subscribing to anything else would just log permission-denied errors for data it never uses.
  const display = isDisplay(state.user);
  dataCleanups = [
    db.listen('tables', (rows) => set('tables', rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || byName(a, b))), {}, onDataError),
    db.listen('cueSticks', (rows) => set('cueSticks', rows.sort(byName)), {}, onDataError),
  ];
  if (!display) {
    dataCleanups.push(
      db.listen('products', (rows) => set('products', rows.sort(byName)), {}, onDataError),
      // Superadmin accounts are filtered out at the database for everyone but a superadmin (see roles.js / firestore.rules).
      db.listen('users', (rows) => set('users', rows.sort(byName)), usersQuery(state.user), onDataError),
      db.listen('restocks', (rows) => set('restocks', rows), { where: [['createdAt', '>=', addDays(Date.now(), -7)]] }, onDataError),
      db.listenDoc('settings', 'shifts', (doc) => set('settings', { ...state.settings, twoShifts: !!doc?.twoShifts }), onDataError),
      db.listenDoc('settings', 'cashDrawer', (doc) => set('settings', { ...state.settings, drawerPinSet: !!doc?.pinHash }), onDataError),
      db.listenDoc('settings', 'gcash', (doc) => set('settings', { ...state.settings, gcashQr: doc?.qrImage || null }), onDataError),
    );
    printer.tryReconnect(); // quietly reconnect the last thermal printer, if the browser kept permission
    dataCleanups.push(startTimeAlerts()); // 5-minutes-left / expiry alerts for booked tables
    dataCleanups.push(startHourAlerts()); // 5-minute / 1-minute warning before each whole hour on a running table
  }
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
  const owner = isOwnerLevel(u);
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
        ${toolIcons('tool-icons--topbar', owner)}
      </header>
      <aside class="sidebar" id="sidebar">
        ${brand()}
        <nav class="nav" aria-label="Primary">
          ${['tables', 'inventory', 'checkout', 'quick-sale', 'cue-sticks', 'transactions', 'reports'].map(link).join('')}
          ${owner ? `<p class="nav__label">Owner</p>${['dashboard', 'staff'].map(link).join('')}` : ''}
        </nav>
        <div class="sidebar__spacer"></div>
        ${mode === 'demo' ? `<div class="demo-note">Demo mode · data is stored in this browser
          <button type="button" class="demo-note__btn" data-action="clear-demo">${icon('x')}Clear all sales</button></div>` : ''}
        <button type="button" class="printer-btn" data-tool="printer">
          ${icon('print')}<span class="printer-btn__text">Thermal printer</span>
          <span class="printer-dot" data-region="printer-dot" aria-hidden="true"></span>
          <span class="sr-only" data-region="printer-state"></span>
        </button>
        <button type="button" class="printer-btn printer-btn--drawer" data-tool="drawer">
          ${icon('box')}<span class="printer-btn__text">Cash drawer</span>
        </button>
        ${owner ? `
        <button type="button" class="printer-btn printer-btn--drawer" data-tool="gcash-qr">
          ${icon('qr')}<span class="printer-btn__text">QRPH code</span>
        </button>` : ''}
        <div class="user-chip">
          <span class="avatar" aria-hidden="true">${esc(initials(u.name))}</span>
          <span class="user-chip__text">
            <span class="user-chip__name">${esc(u.name)}</span>
            <span class="user-chip__role">${roleLabel(u.role)}</span>
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
  shell.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-tool]')?.dataset.tool;
    if (!tool) return;
    setNav(false);
    if (tool === 'printer') printerDialog();
    else if (tool === 'drawer') cashDrawerDialog();
    else if (tool === 'gcash-qr') gcashQrDialog();
    else if (tool === 'refresh') location.reload();
  });
  printerCleanup?.();
  printerCleanup = printer.subscribePrinter((s) => {
    shell.classList.toggle('printer-on', Boolean(s.kind));
    const dot = root.querySelector('[data-region=printer-dot]');
    if (!dot) return;
    dot.classList.toggle('is-on', Boolean(s.kind));
    root.querySelector('[data-region=printer-state]').textContent = s.kind ? `, connected: ${s.name}` : ', not connected';
  });
  root.querySelector('[data-action=clear-demo]')?.addEventListener('click', () => {
    if (!confirm('Clear all demo sales, expenses and open tables (and unsell every cue stick)? Staff, tables, products and cue sticks stay.')) return;
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
  // A display account (an unattended screen running Showcase) has nowhere else to go — every other
  // route, even one it could technically load, would just show live data it has no reason to see.
  if (isDisplay(state.user)) {
    if (name !== 'showcase') {
      name = 'showcase';
      params = [];
      history.replaceState(null, '', '#/showcase');
    }
  } else if (!r || (r.owner && !isOwnerLevel(state.user))) {
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
