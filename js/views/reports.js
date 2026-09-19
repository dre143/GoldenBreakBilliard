import { db } from '../db.js';
import * as rep from '../reporting.js';
import { barChart } from './charts.js';
import { receiptDialog } from '../dialogs.js';
import * as svc from '../services.js';
import {
  esc, icon, peso, fmtTime, fmtDateTime, METHOD_LABEL, pageHeader, loadingBlock, emptyBlock, toast, openDialog,
} from '../ui.js';

const TABS = [
  { key: 'sales', label: 'Sales' },
  { key: 'payments', label: 'Payments' },
  { key: 'shifts', label: 'By cashier' },
  { key: 'expenses', label: 'Expenses' },
];

const PRESETS = [
  { key: 'today', label: 'Today', range: (t) => [t, t] },
  { key: 'yesterday', label: 'Yesterday', range: (t) => [rep.shiftKey(t, -1), rep.shiftKey(t, -1)] },
  { key: '7d', label: '7 days', range: (t) => [rep.shiftKey(t, -6), t] },
  { key: '30d', label: '30 days', range: (t) => [rep.shiftKey(t, -29), t] },
];

const MAX_DAYS = 92;
const hours = (ms) => `${(ms / 3600000).toFixed(1)} h`;

export function mount(el, ctx) {
  const today = rep.dayKey(Date.now());
  let preset = 'today';
  let [fromKey, toKey] = [today, today];
  let tab = 'sales';
  let txs = null;
  let expenses = null;
  let unsubs = [];

  const timeLabel = (h, m) => new Date(2000, 0, 1, h, m).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  const startHour = timeLabel(rep.BUSINESS_DAY_START_HOUR, 0);
  const endTime = timeLabel((rep.BUSINESS_DAY_START_HOUR + 23) % 24, 59);

  el.innerHTML = `
    ${pageHeader({
      title: 'Reports',
      subtitle: '<span data-region="range-label"></span>',
      actions: `
        <button type="button" class="btn btn--neutral" data-action="csv">${icon('download')}Export CSV</button>
        <button type="button" class="btn btn--neutral" data-action="print">${icon('print')}Print</button>`,
    })}
    <section class="card report-range" aria-label="Report period">
      <div class="seg seg--inline" role="radiogroup" aria-label="Quick range">
        ${PRESETS.map((p) => `
          <label class="seg__opt">
            <input type="radio" name="rep-preset" value="${p.key}" ${p.key === preset ? 'checked' : ''}>
            <span>${p.label}</span>
          </label>`).join('')}
      </div>
      <div class="report-range__dates">
        <div class="field">
          <label for="rep-from">From</label>
          <input id="rep-from" type="date" value="${fromKey}" max="${today}">
        </div>
        <div class="field">
          <label for="rep-to">To</label>
          <input id="rep-to" type="date" value="${toKey}" max="${today}">
        </div>
      </div>
      <p class="report-range__note">A business day runs from ${esc(startHour)} to ${esc(endTime)} the next morning, so after-midnight sales count toward the night they belong to.</p>
    </section>
    <div class="tabs" role="tablist" aria-label="Report type">
      ${TABS.map((t) => `
        <button type="button" role="tab" class="tab" id="tab-${t.key}" aria-controls="panel-${t.key}"
          aria-selected="${t.key === tab}" tabindex="${t.key === tab ? 0 : -1}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    ${TABS.map((t) => `<section class="report-panel" role="tabpanel" id="panel-${t.key}" aria-labelledby="tab-${t.key}" tabindex="0" ${t.key === tab ? '' : 'hidden'}></section>`).join('')}`;

  const $ = (sel) => el.querySelector(sel);
  const panel = (key) => $(`#panel-${key}`);
  const fromInput = $('#rep-from');
  const toInput = $('#rep-to');

  /* ---------- data ---------- */

  function subscribe() {
    unsubs.forEach((off) => off());
    txs = null;
    expenses = null;
    render();
    const start = rep.keyToStart(fromKey);
    const end = rep.keyToStart(rep.shiftKey(toKey, 1));
    const range = { where: [['createdAt', '>=', start], ['createdAt', '<', end]] };
    const onError = (err) => toast(err.message, 'error');
    unsubs = [
      db.listen('transactions', (rows) => { txs = rows; render(); }, range, onError),
      db.listen('expenses', (rows) => { expenses = rows.sort((a, b) => b.createdAt - a.createdAt); render(); }, range, onError),
    ];
  }

  function setRange(from, to, nextPreset) {
    if (!from || !to) return;
    if (from > to) [from, to] = [to, from];
    if (rep.dayKeys(from, to).length > MAX_DAYS) {
      toast(`Choose a range of ${MAX_DAYS} days or less.`, 'error');
      fromInput.value = fromKey;
      toInput.value = toKey;
      return;
    }
    [fromKey, toKey, preset] = [from, to, nextPreset];
    fromInput.value = fromKey;
    toInput.value = toKey;
    el.querySelectorAll('input[name=rep-preset]').forEach((r) => { r.checked = r.value === preset; });
    subscribe();
  }

  /* ---------- rendering ---------- */

  function rangeLabel() {
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    return fromKey === toKey ? rep.keyLabel(fromKey, opts) : `${rep.keyLabel(fromKey, opts)} – ${rep.keyLabel(toKey, opts)}`;
  }

  const stat = (label, value, sub = '', cls = '') => `
    <article class="stat ${cls}">
      <p class="stat__label">${label}</p>
      <p class="stat__value num">${value}</p>
      <p class="stat__sub">${sub}</p>
    </article>`;

  function renderSales(target) {
    const t = rep.totals(txs, expenses);
    const days = rep.byDay(txs, fromKey, toKey, expenses);
    const products = rep.topProducts(txs);
    const many = days.length > 14;
    const chartDays = days.map((d, i) => ({
      label: !many || i % Math.ceil(days.length / 10) === 0 ? rep.keyLabel(d.key, many ? { month: 'short', day: 'numeric' } : { weekday: 'short' }) : '',
      full: rep.keyLabel(d.key, { weekday: 'long', month: 'short', day: 'numeric' }),
      table: d.tableFee,
      product: d.productTotal,
      today: d.key === today,
    }));
    target.innerHTML = `
      <div class="stats">
        ${stat('Total sales', peso(t.total), `Tables ${peso(t.tableFee)} · Products ${peso(t.productTotal)}`)}
        ${stat('Expenses', peso(t.expenses), t.expenseCount ? `${t.expenseCount} item${t.expenseCount === 1 ? '' : 's'} paid from the drawer` : 'None', t.expenses ? 'stat--danger' : '')}
        ${stat('Net sales', peso(t.net), 'Total sales − expenses', 'stat--dark')}
        ${stat('Transactions', t.count, t.count ? `${hours(t.durationMs)} played · ${t.items} items sold` : 'No sales yet')}
      </div>
      ${days.length > 1 ? `
      <section class="card" aria-labelledby="rep-chart-title">
        <div class="card-head">
          <h2 class="card-title" id="rep-chart-title">Daily sales</h2>
          <ul class="legend" aria-label="Legend">
            <li><span class="swatch swatch--felt" aria-hidden="true"></span>Table revenue</li>
            <li><span class="swatch swatch--amber" aria-hidden="true"></span>Product sales</li>
          </ul>
        </div>
        <div class="chart">${barChart(chartDays)}</div>
      </section>` : ''}
      <section class="card card--flush" aria-labelledby="rep-days-title">
        <div class="toolbar"><h2 class="card-title" id="rep-days-title">Sales by business day</h2></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th scope="col">Business day</th>
              <th scope="col" class="t-right">Transactions</th>
              <th scope="col" class="t-right">Hours played</th>
              <th scope="col" class="t-right">Rounds</th>
              <th scope="col" class="t-right">Table revenue</th>
              <th scope="col" class="t-right">Product sales</th>
              <th scope="col" class="t-right">Total</th>
              <th scope="col" class="t-right">Expenses</th>
              <th scope="col" class="t-right">Net</th>
            </tr></thead>
            <tbody>
              ${days.map((d) => `
              <tr class="${d.count || d.expenseCount ? '' : 'row-muted'}">
                <th scope="row" class="cell-nowrap">${rep.keyLabel(d.key)}</th>
                <td class="t-right num cell-num">${d.count}</td>
                <td class="t-right num cell-num">${hours(d.durationMs)}</td>
                <td class="t-right num cell-num">${d.rounds}</td>
                <td class="t-right num cell-num">${peso(d.tableFee)}</td>
                <td class="t-right num cell-num">${peso(d.productTotal)}</td>
                <td class="t-right num cell-num">${peso(d.total)}</td>
                <td class="t-right num cell-num">${peso(d.expenses)}</td>
                <td class="t-right num cell-num cell-total">${peso(d.net)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <th scope="row">Total</th>
              <td class="t-right num cell-num">${t.count}</td>
              <td class="t-right num cell-num">${hours(t.durationMs)}</td>
              <td class="t-right num cell-num">${t.rounds}</td>
              <td class="t-right num cell-num">${peso(t.tableFee)}</td>
              <td class="t-right num cell-num">${peso(t.productTotal)}</td>
              <td class="t-right num cell-num">${peso(t.total)}</td>
              <td class="t-right num cell-num">${peso(t.expenses)}</td>
              <td class="t-right num cell-num cell-total">${peso(t.net)}</td>
            </tr></tfoot>
          </table>
        </div>
      </section>
      <section class="card card--flush" aria-labelledby="rep-products-title">
        <div class="toolbar"><h2 class="card-title" id="rep-products-title">Top products</h2></div>
        <div class="table-wrap">
          ${products.length ? `
          <table class="data-table">
            <thead><tr>
              <th scope="col">#</th>
              <th scope="col">Product</th>
              <th scope="col">Category</th>
              <th scope="col" class="t-right">Qty sold</th>
              <th scope="col" class="t-right">Revenue</th>
            </tr></thead>
            <tbody>
              ${products.map((p, i) => `
              <tr>
                <td class="num cell-num">${i + 1}</td>
                <th scope="row" class="cell-strong">${esc(p.name)}</th>
                <td>${esc(p.category || '—')}</td>
                <td class="t-right num cell-num">${p.qty}</td>
                <td class="t-right num cell-num">${peso(p.revenue)}</td>
              </tr>`).join('')}
            </tbody>
          </table>` : emptyBlock('No products sold in this period.')}
        </div>
      </section>
      ${renderVoidsSection()}`;
  }

  /**
   * Table-fee voids in the period: the owner's audit trail for a cashier action that needs no
   * approval — who waived which table's fee, why, and how much was refunded.
   */
  function renderVoidsSection() {
    const list = rep.voidedSales(txs);
    const { count, refunded } = rep.voidedTotals(txs);
    return `
      <section class="card card--flush" aria-labelledby="rep-voids-title">
        <div class="toolbar">
          <h2 class="card-title" id="rep-voids-title">Table fee voids</h2>
          ${count ? `<span class="badge badge--danger">${count} · ${peso(refunded)} refunded</span>` : ''}
        </div>
        <div class="table-wrap">
          ${list.length ? `
          <table class="data-table">
            <thead><tr>
              <th scope="col">Voided</th>
              <th scope="col">Table</th>
              <th scope="col">Cashier</th>
              <th scope="col">Reason</th>
              <th scope="col" class="t-right">Refunded</th>
              <th scope="col"><span class="sr-only">Receipt</span></th>
            </tr></thead>
            <tbody>
              ${list.map((x) => `
              <tr>
                <td class="cell-nowrap">${fmtDateTime(x.tableFeeVoidedAt)}</td>
                <th scope="row" class="cell-strong">${esc(x.tableName)}</th>
                <td>${esc(x.cashierName)}</td>
                <td>${esc(x.voidReason)}${x.voidNote ? ` <span class="muted small">“${esc(x.voidNote)}”</span>` : ''}</td>
                <td class="t-right num cell-num cell-total">${peso(x.refundAmount)}</td>
                <td class="t-right"><button type="button" class="btn btn--neutral btn--sm" data-void-id="${esc(x.id)}" aria-label="View receipt for ${esc(x.tableName)}, ${fmtDateTime(x.createdAt)}">${icon('receipt')}View</button></td>
              </tr>`).join('')}
            </tbody>
          </table>` : emptyBlock('No table fees waived in this period.')}
        </div>
      </section>`;
  }

  function renderPayments(target) {
    const t = rep.totals(txs, expenses);
    const m = rep.byMethod(txs);
    const days = rep.byDay(txs, fromKey, toKey, expenses);
    const methodRows = [
      ['Cash', m.cash],
      ['GCash', m.gcash],
      ['Split (cash + GCash)', m.split],
      ...(m.other.count ? [['Other (legacy)', m.other]] : []),
    ];
    target.innerHTML = `
      <div class="stats">
        ${stat('Cash collected', peso(t.cash), 'Includes the cash part of splits', 'stat--dark')}
        ${stat('GCash collected', peso(t.gcash), 'Includes the GCash part of splits')}
        ${stat('Split payments', m.split.count, m.split.count ? `${peso(m.split.cash)} cash · ${peso(m.split.gcash)} GCash` : 'None in this period')}
        ${stat('Total collected', peso(t.total), `${t.count} transactions${t.other ? ` · ${peso(t.other)} other` : ''}`)}
      </div>
      <section class="card card--flush" aria-labelledby="rep-methods-title">
        <div class="toolbar"><h2 class="card-title" id="rep-methods-title">By payment method</h2></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th scope="col">Method</th>
              <th scope="col" class="t-right">Transactions</th>
              <th scope="col" class="t-right">Share</th>
              <th scope="col" class="t-right">Cash</th>
              <th scope="col" class="t-right">GCash</th>
              <th scope="col" class="t-right">Total</th>
            </tr></thead>
            <tbody>
              ${methodRows.map(([label, r]) => `
              <tr class="${r.count ? '' : 'row-muted'}">
                <th scope="row" class="cell-strong">${label}</th>
                <td class="t-right num cell-num">${r.count}</td>
                <td class="t-right num cell-num">${t.total ? `${Math.round((r.total / t.total) * 100)}%` : '—'}</td>
                <td class="t-right num cell-num">${peso(r.cash)}</td>
                <td class="t-right num cell-num">${peso(r.gcash)}</td>
                <td class="t-right num cell-num cell-total">${peso(r.total)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <th scope="row">Total</th>
              <td class="t-right num cell-num">${t.count}</td>
              <td class="t-right num cell-num">${t.total ? '100%' : '—'}</td>
              <td class="t-right num cell-num">${peso(t.cash)}</td>
              <td class="t-right num cell-num">${peso(t.gcash)}</td>
              <td class="t-right num cell-num cell-total">${peso(t.total)}</td>
            </tr></tfoot>
          </table>
        </div>
      </section>
      <section class="card card--flush" aria-labelledby="rep-paydays-title">
        <div class="toolbar"><h2 class="card-title" id="rep-paydays-title">Collections by business day</h2></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th scope="col">Business day</th>
              <th scope="col" class="t-right">Transactions</th>
              <th scope="col" class="t-right">Cash</th>
              <th scope="col" class="t-right">GCash</th>
              <th scope="col" class="t-right">Total</th>
              <th scope="col" class="t-right">Expenses</th>
              <th scope="col" class="t-right">Cash on hand</th>
            </tr></thead>
            <tbody>
              ${days.map((d) => `
              <tr class="${d.count || d.expenseCount ? '' : 'row-muted'}">
                <th scope="row" class="cell-nowrap">${rep.keyLabel(d.key)}</th>
                <td class="t-right num cell-num">${d.count}</td>
                <td class="t-right num cell-num">${peso(d.cash)}</td>
                <td class="t-right num cell-num">${peso(d.gcash)}</td>
                <td class="t-right num cell-num">${peso(d.total)}</td>
                <td class="t-right num cell-num">${peso(d.expenses)}</td>
                <td class="t-right num cell-num cell-total">${peso(d.cashToCount)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <th scope="row">Total</th>
              <td class="t-right num cell-num">${t.count}</td>
              <td class="t-right num cell-num">${peso(t.cash)}</td>
              <td class="t-right num cell-num">${peso(t.gcash)}</td>
              <td class="t-right num cell-num">${peso(t.total)}</td>
              <td class="t-right num cell-num">${peso(t.expenses)}</td>
              <td class="t-right num cell-num cell-total">${peso(t.cashToCount)}</td>
            </tr></tfoot>
          </table>
        </div>
      </section>`;
  }

  function renderShifts(target) {
    const rows = rep.byShift(txs, expenses);
    const t = rep.totals(txs, expenses);
    const cashiers = new Set(rows.map((r) => r.cashierId)).size;
    target.innerHTML = `
      <div class="stats">
        ${stat('Shifts', rows.length, `${cashiers} cashier${cashiers === 1 ? '' : 's'}`, 'stat--dark')}
        ${stat('Cash sales', peso(t.cash), 'Includes the cash part of splits')}
        ${stat('Expenses', peso(t.expenses), 'Paid from the drawer')}
        ${stat('Cash to hand over', peso(t.cashToCount), 'Cash sales − expenses')}
      </div>
      <p class="report-hint">One row per cashier per business day: what they collected, what they paid out of the drawer, and the cash they should hand over.</p>
      <section class="card card--flush" aria-labelledby="rep-shifts-title">
        <div class="toolbar"><h2 class="card-title" id="rep-shifts-title">Shift report</h2></div>
        <div class="table-wrap">
          ${rows.length ? `
          <table class="data-table">
            <thead><tr>
              <th scope="col">Cashier · business day</th>
              <th scope="col" class="t-right">Sales</th>
              <th scope="col" class="t-right">Items</th>
              <th scope="col" class="t-right">Table revenue</th>
              <th scope="col" class="t-right">Product sales</th>
              <th scope="col" class="t-right">Cash</th>
              <th scope="col" class="t-right">GCash</th>
              <th scope="col" class="t-right">Total</th>
              <th scope="col" class="t-right">Expenses</th>
              <th scope="col" class="t-right">Cash to hand over</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
              <tr>
                <th scope="row">
                  <span class="cell-strong">${esc(r.cashierName)}</span>
                  <span class="cell-sub cell-nowrap">${rep.keyLabel(r.day)} · ${fmtTime(r.firstAt)} – ${fmtTime(r.lastAt)}</span>
                </th>
                <td class="t-right num cell-num">${r.count}</td>
                <td class="t-right num cell-num">${r.items}</td>
                <td class="t-right num cell-num">${peso(r.tableFee)}</td>
                <td class="t-right num cell-num">${peso(r.productTotal)}</td>
                <td class="t-right num cell-num">${peso(r.cash)}</td>
                <td class="t-right num cell-num">${peso(r.gcash)}</td>
                <td class="t-right num cell-num">${peso(r.total)}</td>
                <td class="t-right num cell-num">${peso(r.expenses)}</td>
                <td class="t-right num cell-num cell-total">${peso(r.cashToCount)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <th scope="row">Total</th>
              <td class="t-right num cell-num">${t.count}</td>
              <td class="t-right num cell-num">${t.items}</td>
              <td class="t-right num cell-num">${peso(t.tableFee)}</td>
              <td class="t-right num cell-num">${peso(t.productTotal)}</td>
              <td class="t-right num cell-num">${peso(t.cash)}</td>
              <td class="t-right num cell-num">${peso(t.gcash)}</td>
              <td class="t-right num cell-num">${peso(t.total)}</td>
              <td class="t-right num cell-num">${peso(t.expenses)}</td>
              <td class="t-right num cell-num cell-total">${peso(t.cashToCount)}</td>
            </tr></tfoot>
          </table>` : emptyBlock('No shifts in this period.', 'Shifts appear once a cashier completes a sale or logs an expense.')}
        </div>
      </section>`;
  }

  /** Every expense in the period, newest first. The owner can remove one that was logged by mistake. */
  function renderExpenses(target) {
    const t = rep.totals(txs, expenses);
    const days = rep.dayKeys(fromKey, toKey).length;
    const biggest = expenses.reduce((m, e) => (!m || e.amount > m.amount ? e : m), null);
    target.innerHTML = `
      <div class="stats">
        ${stat('Total expenses', peso(t.expenses), `${t.expenseCount} item${t.expenseCount === 1 ? '' : 's'}`, 'stat--dark')}
        ${stat('Daily average', peso(t.expenses / days), `over ${days} business day${days === 1 ? '' : 's'}`)}
        ${stat('Largest', biggest ? peso(biggest.amount) : '—', biggest ? esc(biggest.description) : 'No expenses')}
        ${stat('Net sales', peso(t.net), `${peso(t.total)} sales − expenses`)}
      </div>
      <section class="card card--flush" aria-labelledby="rep-exp-title">
        <div class="toolbar"><h2 class="card-title" id="rep-exp-title">Expenses</h2></div>
        <div class="table-wrap">
          ${expenses.length ? `
          <table class="data-table">
            <thead><tr>
              <th scope="col">Date &amp; time</th>
              <th scope="col">What for</th>
              <th scope="col">Logged by</th>
              <th scope="col" class="t-right">Amount</th>
              <th scope="col"><span class="sr-only">Remove</span></th>
            </tr></thead>
            <tbody>
              ${expenses.map((e) => `
              <tr>
                <td class="cell-nowrap">${fmtDateTime(e.createdAt)}</td>
                <th scope="row" class="cell-strong">${esc(e.description)}</th>
                <td>${esc(e.cashierName)}</td>
                <td class="t-right num cell-num">${peso(e.amount)}</td>
                <td class="t-right"><button type="button" class="btn btn--danger-ghost btn--sm" data-remove-expense="${esc(e.id)}" aria-label="Remove expense: ${esc(e.description)}">Remove</button></td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <th scope="row" colspan="3">Total</th>
              <td class="t-right num cell-num cell-total">${peso(t.expenses)}</td>
              <td></td>
            </tr></tfoot>
          </table>` : emptyBlock('No expenses in this period.', 'Cashiers log expenses from the Shift Report page.')}
        </div>
      </section>`;
  }

  function confirmRemoveExpense(expense) {
    openDialog({
      title: 'Remove expense?',
      body: `<p><strong>${esc(expense.description)}</strong>, ${peso(expense.amount)}, logged by ${esc(expense.cashierName)} on ${fmtDateTime(expense.createdAt)}.</p>
        <p class="muted small">Remove it only if it was entered by mistake. It will no longer be subtracted from that shift's cash.</p>`,
      submitLabel: 'Remove expense',
      submitClass: 'btn--danger',
      onSubmit: async () => {
        await svc.removeExpense(expense.id);
        toast('Expense removed.');
      },
    });
  }

  function render() {
    $('[data-region=range-label]').textContent = rangeLabel();
    const target = panel(tab);
    if (!txs || !expenses) { target.innerHTML = loadingBlock('Loading report…'); return; }
    if (tab === 'sales') renderSales(target);
    if (tab === 'payments') renderPayments(target);
    if (tab === 'shifts') renderShifts(target);
    if (tab === 'expenses') renderExpenses(target);
  }

  function selectTab(key, focus = false) {
    tab = key;
    el.querySelectorAll('[role=tab]').forEach((b) => {
      const on = b.dataset.tab === key;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    TABS.forEach((t) => { panel(t.key).hidden = t.key !== key; });
    render();
  }

  /* ---------- export ---------- */

  function csvRows() {
    const range = [`Golden Break Billiard Hall ${TABS.find((t) => t.key === tab).label} report`, `${fromKey} to ${toKey}`];
    const t = rep.totals(txs, expenses);
    if (tab === 'expenses') {
      return [range, [],
        ['Date', 'Time', 'What for', 'Logged by', 'Amount'],
        ...expenses.map((e) => [rep.dayKey(e.createdAt), fmtTime(e.createdAt), e.description, e.cashierName, e.amount]),
        ['Total', '', '', '', t.expenses],
        [], ['Gross sales', t.total], ['Expenses', t.expenses], ['Net sales', t.net]];
    }
    if (tab === 'sales') {
      const days = rep.byDay(txs, fromKey, toKey, expenses);
      return [range, [],
        ['Business day', 'Transactions', 'Hours played', 'Rounds', 'Table revenue', 'Product sales', 'Total', 'Expenses', 'Net'],
        ...days.map((d) => [d.key, d.count, (d.durationMs / 3600000).toFixed(2), d.rounds, d.tableFee, d.productTotal, d.total, d.expenses, d.net]),
        ['Total', t.count, (t.durationMs / 3600000).toFixed(2), t.rounds, t.tableFee, t.productTotal, t.total, t.expenses, t.net],
        [], ['Rank', 'Product', 'Category', 'Qty sold', 'Revenue'],
        ...rep.topProducts(txs, 1000).map((p, i) => [i + 1, p.name, p.category, p.qty, p.revenue]),
        [], ['Table fee voids'], ['Voided', 'Table', 'Cashier', 'Reason', 'Note', 'Refunded'],
        ...rep.voidedSales(txs).map((x) => [fmtDateTime(x.tableFeeVoidedAt), x.tableName, x.cashierName, x.voidReason, x.voidNote || '', x.refundAmount])];
    }
    if (tab === 'payments') {
      const m = rep.byMethod(txs);
      return [range, [],
        ['Method', 'Transactions', 'Cash', 'GCash', 'Total'],
        ...[['cash', m.cash], ['gcash', m.gcash], ['split', m.split], ['other', m.other]].map(([k, r]) => [METHOD_LABEL[k] || 'Other', r.count, r.cash, r.gcash, r.total]),
        ['Total', t.count, t.cash, t.gcash, t.total],
        [], ['Business day', 'Transactions', 'Cash', 'GCash', 'Total', 'Expenses', 'Cash on hand'],
        ...rep.byDay(txs, fromKey, toKey, expenses).map((d) => [d.key, d.count, d.cash, d.gcash, d.total, d.expenses, d.cashToCount]),
        ['Total', t.count, t.cash, t.gcash, t.total, t.expenses, t.cashToCount]];
    }
    return [range, [],
      ['Business day', 'Cashier', 'First activity', 'Last activity', 'Transactions', 'Items sold', 'Table revenue', 'Product sales', 'Cash', 'GCash', 'Total', 'Expenses', 'Cash to hand over'],
      ...rep.byShift(txs, expenses).map((r) => [r.day, r.cashierName, fmtTime(r.firstAt), fmtTime(r.lastAt), r.count, r.items, r.tableFee, r.productTotal, r.cash, r.gcash, r.total, r.expenses, r.cashToCount]),
      ['Total', '', '', '', t.count, t.items, t.tableFee, t.productTotal, t.cash, t.gcash, t.total, t.expenses, t.cashToCount]];
  }

  function exportCsv() {
    if (!txs || !expenses) return;
    const blob = new Blob(['﻿', rep.toCsv(csvRows())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `golden-break-${tab}-${fromKey}_to_${toKey}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- events ---------- */

  el.querySelectorAll('input[name=rep-preset]').forEach((r) => r.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.key === r.value);
    const [from, to] = p.range(today);
    setRange(from, to, p.key);
  }));
  fromInput.addEventListener('change', () => setRange(fromInput.value, toInput.value || fromInput.value, 'custom'));
  toInput.addEventListener('change', () => setRange(fromInput.value || toInput.value, toInput.value, 'custom'));

  const tablist = $('[role=tablist]');
  tablist.addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) selectTab(b.dataset.tab); });
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length].key, true);
  });

  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'csv') exportCsv();
    if (action === 'print') window.print();
    const voidBtn = e.target.closest('[data-void-id]');
    const tx = voidBtn && txs?.find((x) => x.id === voidBtn.dataset.voidId);
    if (tx) receiptDialog(tx);
    const removeBtn = e.target.closest('[data-remove-expense]');
    const expense = removeBtn && expenses?.find((x) => x.id === removeBtn.dataset.removeExpense);
    if (expense) confirmRemoveExpense(expense);
  });

  subscribe();
  return () => unsubs.forEach((off) => off());
}
