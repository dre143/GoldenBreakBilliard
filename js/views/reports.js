// Reports, laid out like the Marimar Inn reports: one page, the same shape on every tab.
//   Daily         — the paper-style Daily Sales Report for one business day (or one shift), the
//                   expense log, and the end-of-shift cash count. Cashiers see only this tab.
//   Custom range  — totals, sales vs expenses by day, and every expense in a date range (owner).
//   Monthly       — the month's totals, sales trend, revenue by table and top products (owner).
// Every tab: pickers on the left, Export CSV / Print on the right, one row of number cards, plain tables.
import { db } from '../db.js';
import { state, on } from '../state.js';
import * as rep from '../reporting.js';
import * as svc from '../services.js';
import { barChart } from './charts.js';
import { receiptDialog, printerDialog, thermalPreviewDialog, cashDrawerDialog, openDrawerDialog } from '../dialogs.js';
import * as printer from '../printer.js';
import {
  esc, icon, peso, fmtTime, fmtDateTime, fmtHuman, fmtBooking, METHOD_LABEL, pageHeader, loadingBlock, emptyBlock,
  toast, busy, openDialog,
} from '../ui.js';
import { isOwnerLevel } from '../roles.js';

const HALL = 'Golden Break Billiard Hall';
const MAX_RANGE_DAYS = 92;

const TABS = [
  { key: 'daily', label: 'Daily', mount: dailyTab },
  { key: 'range', label: 'Custom range', mount: rangeTab },
  { key: 'monthly', label: 'Monthly', mount: monthlyTab },
];

