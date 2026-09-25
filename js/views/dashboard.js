import { db } from '../db.js';
import { state, on } from '../state.js';
import { isLowStock, activeSales } from '../billing.js';
import { cancelledGames, cancelInfo } from '../reporting.js';
import { addStockDialog } from '../dialogs.js';
import { roleLabel, visibleUsers } from '../roles.js';
import { HALL_TZ } from '../clock.js';
import { receiptDialog } from '../dialogs.js';
import { barChart } from './charts.js';
import {
  esc, icon, peso, fmtTime, todayLabel, startOfDay, addDays, relTime, initials,
  isOnline, METHOD_LABEL, pageHeader, loadingBlock, emptyBlock, toast,
} from '../ui.js';

export function mount(el, ctx) {
  let txs = null;

  el.innerHTML = `
    ${pageHeader({ title: 'Owner Dashboard', subtitle: esc(todayLabel()) })}
    <section class="stats" data-region="stats" aria-label="Today at a glance"></section>
    <div class="split">
      <div class="stack">
        <section class="card" aria-labelledby="chart-title">
          <div class="card-head">
            <div>
              <h2 class="card-title" id="chart-title">Revenue this week</h2>
              <p class="card-sub" data-region="week-total">&nbsp;</p>
            </div>
            <ul class="legend" aria-label="Legend">
              <li><span class="swatch swatch--felt" aria-hidden="true"></span>Table revenue</li>
              <li><span class="swatch swatch--amber" aria-hidden="true"></span>Product sales</li>
            </ul>
          </div>
          <div class="chart" data-region="chart"></div>
        </section>
        <section class="card" aria-labelledby="recent-title">
          <div class="card-head">
            <h2 class="card-title" id="recent-title">Recent transactions</h2>
            <a class="btn btn--neutral btn--sm" href="#/transactions">View all</a>
          </div>
          <ul class="tx-list" data-region="recent"></ul>
        </section>
      </div>
      <div class="stack">
        <section class="card" aria-labelledby="low-title">
          <div class="card-head">
            <h2 class="card-title" id="low-title">Low stock alerts</h2>
            <span class="badge badge--neutral" data-region="low-count"></span>
          </div>
          <ul class="alert-list" data-region="low"></ul>
        </section>
        <section class="card" aria-labelledby="voids-title">
          <div class="card-head">
            <h2 class="card-title" id="voids-title">Cancelled games today</h2>
            <span class="badge badge--neutral" data-region="voids-count"></span>
          </div>
          <ul class="alert-list" data-region="voids"></ul>
        </section>
        <section class="card" aria-labelledby="staff-title">
          <div class="card-head">
            <h2 class="card-title" id="staff-title">Staff on shift</h2>
            <a class="btn btn--neutral btn--sm" href="#/staff">Manage</a>
          </div>
          <ul class="staff-list" data-region="staff"></ul>
        </section>
      </div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);

  function renderStats() {
    const stats = $('[data-region=stats]');
    const active = state.tables.filter((t) => t.status !== 'available').length;
    if (!txs) {
      stats.innerHTML = loadingBlock('Loading sales…');
      return;
    }
    const t0 = startOfDay();
    const y0 = addDays(t0, -1);
    const elapsedToday = Date.now() - t0;
    const today = txs.filter((x) => x.createdAt >= t0);
    const sessionsToday = today.filter((x) => x.tableId);
    const yesterdaySoFar = txs.filter((x) => x.createdAt >= y0 && x.createdAt < y0 + elapsedToday);
    const sum = (list, f) => list.reduce((s, x) => s + (x[f] || 0), 0);
    const totalToday = sum(today, 'total');
    const totalYesterday = sum(yesterdaySoFar, 'total');
    let delta = '<span class="delta">No sales this time yesterday</span>';
    if (totalYesterday > 0) {
      const pct = ((totalToday - totalYesterday) / totalYesterday) * 100;
      const up = pct >= 0;
      delta = `<span class="delta ${up ? 'delta--up' : 'delta--down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(pct).toFixed(1)}% <span class="delta__ctx">vs this time yesterday</span></span>`;
    }
    const itemsSold = today.reduce((n, x) => n + (x.items || []).reduce((m, i) => m + i.qty, 0), 0);
    stats.innerHTML = `
      <article class="stat stat--dark">
        <p class="stat__label">Total sales today</p>
        <p class="stat__value num">${peso(totalToday)}</p>
        <p class="stat__sub">${delta}</p>
      </article>
      <article class="stat">
        <p class="stat__label">Billiard revenue</p>
        <p class="stat__value num">${peso(sum(today, 'tableFee'))}</p>
        <p class="stat__sub">${sessionsToday.length} session${sessionsToday.length === 1 ? '' : 's'} billed</p>
      </article>
      <article class="stat">
        <p class="stat__label">Product sales</p>
        <p class="stat__value num">${peso(sum(today, 'productTotal'))}</p>
        <p class="stat__sub">${itemsSold} item${itemsSold === 1 ? '' : 's'} sold</p>
      </article>
      <article class="stat">
        <p class="stat__label">Active tables</p>
        <p class="stat__value num">${active}<span class="stat__of">/${state.tables.length}</span></p>
        <p class="stat__sub">${state.tables.length - active} available</p>
      </article>`;
  }

  function renderChart() {
    const chart = $('[data-region=chart]');
    if (!txs) { chart.innerHTML = loadingBlock(); return; }
    const t0 = startOfDay();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const start = addDays(t0, -i);
      const end = addDays(start, 1);
      const list = txs.filter((x) => x.createdAt >= start && x.createdAt < end);
      days.push({
        label: new Date(start).toLocaleDateString('en-PH', { timeZone: HALL_TZ, weekday: 'short' }),
        full: new Date(start).toLocaleDateString('en-PH', { timeZone: HALL_TZ, weekday: 'long', month: 'short', day: 'numeric' }),
        table: list.reduce((s, x) => s + (x.tableFee || 0), 0),
        product: list.reduce((s, x) => s + (x.productTotal || 0), 0),
        today: i === 0,
      });
    }
    const weekTotal = days.reduce((s, d) => s + d.table + d.product, 0);
    $('[data-region=week-total]').textContent = `${peso(weekTotal)} over the last 7 days`;
    chart.innerHTML = barChart(days);
  }

  function renderRecent() {
    const list = $('[data-region=recent]');
    if (!txs) { list.innerHTML = `<li>${loadingBlock()}</li>`; return; }
    const recent = [...txs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    list.innerHTML = recent.length ? recent.map((x) => `
      <li>
        <button type="button" class="tx-row" data-id="${esc(x.id)}">
          <span class="tx-row__main">
            <span class="tx-row__title">${x.tableId ? esc(x.tableName) : `<span class="badge badge--neutral">${x.saleType === 'cue-stick' ? 'Cue Stick' : 'Walk-in'}</span>`}${cancelInfo(x) ? ' <span class="badge badge--danger">Cancelled</span>' : ''}</span>
            <span class="tx-row__sub">${fmtTime(x.createdAt)} · ${METHOD_LABEL[x.method] || esc(x.method)} · ${esc(x.cashierName)}</span>
          </span>
          <span class="tx-row__amount num">${peso(x.total)}</span>
        </button>
      </li>`).join('') : `<li>${emptyBlock('No transactions this week yet.')}</li>`;
  }

  /** Every game a cashier cancelled today (no table fee) — the owner's at-a-glance audit trail, since it needs no approval. */
  function renderVoids() {
    const countEl = $('[data-region=voids-count]');
    const list = $('[data-region=voids]');
    if (!txs) { countEl.textContent = ''; list.innerHTML = `<li>${loadingBlock()}</li>`; return; }
    const t0 = startOfDay();
    const todays = cancelledGames(txs.filter((x) => x.createdAt >= t0));
    countEl.textContent = `${todays.length} game${todays.length === 1 ? '' : 's'}`;
    countEl.classList.toggle('badge--danger', todays.length > 0);
    countEl.classList.toggle('badge--neutral', todays.length === 0);
    list.innerHTML = todays.length ? todays.map((x) => {
      const c = cancelInfo(x);
      return `
      <li>
        <button type="button" class="alert-item alert-item--action" data-id="${esc(x.id)}" aria-label="View receipt for ${esc(x.tableName)}, ${fmtTime(x.createdAt)}">
          <span class="alert-item__icon" aria-hidden="true">${icon('x')}</span>
          <span class="alert-item__text">
            <span class="alert-item__name">${esc(x.tableName)} · ${esc(c.by)}</span>
            <span class="alert-item__sub">${esc(c.reason)} · ${fmtTime(c.at)}</span>
          </span>
        </button>
      </li>`;
    }).join('') : `<li class="all-good">${icon('check')}No games cancelled today.</li>`;
  }

  function renderLowStock() {
    const low = state.products.filter(isLowStock).sort((a, b) => a.stock / (a.reorderLevel || 1) - b.stock / (b.reorderLevel || 1));
    const lowCountEl = $('[data-region=low-count]');
    lowCountEl.textContent = `${low.length} item${low.length === 1 ? '' : 's'}`;
    lowCountEl.classList.toggle('badge--danger', low.length > 0);
    lowCountEl.classList.toggle('badge--neutral', low.length === 0);
    $('[data-region=low]').innerHTML = low.length ? low.map((p) => `
      <li class="alert-item">
        <span class="alert-item__icon" aria-hidden="true">${icon('alert')}</span>
        <span class="alert-item__text">
          <span class="alert-item__name">${esc(p.name)}</span>
          <span class="alert-item__sub"><span class="num">${p.stock}</span> left · reorder at <span class="num">${p.reorderLevel}</span></span>
        </span>
        <button type="button" class="btn btn--restock btn--sm" data-restock="${esc(p.id)}" aria-label="Restock ${esc(p.name)}">${icon('restock')}Restock</button>
      </li>`).join('') : `<li class="all-good">${icon('check')}All products are above their reorder level.</li>`;
  }

  function renderStaff() {
    const staff = visibleUsers(state.users, ctx.user)
      .filter((u) => u.active !== false)
      .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || a.name.localeCompare(b.name));
    $('[data-region=staff]').innerHTML = staff.map((u) => {
      const online = isOnline(u);
      return `
      <li class="staff-row">
        <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(u.name))}</span>
        <span class="staff-row__text">
          <span class="staff-row__name">${esc(u.name)}${u.id === ctx.user.uid ? ' <span class="muted">(you)</span>' : ''}</span>
          <span class="staff-row__role">${roleLabel(u.role)}</span>
        </span>
        <span class="presence ${online ? 'is-online' : ''}">
          <span class="presence__dot" aria-hidden="true"></span>${online ? 'Online' : `Offline · ${relTime(u.lastSeen)}`}
        </span>
      </li>`;
    }).join('');
  }

  el.addEventListener('click', (e) => {
    const restock = e.target.closest('[data-restock]');
    if (restock) {
      const p = state.products.find((x) => x.id === restock.dataset.restock);
      if (p) addStockDialog(p, ctx.user);
      return;
    }
    const row = e.target.closest('.tx-row, [data-id].alert-item--action');
    const tx = row && txs?.find((x) => x.id === row.dataset.id);
    if (tx) receiptDialog(tx);
  });

  const offs = [
    on('tables', renderStats),
    on('products', renderLowStock),
    on('users', renderStaff),
    db.listen('transactions', (rows) => {
      txs = activeSales(rows);
      renderStats();
      renderChart();
      renderRecent();
      renderVoids();
    }, { where: [['createdAt', '>=', addDays(startOfDay(), -6)]] }, (err) => toast(err.message, 'error')),
  ];
  const presenceTimer = setInterval(renderStaff, 60000);

  renderStats();
  renderChart();
  renderRecent();
  renderVoids();
  renderLowStock();
  renderStaff();
  return () => { offs.forEach((off) => off()); clearInterval(presenceTimer); };
}