export function mount(el, ctx) {
  const owner = isOwnerLevel(ctx.user);
  el.innerHTML = `
    ${pageHeader({
      title: 'Reports',
      subtitle: owner
        ? 'Daily sales sheet, custom range and monthly totals, with expenses and net sales.'
        : 'Today’s sales and expenses. Print or export it to hand off at the end of your shift.',
    })}
    ${owner ? `
    <div class="tabs" role="tablist" aria-label="Report type">
      ${TABS.map((t, i) => `
        <button type="button" role="tab" class="tab" id="tab-${t.key}" aria-controls="report-panel"
          aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>` : ''}
    <section class="report-panel" id="report-panel" ${owner ? 'role="tabpanel" aria-labelledby="tab-daily"' : ''}></section>`;

  const panel = el.querySelector('#report-panel');
  let current = 'daily';
  let cleanup = TABS[0].mount(panel, ctx);

  function select(key, focus = false) {
    if (key === current) return;
    current = key;
    el.querySelectorAll('[role=tab]').forEach((b) => {
      const sel = b.dataset.tab === key;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus();
    });
    panel.setAttribute('aria-labelledby', `tab-${key}`);
    cleanup?.();
    panel.innerHTML = '';
    cleanup = TABS.find((t) => t.key === key).mount(panel, ctx);
  }

  const tablist = el.querySelector('[role=tablist]');
  tablist?.addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) select(b.dataset.tab); });
  tablist?.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.key === current);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    select(TABS[(next + TABS.length) % TABS.length].key, true);
  });

  return () => cleanup?.();
}

/* ======================= shared pieces ======================= */

const stat = (label, value) => `
  <article class="stat stat--plain">
    <p class="stat__label">${label}</p>
    <p class="stat__value num">${value}</p>
  </article>`;

const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
const refNo = (id) => String(id).slice(-6).toUpperCase();
const longDate = (key) => rep.keyLabel(key, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function paymentLabel(tx) {
  const p = rep.paymentsOf(tx);
  const ref = tx.gcashRef ? ` (Ref ${esc(tx.gcashRef)})` : '';
  if (p.cash > 0 && p.gcash > 0) return `Cash ${peso(p.cash)} + GCash ${peso(p.gcash)}${ref}`;
  return `${METHOD_LABEL[tx.method] || esc(tx.method)}${ref}`;
}

/** Listen to sales and expenses in [start, end); calls back once both have loaded, and on every change. */
function listenRange(start, end, cb) {
  const range = { where: [['createdAt', '>=', start], ['createdAt', '<', end]] };
  const onError = (err) => toast(err.message, 'error');
  let txs = null;
  let expenses = null;
  const emit = () => { if (txs && expenses) cb(txs, expenses); };
  const offs = [
    db.listen('transactions', (rows) => { txs = rows.sort((a, b) => b.createdAt - a.createdAt); emit(); }, range, onError),
    db.listen('expenses', (rows) => { expenses = rows.sort((a, b) => b.createdAt - a.createdAt); emit(); }, range, onError),
  ];
  return () => offs.forEach((off) => off());
}

function downloadCsv(filename, rows) {
  const blob = new Blob(['﻿', rep.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const actionButtons = (thermal = false) => `
  <div class="report-controls__actions">
    <button type="button" class="btn btn--neutral" data-action="csv">${icon('download')}Export CSV</button>
    ${thermal ? `
    <button type="button" class="btn btn--neutral" data-action="thermal-preview">${icon('eye')}Preview (thermal)</button>
    <button type="button" class="btn btn--neutral" data-action="thermal">${icon('receipt')}Print (thermal)</button>` : ''}
    <button type="button" class="btn btn--neutral" data-action="print">${icon('print')}Print / PDF</button>
  </div>`;

/** Title block. The logo and hall name only show on paper. */
const reportHead = (title, meta) => `
  <header class="report-head">
    <img class="report-head__logo print-only" src="assets/logo-golden-break.png" alt="" width="1200" height="528">
    <p class="report-head__hall print-only">${HALL}</p>
    <h2 class="report-head__title">${title}</h2>
    <p class="report-head__meta">${meta.map((m) => `<span>${m}</span>`).join('')}</p>
  </header>`;

/** Cash / GCash / net line under a report (Marimar's payment breakdown strip). */
const payStrip = (t) => `
  <dl class="pay-strip">
    <div><dt>Cash collected</dt><dd class="num">${peso(t.cash)}</dd></div>
    <div><dt>Expenses</dt><dd class="num">${peso(t.expenses)}</dd></div>
    <div><dt>Net cash</dt><dd class="num">${peso(t.cashToCount)}</dd></div>
    <div><dt>GCash collected</dt><dd class="num">${peso(t.gcash)}</dd></div>
    <div><dt>Total collected</dt><dd class="num">${peso(t.total)}</dd></div>
    <div><dt>Net after expenses</dt><dd class="num">${peso(t.net)}</dd></div>
  </dl>`;

function expenseTable(expenses, { owner, withDate = false, withShift = false }) {
  const total = rep.expenseTotal(expenses);
  return `
    <div class="table-wrap">
      <table class="sheet">
        <thead><tr>
          ${withDate ? '<th scope="col">Date</th>' : ''}
          <th scope="col">Time</th>
          ${withShift ? '<th scope="col">Shift</th>' : ''}
          <th scope="col">What for</th>
          <th scope="col">Staff</th>
          <th scope="col" class="t-right">Amount</th>
          ${owner ? '<th scope="col" class="no-print"><span class="sr-only">Remove</span></th>' : ''}
        </tr></thead>
        <tbody>
          ${expenses.map((e) => `
          <tr>
            ${withDate ? `<td class="cell-nowrap">${rep.keyLabel(rep.dayKey(e.createdAt))}</td>` : ''}
            <td class="cell-nowrap">${fmtTime(e.createdAt)}</td>
            ${withShift ? `<td>${rep.SHIFT_SHORT[rep.shiftOf(e.createdAt)]}</td>` : ''}
            <td>${esc(e.description)}</td>
            <td class="cell-nowrap">${esc(e.cashierName)}</td>
            <td class="t-right num">${peso(e.amount)}</td>
            ${owner ? `<td class="no-print"><button type="button" class="link-btn link-btn--danger" data-remove-expense="${esc(e.id)}" aria-label="Remove expense: ${esc(e.description)}">Remove</button></td>` : ''}
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <th scope="row" colspan="${2 + (withDate ? 1 : 0) + (withShift ? 1 : 0) + 1}">Total expenses</th>
          <td class="t-right num">${peso(total)}</td>
          ${owner ? '<td class="no-print"></td>' : ''}
        </tr></tfoot>
      </table>
    </div>`;
}

function confirmRemoveExpense(expense) {
  openDialog({
    title: 'Remove expense?',
    body: `<p><strong>${esc(expense.description)}</strong>, ${peso(expense.amount)}, logged by ${esc(expense.cashierName)} on ${fmtDateTime(expense.createdAt)}.</p>
      <p class="muted small">Remove it only if it was entered by mistake. It will no longer be taken off that day's cash.</p>`,
    submitLabel: 'Remove expense',
    submitClass: 'btn--danger',
    onSubmit: async () => {
      await svc.removeExpense(expense.id);
      toast('Expense removed.');
    },
  });
}

/** Shared click handling for a tab: CSV, print, receipts, expense removal. */
function wireCommon(panel, { csv, txs, expenses }) {
  const handler = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'csv') csv();
    if (action === 'print') window.print();
    const txBtn = e.target.closest('[data-tx-id]');
    const tx = txBtn && txs()?.find((x) => x.id === txBtn.dataset.txId);
    if (tx) receiptDialog(tx);
    const rm = e.target.closest('[data-remove-expense]');
    const expense = rm && expenses()?.find((x) => x.id === rm.dataset.removeExpense);
    if (expense) confirmRemoveExpense(expense);
  };
  panel.addEventListener('click', handler);
  return () => panel.removeEventListener('click', handler);
}

/* ======================= Daily ======================= */

const newLine = () => ({ id: Math.random().toString(36).slice(2), description: '', amount: '' });

function dailyTab(panel, ctx) {
  const owner = isOwnerLevel(ctx.user);
  const today = rep.dayKey(Date.now());
  const twoShifts = () => !!state.settings.twoShifts;
  let key = today;
  let shift = twoShifts() ? rep.shiftOf(Date.now()) : 'full';
  let picked = false;
  let txs = null;
  let expenses = null;
  let unlisten = () => {};
  let lines = [newLine(), newLine(), newLine()];

  panel.innerHTML = `
    <div class="report-controls no-print">
      <div class="report-controls__fields">
        <div class="field report-controls__date">
          <label for="daily-date">Business day</label>
          <input id="daily-date" type="date" value="${key}" max="${today}">
        </div>
        <div data-region="shift-picker"></div>
        ${owner ? `
        <label class="check report-controls__toggle">
          <input type="checkbox" data-action="two-shifts" ${twoShifts() ? 'checked' : ''}>
          Day and Night shifts
        </label>` : ''}
      </div>
      ${actionButtons(true)}
    </div>
    <section class="card no-print" data-region="expense-form" aria-labelledby="exp-form-title"></section>
    <div class="report-body" data-region="body"></div>`;

  const $ = (sel) => panel.querySelector(sel);
  const dateInput = $('#daily-date');

  const timeText = () => {
    const [start, end] = rep.shiftRange(key, shift);
    return `${fmtTime(start)} – ${fmtTime(end)}`;
  };
  const shiftName = () => (shift === 'full' ? (twoShifts() ? 'Full day' : '') : rep.SHIFT_LABEL[shift]);

  function isCurrent() {
    const [start, end] = rep.shiftRange(key, shift);
    const now = Date.now();
    return now >= start && now < end;
  }

  function subscribe() {
    unlisten();
    txs = null;
    expenses = null;
    renderBody();
    const [start, end] = rep.shiftRange(key, shift);
    unlisten = listenRange(start, end, (t, e) => { txs = t; expenses = e; renderBody(); });
  }

  function renderPicker() {
    $('[data-region=shift-picker]').innerHTML = twoShifts() ? `
      <div class="field report-controls__shift">
        <label for="daily-shift">Shift</label>
        <select id="daily-shift">
          ${rep.SHIFTS.map((s) => `<option value="${s}" ${s === shift ? 'selected' : ''}>${rep.SHIFT_LABEL[s]}</option>`).join('')}
        </select>
      </div>` : '';
  }

  /* ---------- expense form ---------- */

  function renderExpenseForm() {
    const target = $('[data-region=expense-form]');
    if (!isCurrent()) { target.hidden = true; target.innerHTML = ''; return; }
    target.hidden = false;
    target.innerHTML = `
      <div>
        <h2 class="card-title" id="exp-form-title">Log expense</h2>
        <p class="card-sub">Cash taken from the drawer. Add several items, then save. They are deducted from this shift's cash and net sales.</p>
      </div>
      <div class="expense-lines">
        ${lines.map((l, i) => `
          <div class="expense-line" data-line="${l.id}">
            <div class="field">
              <label for="exp-desc-${l.id}" class="${i ? 'sr-only' : ''}">What for</label>
              <input id="exp-desc-${l.id}" data-field="description" type="text" maxlength="${svc.EXPENSE_DESCRIPTION_MAX}"
                placeholder="${i ? 'What for' : 'e.g. water, ice, fare'}" value="${esc(l.description)}" autocomplete="off">
            </div>
            <div class="field">
              <label for="exp-amt-${l.id}" class="${i ? 'sr-only' : ''}">Amount (₱)</label>
              <input id="exp-amt-${l.id}" data-field="amount" type="number" inputmode="decimal" min="0.01" step="0.01"
                placeholder="₱" value="${esc(l.amount)}">
            </div>
            <button type="button" class="icon-btn" data-remove-line="${l.id}" aria-label="Remove line ${i + 1}">${icon('x')}</button>
          </div>`).join('')}
      </div>
      <div class="expense-foot">
        <button type="button" class="btn btn--neutral btn--sm" data-action="add-line">${icon('plus')}Add another item</button>
        <span class="expense-foot__total">Total <strong class="num" data-region="exp-total"></strong></span>
        <button type="button" class="btn btn--primary" data-action="save-expenses"></button>
      </div>`;
    refreshExpenseTotals();
  }

  function refreshExpenseTotals() {
    const complete = lines.filter((l) => l.description.trim() && Number(l.amount) > 0);
    const totalEl = $('[data-region=exp-total]');
    if (totalEl) totalEl.textContent = peso(complete.reduce((s, l) => s + Number(l.amount), 0));
    const save = $('[data-action=save-expenses]');
    if (save) save.textContent = complete.length > 1 ? `Save ${complete.length} expenses` : 'Add expense';
  }

  async function saveExpenses(button) {
    const started = lines.filter((l) => l.description.trim() || l.amount !== '');
    if (!started.length) { toast('Add at least one expense.', 'error'); return; }
    if (started.some((l) => !l.description.trim() || !(Number(l.amount) > 0))) {
      toast('Fill in both what it was for and the amount on each line you started.', 'error');
      return;
    }
    const count = await busy(button, () => svc.recordExpenses(started, ctx.user));
    if (!count) return;
    toast(count === 1 ? 'Expense recorded. It shows on this shift’s report.' : `${count} expenses recorded. They show on this shift’s report.`);
    lines = [newLine(), newLine(), newLine()];
    renderExpenseForm();
  }

  /* ---------- the report ---------- */

  function salesSheet() {
    const t = rep.totals(txs);
    const cols = 12;
    return `
      <div class="table-wrap">
        <table class="sheet">
          <thead><tr>
            <th scope="col">Table</th>
            <th scope="col">Ref #</th>
            <th scope="col">Start</th>
            <th scope="col">End</th>
            <th scope="col">Booked</th>
            <th scope="col">Played</th>
            <th scope="col" class="t-right">Table fee</th>
            <th scope="col" class="t-right">Products</th>
            <th scope="col" class="t-right">Paid</th>
            <th scope="col">Payment</th>
            <th scope="col">Staff</th>
            <th scope="col">Remarks</th>
            <th scope="col" class="no-print"><span class="sr-only">Receipt</span></th>
          </tr></thead>
          <tbody>
            ${txs.length ? txs.map((x) => `
            <tr>
              <th scope="row" class="cell-nowrap">${x.tableId ? esc(x.tableName) : 'Walk-in'}</th>
              <td class="cell-nowrap">${refNo(x.id)}</td>
              <td class="cell-nowrap">${fmtTime(x.tableId ? x.startedAt : x.createdAt)}</td>
              <td class="cell-nowrap">${x.tableId ? fmtTime(x.endedAt) : ''}</td>
              <td class="cell-nowrap">${x.tableId ? (x.plannedMs ? fmtBooking(x.plannedMs) : 'Open') : ''}</td>
              <td class="cell-nowrap">${x.tableId ? fmtHuman(x.durationMs || 0) : ''}</td>
              <td class="t-right num">${x.tableId ? peso(x.tableFee) : ''}</td>
              <td class="t-right num">${x.productTotal ? peso(x.productTotal) : ''}</td>
              <td class="t-right num">${peso(x.total)}</td>
              <td class="cell-nowrap">${paymentLabel(x)}</td>
              <td class="cell-nowrap">${esc(x.cashierName)}</td>
              <td>${esc(rep.cancelInfo(x)?.remark ?? '')}</td>
              <td class="no-print"><button type="button" class="link-btn" data-tx-id="${esc(x.id)}" aria-label="View receipt ${refNo(x.id)}">Receipt</button></td>
            </tr>`).join('') : `<tr><td colspan="${cols + 1}" class="sheet__empty">No sales ${shift === 'full' ? 'this business day' : 'this shift'} yet.</td></tr>`}
          </tbody>
          ${txs.length ? `
          <tfoot><tr>
            <th scope="row" colspan="6">Totals</th>
            <td class="t-right num">${peso(t.tableFee)}</td>
            <td class="t-right num">${peso(t.productTotal)}</td>
            <td class="t-right num">${peso(t.total)}</td>
            <td colspan="3"></td>
            <td class="no-print"></td>
          </tr></tfoot>` : ''}
        </table>
      </div>`;
  }

  function renderBody() {
    const body = $('[data-region=body]');
    if (!txs || !expenses) { body.innerHTML = loadingBlock('Loading report…'); return; }
    const t = rep.totals(txs, expenses);
    const sessions = txs.filter((x) => x.tableId).length;
    const inUse = state.tables.filter((x) => x.status !== 'available').length;
    const products = rep.topProducts(txs);
    const meta = [`Date: ${longDate(key)}`, `Time: ${timeText()}`, ...(shiftName() ? [shiftName()] : [])];

    body.innerHTML = `
      <div class="report-sheet">
        ${reportHead('Daily Sales Report', meta)}
        ${salesSheet()}
        ${expenses.length ? `<h3 class="sheet-caption">Expenses</h3>${expenseTable(expenses, { owner, withShift: twoShifts() })}` : ''}
        ${payStrip(t)}
        <div class="overall">
          <div>
            <p class="overall__label">Overall Sale</p>
            ${t.expenses ? `<p class="overall__sub">Expenses ${peso(t.expenses)} deducted</p>` : ''}
          </div>
          <div class="overall__amount">
            ${t.expenses ? `<s class="num">${peso(t.total)}</s>` : ''}
            <strong class="num">${peso(t.net)}</strong>
          </div>
        </div>
        <div class="signatures">
          ${['Prepared by', 'Checked by', 'Noted by'].map((l) => `<div><span></span><p>${l}</p></div>`).join('')}
        </div>
      </div>

      <section class="card end-shift no-print" aria-labelledby="end-shift-title">
        <div>
          <h2 class="card-title" id="end-shift-title">End of shift</h2>
          <p class="card-sub">Open the cash drawer, count the cash against this report, then print or export it.</p>
        </div>
        <dl class="end-shift__figures">
          <div><dt>Cash collected</dt><dd class="num">${peso(t.cash)}</dd></div>
          <div><dt>Expenses</dt><dd class="num">− ${peso(t.expenses)}</dd></div>
          <div class="end-shift__total"><dt>Cash to count</dt><dd class="num">${peso(t.cashToCount)}</dd></div>
        </dl>
        <button type="button" class="btn btn--neutral" data-action="open-drawer">${icon('box')}Open drawer</button>
      </section>

      <div class="stats stats--6 no-print">
        ${stat('Table sessions', sessions)}
        ${stat('Table revenue', peso(t.tableFee))}
        ${stat('Product sales', peso(t.productTotal))}
        ${stat('Expenses', peso(t.expenses))}
        ${stat('Net sales', peso(t.net))}
        ${stat('Tables in use now', `${inUse}/${state.tables.length}`)}
      </div>

      <section class="card no-print" aria-labelledby="daily-items-title">
        <h2 class="card-title" id="daily-items-title">Most ordered items</h2>
        ${products.length ? `
        <table class="plain-table">
          <thead><tr><th scope="col">Item</th><th scope="col" class="t-right">Qty</th><th scope="col" class="t-right">Revenue</th></tr></thead>
          <tbody>${products.map((p) => `<tr><td>${esc(p.name)}</td><td class="t-right num">${p.qty}</td><td class="t-right num">${peso(p.revenue)}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="muted small">No items sold yet.</p>'}
      </section>`;
  }

  function csv() {
    if (!txs || !expenses) return;
    const t = rep.totals(txs, expenses);
    const withShift = twoShifts();
    downloadCsv(`golden-break-daily-${key}${shift === 'full' ? '' : `-${shift}`}.csv`, [
      [HALL], ['Daily Sales Report'], [`Date: ${longDate(key)}`, `Time: ${timeText()}`, shiftName()], [],
      ['Table', 'Ref #', 'Start', 'End', 'Booked', 'Played (min)', 'Table fee', 'Products', 'Paid', 'Payment', 'Cash', 'GCash', 'GCash ref (last 5)', 'Staff', 'Remarks'],
      ...txs.map((x) => {
        const p = rep.paymentsOf(x);
        return [
          x.tableId ? x.tableName : 'Walk-in', refNo(x.id), fmtTime(x.tableId ? x.startedAt : x.createdAt),
          x.tableId ? fmtTime(x.endedAt) : '', x.tableId ? (x.plannedMs ? fmtBooking(x.plannedMs) : 'Open') : '',
          x.tableId ? Math.round((x.durationMs || 0) / 60000) : '', x.tableId ? x.tableFee : '', x.productTotal, x.total,
          METHOD_LABEL[x.method] || x.method, p.cash, p.gcash, x.gcashRef || '', x.cashierName,
          rep.cancelInfo(x)?.remark ?? '',
        ];
      }),
      ['Totals', '', '', '', '', '', t.tableFee, t.productTotal, t.total, '', t.cash, t.gcash, '', '', ''],
      [], ['Expenses'], ['Time', ...(withShift ? ['Shift'] : []), 'What for', 'Staff', 'Amount'],
      ...expenses.map((e) => [fmtTime(e.createdAt), ...(withShift ? [rep.SHIFT_SHORT[rep.shiftOf(e.createdAt)]] : []), e.description, e.cashierName, e.amount]),
      ['Total expenses', ...(withShift ? [''] : []), '', '', t.expenses],
      [], ['Summary'],
      ['Cash collected', t.cash], ['Expenses', t.expenses], ['Net cash (cash to count)', t.cashToCount],
      ['GCash collected', t.gcash], ['Total collected', t.total], ['Net after expenses', t.net],
      ['Overall Sale', t.net],
    ]);
  }

  /* ---------- events ---------- */

  function setShift(nextKey, nextShift) {
    if (!nextKey) { dateInput.value = key; return; }
    [key, shift] = [nextKey > today ? today : nextKey, nextShift];
    dateInput.value = key;
    renderPicker();
    renderExpenseForm();
    subscribe();
  }

  dateInput.addEventListener('change', () => { picked = true; setShift(dateInput.value, shift); });

  const onChange = (e) => {
    if (e.target.id === 'daily-shift') { picked = true; setShift(key, e.target.value); }
    if (e.target.dataset.action === 'two-shifts') {
      const box = e.target;
      busy(box, () => svc.setTwoShifts(box.checked)).then((ok) => {
        if (ok === undefined) box.checked = twoShifts();
        else toast(box.checked ? 'Day and Night shifts are on.' : 'Back to one shift per business day.');
      });
    }
  };
  const onInput = (e) => {
    const input = e.target.closest('[data-field]');
    const line = input && lines.find((l) => l.id === input.closest('[data-line]')?.dataset.line);
    if (!line) return;
    line[input.dataset.field] = input.value;
    refreshExpenseTotals();
  };
  /** The Daily Sales Report in the compact thermal layout (Marimar Inn's shift-end slip). */
  const thermalData = () => ({
    dateLabel: rep.keyLabel(key, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), // fits 58mm paper
    timeLabel: timeText(),
    shiftLabel: shiftName(),
    txs,
    expenses,
    totals: rep.totals(txs, expenses),
  });

  async function printThermal(button) {
    if (!txs || !expenses) return;
    if (!printer.getPrinterState().kind) { printerDialog(); return; }
    await busy(button, async () => { await printer.printDailySales(thermalData()); toast('Daily sales report sent to the printer.'); });
  }

  const onClick = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'thermal') printThermal(e.target.closest('button'));
    if (action === 'open-drawer') {
      if (!printer.getPrinterState().kind) cashDrawerDialog(); // explains that the printer must be connected
      else openDrawerDialog();
    }
    if (action === 'thermal-preview' && txs && expenses) {
      thermalPreviewDialog({ title: 'Daily sales report preview', lines: printer.previewDailySales(thermalData()), onPrint: () => printer.printDailySales(thermalData()) });
    }
    if (action === 'add-line') {
      lines.push(newLine());
      renderExpenseForm();
      panel.querySelector(`#exp-desc-${lines.at(-1).id}`)?.focus();
    }
    if (action === 'save-expenses') saveExpenses(e.target.closest('button'));
    const removeLine = e.target.closest('[data-remove-line]');
    if (removeLine) {
      lines = lines.length === 1 ? [newLine()] : lines.filter((l) => l.id !== removeLine.dataset.removeLine);
      renderExpenseForm();
    }
  };
  panel.addEventListener('change', onChange);
  panel.addEventListener('input', onInput);
  panel.addEventListener('click', onClick);
  const offCommon = wireCommon(panel, { csv, txs: () => txs, expenses: () => expenses });

  /** One shift → always the full business day. Two shifts → default to the shift on duty now. */
  const offSettings = on('settings', () => {
    const box = $('[data-action=two-shifts]');
    if (box) box.checked = twoShifts();
    const next = !twoShifts() ? 'full' : picked ? shift : (key === today ? rep.shiftOf(Date.now()) : 'full');
    if (next !== shift) setShift(key, next);
    else { renderPicker(); renderBody(); }
  });
  const offTables = on('tables', () => txs && renderBody());
  const clock = setInterval(() => {
    if ($('[data-region=expense-form]').hidden === isCurrent()) renderExpenseForm();
  }, 30000);

  renderPicker();
  renderExpenseForm();
  subscribe();
  return () => {
    unlisten(); offSettings(); offTables(); offCommon(); clearInterval(clock);
    panel.removeEventListener('change', onChange);
    panel.removeEventListener('input', onInput);
    panel.removeEventListener('click', onClick);
  };
}

/* ======================= Custom range ======================= */

function chartCard(title, sub, days, today) {
  const many = days.length > 14;
  const chartDays = days.map((d, i) => ({
    label: !many || i % Math.ceil(days.length / 10) === 0 ? rep.keyLabel(d.key, many ? { month: 'short', day: 'numeric' } : { weekday: 'short' }) : '',
    full: rep.keyLabel(d.key, { weekday: 'long', month: 'short', day: 'numeric' }),
    table: d.tableFee,
    product: d.productTotal,
    today: d.key === today,
  }));
  return `
    <section class="card no-print" aria-label="${title}">
      <div class="card-head">
        <div><h2 class="card-title">${title}</h2><p class="card-sub">${sub}</p></div>
        <ul class="legend" aria-label="Legend">
          <li><span class="swatch swatch--felt" aria-hidden="true"></span>Table revenue</li>
          <li><span class="swatch swatch--amber" aria-hidden="true"></span>Product sales</li>
        </ul>
      </div>
      <div class="chart">${barChart(chartDays)}</div>
    </section>`;
}

function rangeTab(panel, ctx) {
  const today = rep.dayKey(Date.now());
  let fromKey = `${today.slice(0, 8)}01`;
  let toKey = today;
  let txs = null;
  let expenses = null;
  let unlisten = () => {};

  panel.innerHTML = `
    <div class="report-controls no-print">
      <div class="report-controls__fields">
        <div class="field report-controls__date"><label for="range-from">From</label><input id="range-from" type="date" value="${fromKey}" max="${today}"></div>
        <div class="field report-controls__date"><label for="range-to">To</label><input id="range-to" type="date" value="${toKey}" max="${today}"></div>
      </div>
      ${actionButtons()}
    </div>
    <div class="report-body" data-region="body"></div>`;

  const $ = (sel) => panel.querySelector(sel);
  const fromInput = $('#range-from');
  const toInput = $('#range-to');
  const rangeLabel = () => (fromKey === toKey ? longDate(fromKey) : `${longDate(fromKey)} – ${longDate(toKey)}`);

  function subscribe() {
    unlisten();
    txs = null;
    expenses = null;
    render();
    unlisten = listenRange(rep.keyToStart(fromKey), rep.keyToStart(rep.shiftKey(toKey, 1)), (t, e) => { txs = t; expenses = e; render(); });
  }

  function render() {
    const body = $('[data-region=body]');
    if (!txs || !expenses) { body.innerHTML = loadingBlock('Loading report…'); return; }
    const t = rep.totals(txs, expenses);
    const days = rep.byDay(txs, fromKey, toKey, expenses);
    const sessions = txs.filter((x) => x.tableId).length;
    const cancels = rep.cancelledGames(txs);
    body.innerHTML = `
      ${reportHead('Sales Report', [rangeLabel()])}
      <div class="stats stats--6">
        ${stat('Table sessions', sessions)}
        ${stat('Table revenue', peso(t.tableFee))}
        ${stat('Product sales', peso(t.productTotal))}
        ${stat('Total sales', peso(t.total))}
        ${stat('Expenses', peso(t.expenses))}
        ${stat('Net sales', peso(t.net))}
      </div>
      ${payStrip(t)}
      ${days.length > 1 ? chartCard('Sales by day', rangeLabel(), days, today) : ''}
      <section class="card" aria-labelledby="range-days-title">
        <div><h2 class="card-title" id="range-days-title">By day</h2><p class="card-sub">Sales, expenses and net for each business day in the range.</p></div>
        <div class="table-wrap">
          <table class="plain-table">
            <thead><tr>
              <th scope="col">Date</th>
              <th scope="col" class="t-right">Sessions</th>
              <th scope="col" class="t-right">Tables</th>
              <th scope="col" class="t-right">Products</th>
              <th scope="col" class="t-right">Sales</th>
              <th scope="col" class="t-right">Expenses</th>
              <th scope="col" class="t-right">Net</th>
            </tr></thead>
            <tbody>
              ${days.map((d) => `
              <tr class="${d.count || d.expenseCount ? '' : 'row-muted'}">
                <td class="cell-nowrap">${rep.keyLabel(d.key)}</td>
                <td class="t-right num">${txs.filter((x) => x.tableId && rep.dayKey(x.createdAt) === d.key).length}</td>
                <td class="t-right num">${peso(d.tableFee)}</td>
                <td class="t-right num">${peso(d.productTotal)}</td>
                <td class="t-right num">${peso(d.total)}</td>
                <td class="t-right num">${peso(d.expenses)}</td>
                <td class="t-right num"><strong>${peso(d.net)}</strong></td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <td>Total</td>
              <td class="t-right num">${sessions}</td>
              <td class="t-right num">${peso(t.tableFee)}</td>
              <td class="t-right num">${peso(t.productTotal)}</td>
              <td class="t-right num">${peso(t.total)}</td>
              <td class="t-right num">${peso(t.expenses)}</td>
              <td class="t-right num">${peso(t.net)}</td>
            </tr></tfoot>
          </table>
        </div>
      </section>
      <section class="card" aria-labelledby="range-exp-title">
        <div><h2 class="card-title" id="range-exp-title">Expenses</h2>
          <p class="card-sub">${expenses.length ? `${expenses.length} ${expenses.length === 1 ? 'entry' : 'entries'} · ${peso(t.expenses)}` : 'No expenses in this range.'}</p></div>
        ${expenses.length ? expenseTable(expenses, { owner: true, withDate: true }) : ''}
      </section>
      ${cancels.length ? `
      <section class="card" aria-labelledby="range-cancels-title">
        <div><h2 class="card-title" id="range-cancels-title">Cancelled games</h2>
          <p class="card-sub">${cancels.length} game${cancels.length === 1 ? '' : 's'} cancelled in the first 5 minutes, with no table fee</p></div>
        <div class="table-wrap">
          <table class="plain-table">
            <thead><tr><th scope="col">When</th><th scope="col">Table</th><th scope="col">By</th><th scope="col">Reason</th><th scope="col" class="no-print"><span class="sr-only">Receipt</span></th></tr></thead>
            <tbody>${cancels.map((x) => {
              const c = rep.cancelInfo(x);
              return `
              <tr>
                <td class="cell-nowrap">${fmtDateTime(c.at)}</td>
                <td>${esc(x.tableName)}</td>
                <td>${esc(c.by)}</td>
                <td>${esc(c.reason)}${c.note ? ` · ${esc(c.note)}` : ''}</td>
                <td class="no-print"><button type="button" class="link-btn" data-tx-id="${esc(x.id)}">Receipt</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </section>` : ''}`;
  }

  function csv() {
    if (!txs || !expenses) return;
    const t = rep.totals(txs, expenses);
    downloadCsv(`golden-break-range-${fromKey}_to_${toKey}.csv`, [
      [HALL], ['Sales Report'], [rangeLabel()], [],
      ['Date', 'Table revenue', 'Product sales', 'Sales', 'Cash', 'GCash', 'Expenses', 'Net'],
      ...rep.byDay(txs, fromKey, toKey, expenses).map((d) => [d.key, d.tableFee, d.productTotal, d.total, d.cash, d.gcash, d.expenses, d.net]),
      ['Total', t.tableFee, t.productTotal, t.total, t.cash, t.gcash, t.expenses, t.net],
      [], ['Expenses'], ['Date', 'Time', 'What for', 'Staff', 'Amount'],
      ...expenses.map((e) => [rep.dayKey(e.createdAt), fmtTime(e.createdAt), e.description, e.cashierName, e.amount]),
      ['Total expenses', '', '', '', t.expenses],
    ]);
  }

  function setRange(from, to) {
    if (!from || !to) return;
    if (from > to) [from, to] = [to, from];
    if (rep.dayKeys(from, to).length > MAX_RANGE_DAYS) {
      toast(`Choose a range of ${MAX_RANGE_DAYS} days or less.`, 'error');
      fromInput.value = fromKey;
      toInput.value = toKey;
      return;
    }
    [fromKey, toKey] = [from, to];
    fromInput.value = fromKey;
    toInput.value = toKey;
    subscribe();
  }
  fromInput.addEventListener('change', () => setRange(fromInput.value, toInput.value || fromInput.value));
  toInput.addEventListener('change', () => setRange(fromInput.value || toInput.value, toInput.value));
  const offCommon = wireCommon(panel, { csv, txs: () => txs, expenses: () => expenses });

  subscribe();
  return () => { unlisten(); offCommon(); };
}

/* ======================= Monthly ======================= */

function monthlyTab(panel) {
  const today = rep.dayKey(Date.now());
  let month = today.slice(0, 7); // 'YYYY-MM'
  let txs = null;
  let expenses = null;
  let unlisten = () => {};

  panel.innerHTML = `
    <div class="report-controls no-print">
      <div class="report-controls__fields">
        <div class="field report-controls__date"><label for="month-pick">Month</label><input id="month-pick" type="month" value="${month}" max="${today.slice(0, 7)}"></div>
      </div>
      ${actionButtons()}
    </div>
    <div class="report-body" data-region="body"></div>`;

  const $ = (sel) => panel.querySelector(sel);
  const monthInput = $('#month-pick');

  const bounds = () => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
  };
  const monthLabel = () => new Date(`${month}-01T12:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });

  function subscribe() {
    unlisten();
    txs = null;
    expenses = null;
    render();
    const [first, last] = bounds();
    unlisten = listenRange(rep.keyToStart(first), rep.keyToStart(rep.shiftKey(last, 1)), (t, e) => { txs = t; expenses = e; render(); });
  }

  function byTable() {
    const map = new Map();
    for (const x of txs) {
      if (!x.tableId) continue;
      const row = map.get(x.tableId) || { name: x.tableName, sessions: 0, durationMs: 0, revenue: 0 };
      row.sessions += 1;
      row.durationMs += x.durationMs || 0;
      row.revenue += x.tableFee || 0;
      map.set(x.tableId, row);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
  }

  function render() {
    const body = $('[data-region=body]');
    if (!txs || !expenses) { body.innerHTML = loadingBlock('Loading report…'); return; }
    const t = rep.totals(txs, expenses);
    const [first, last] = bounds();
    const days = rep.byDay(txs, first, last, expenses);
    const tables = byTable();
    const products = rep.topProducts(txs);
    const hoursPlayed = `${(t.durationMs / 3600000).toFixed(1)} h`;
    body.innerHTML = `
      ${reportHead('Monthly Report', [monthLabel()])}
      <div class="stats stats--6">
        ${stat('Total sales', peso(t.total))}
        ${stat('Table revenue', peso(t.tableFee))}
        ${stat('Product sales', peso(t.productTotal))}
        ${stat('Expenses', peso(t.expenses))}
        ${stat('Net sales', peso(t.net))}
        ${stat('Hours played', hoursPlayed)}
      </div>
      ${chartCard('Sales trend', `${txs.filter((x) => x.tableId).length} table sessions this month`, days, today)}
      <section class="card" aria-labelledby="month-tables-title">
        <h2 class="card-title" id="month-tables-title">Revenue by table</h2>
        ${tables.length ? `
        <table class="plain-table">
          <thead><tr><th scope="col">Table</th><th scope="col" class="t-right">Sessions</th><th scope="col" class="t-right">Hours played</th><th scope="col" class="t-right">Revenue</th></tr></thead>
          <tbody>${tables.map((r) => `<tr><td>${esc(r.name)}</td><td class="t-right num">${r.sessions}</td><td class="t-right num">${(r.durationMs / 3600000).toFixed(1)}</td><td class="t-right num">${peso(r.revenue)}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="muted small">No table sessions this month.</p>'}
      </section>
      <section class="card" aria-labelledby="month-items-title">
        <h2 class="card-title" id="month-items-title">Top products</h2>
        ${products.length ? `
        <table class="plain-table">
          <thead><tr><th scope="col">Item</th><th scope="col" class="t-right">Qty</th><th scope="col" class="t-right">Revenue</th></tr></thead>
          <tbody>${products.map((p) => `<tr><td>${esc(p.name)}</td><td class="t-right num">${p.qty}</td><td class="t-right num">${peso(p.revenue)}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="muted small">No products sold this month.</p>'}
      </section>`;
  }

  function csv() {
    if (!txs || !expenses) return;
    const t = rep.totals(txs, expenses);
    const [first, last] = bounds();
    downloadCsv(`golden-break-monthly-${month}.csv`, [
      [HALL], ['Monthly Report'], [monthLabel()], [],
      ['Total sales', t.total], ['Table revenue', t.tableFee], ['Product sales', t.productTotal],
      ['Expenses', t.expenses], ['Net sales', t.net], ['Hours played', (t.durationMs / 3600000).toFixed(1)],
      [], ['Date', 'Table revenue', 'Product sales', 'Sales', 'Expenses', 'Net'],
      ...rep.byDay(txs, first, last, expenses).map((d) => [d.key, d.tableFee, d.productTotal, d.total, d.expenses, d.net]),
      [], ['Table', 'Sessions', 'Hours played', 'Revenue'],
      ...byTable().map((r) => [r.name, r.sessions, (r.durationMs / 3600000).toFixed(1), r.revenue]),
      [], ['Product', 'Qty', 'Revenue'],
      ...rep.topProducts(txs, 1000).map((p) => [p.name, p.qty, p.revenue]),
    ]);
  }

  monthInput.addEventListener('change', () => {
    if (!monthInput.value) { monthInput.value = month; return; }
    month = monthInput.value > today.slice(0, 7) ? today.slice(0, 7) : monthInput.value;
    monthInput.value = month;
    subscribe();
  });
  const offCommon = wireCommon(panel, { csv, txs: () => txs, expenses: () => expenses });

  subscribe();
  return () => { unlisten(); offCommon(); };
}
