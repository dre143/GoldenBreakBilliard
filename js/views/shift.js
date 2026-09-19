// Shift Report: the end-of-shift sheet for one business day or one cashier shift (Day / Night).
// Lists every sale and every expense in the shift, then reconciles the drawer:
//   cash to count = cash collected − expenses   ·   net sales = sales − expenses
// Any staff member can log expenses here (cash taken from the drawer); only the owner can remove one.
// The hall runs one shift per business day unless the owner turns on Day/Night shifts (settings/shifts).
import { db } from '../db.js';
import { state, on } from '../state.js';
import * as rep from '../reporting.js';
import * as svc from '../services.js';
import { receiptDialog } from '../dialogs.js';
import {
  esc, icon, peso, fmtTime, fmtHuman, METHOD_LABEL, pageHeader, loadingBlock, emptyBlock, toast, busy, openDialog,
} from '../ui.js';

const newLine = () => ({ id: Math.random().toString(36).slice(2), description: '', amount: '' });

export function mount(el, ctx) {
  const owner = ctx.user.role === 'owner';
  const today = rep.dayKey(Date.now());
  const twoShifts = () => !!state.settings.twoShifts;
  let key = today;
  let shift = twoShifts() ? rep.shiftOf(Date.now()) : 'full';
  let txs = null;
  let expenses = null;
  let unsubs = [];
  let lines = [newLine(), newLine(), newLine()];

  el.innerHTML = `
    ${pageHeader({
      title: 'Shift Report',
      subtitle: '<span data-region="range-label"></span>',
      actions: `
        <button type="button" class="btn btn--neutral" data-action="csv">${icon('download')}Export CSV</button>
        <button type="button" class="btn btn--neutral" data-action="print">${icon('print')}Print</button>`,
    })}
    <section class="card report-range" aria-label="Shift">
      <div class="field shift-date">
        <label for="shift-date">Business day</label>
        <input id="shift-date" type="date" value="${key}" max="${today}">
      </div>
      <div data-region="shift-picker"></div>
      ${owner ? `
      <label class="check no-print shift-toggle">
        <input type="checkbox" data-action="two-shifts" ${twoShifts() ? 'checked' : ''}>
        Split the day into Day and Night shifts
      </label>` : ''}
      <p class="report-range__note" data-region="range-note"></p>
    </section>
    <section class="stats" data-region="stats" aria-label="End of shift"></section>
    <section class="card no-print" data-region="expense-form" aria-labelledby="exp-form-title"></section>
    <section class="card card--flush" aria-labelledby="shift-sales-title">
      <div class="toolbar"><h2 class="card-title" id="shift-sales-title">Sales</h2><span class="card-sub" data-region="sales-count"></span></div>
      <div class="table-wrap" data-region="sales"></div>
    </section>
    <section class="card card--flush" aria-labelledby="shift-exp-title">
      <div class="toolbar"><h2 class="card-title" id="shift-exp-title">Expenses</h2><span class="card-sub" data-region="exp-count"></span></div>
      <div class="table-wrap" data-region="expenses"></div>
    </section>
    <section class="card card--flush" aria-labelledby="shift-products-title">
      <div class="toolbar"><h2 class="card-title" id="shift-products-title">Most ordered items</h2></div>
      <div class="table-wrap" data-region="products"></div>
    </section>`;

  const $ = (sel) => el.querySelector(sel);
  const dateInput = $('#shift-date');

  /* ---------- data ---------- */

  function subscribe() {
    unsubs.forEach((off) => off());
    txs = null;
    expenses = null;
    render();
    const [start, end] = rep.shiftRange(key, shift);
    const range = { where: [['createdAt', '>=', start], ['createdAt', '<', end]] };
    const onError = (err) => toast(err.message, 'error');
    unsubs = [
      db.listen('transactions', (rows) => { txs = rows.sort((a, b) => b.createdAt - a.createdAt); render(); }, range, onError),
      db.listen('expenses', (rows) => { expenses = rows.sort((a, b) => b.createdAt - a.createdAt); render(); }, range, onError),
    ];
  }

  /** Expenses are stamped with the current time, so the form only makes sense on the shift that's on duty now. */
  function isCurrent() {
    const [start, end] = rep.shiftRange(key, shift);
    const now = Date.now();
    return now >= start && now < end;
  }

  /* ---------- rendering ---------- */

  const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  const dayHours = `${hourLabel(rep.BUSINESS_DAY_START_HOUR)} to ${hourLabel(rep.BUSINESS_DAY_START_HOUR)} the next morning`;
  const rangeLabel = () => `${rep.keyLabel(key, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${
    shift === 'full' ? `${twoShifts() ? 'Full day' : 'Business day'} (${dayHours})` : rep.SHIFT_LABEL[shift]}`;
  /** "Day"/"Night" tag under each row's time, only when the hall runs two shifts. */
  const shiftTag = (ts) => (twoShifts() ? `<span class="cell-sub">${rep.SHIFT_SHORT[rep.shiftOf(ts)]}</span>` : '');

  function renderPicker() {
    $('[data-region=shift-picker]').innerHTML = twoShifts() ? `
      <div class="seg seg--inline" role="radiogroup" aria-label="Shift">
        ${rep.SHIFTS.map((s) => `
          <label class="seg__opt">
            <input type="radio" name="shift" value="${s}" ${s === shift ? 'checked' : ''}>
            <span>${rep.SHIFT_LABEL[s]}</span>
          </label>`).join('')}
      </div>` : '';
    $('[data-region=range-note]').textContent = `${twoShifts() ? 'Sales count on the shift they were paid in.' : `One shift covers the whole business day, ${dayHours}.`} Expenses are cash taken from the drawer and are subtracted from the cash to count.`;
  }

  const stat = (label, value, sub = '', cls = '') => `
    <article class="stat ${cls}">
      <p class="stat__label">${label}</p>
      <p class="stat__value num">${value}</p>
      <p class="stat__sub">${sub}</p>
    </article>`;

  function renderStats() {
    const target = $('[data-region=stats]');
    if (!txs || !expenses) { target.innerHTML = loadingBlock('Loading shift…'); return; }
    const t = rep.totals(txs, expenses);
    target.innerHTML = `
      ${stat('Sales', peso(t.total), `${t.count} transaction${t.count === 1 ? '' : 's'} · net ${peso(t.net)} after expenses`)}
      ${stat('Cash collected', peso(t.cash), `GCash ${peso(t.gcash)}${t.other ? ` · other ${peso(t.other)}` : ''}`)}
      ${stat('Expenses', peso(t.expenses), `${t.expenseCount} item${t.expenseCount === 1 ? '' : 's'} paid from the drawer`, t.expenses ? 'stat--danger' : '')}
      ${stat('Cash to count', peso(t.cashToCount), 'Cash collected − expenses', 'stat--dark')}`;
  }

  function renderExpenseForm() {
    const target = $('[data-region=expense-form]');
    if (!isCurrent()) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }
    target.hidden = false;
    const filled = lines.filter((l) => l.description.trim() || l.amount !== '');
    const complete = filled.filter((l) => l.description.trim() && Number(l.amount) > 0);
    const total = complete.reduce((s, l) => s + Number(l.amount), 0);
    target.innerHTML = `
      <div class="card-head">
        <div>
          <h2 class="card-title" id="exp-form-title">Log expense</h2>
          <p class="card-sub">Cash taken from the drawer. Add several items, then save. They're recorded on this shift under your name.</p>
        </div>
      </div>
      <div class="expense-lines">
        ${lines.map((l, i) => `
          <div class="expense-line" data-line="${l.id}">
            <div class="field">
              <label for="exp-desc-${l.id}" class="${i ? 'sr-only' : ''}">What for</label>
              <input id="exp-desc-${l.id}" data-fk="desc-${l.id}" data-field="description" type="text" maxlength="${svc.EXPENSE_DESCRIPTION_MAX}"
                placeholder="${i ? 'What for' : 'e.g. water, ice, fare'}" value="${esc(l.description)}" autocomplete="off">
            </div>
            <div class="field expense-line__amount">
              <label for="exp-amt-${l.id}" class="${i ? 'sr-only' : ''}">Amount (₱)</label>
              <input id="exp-amt-${l.id}" data-fk="amt-${l.id}" data-field="amount" type="number" inputmode="decimal" min="0.01" step="0.01"
                placeholder="₱" value="${esc(l.amount)}">
            </div>
            <button type="button" class="icon-btn expense-line__remove" data-remove-line="${l.id}" aria-label="Remove line ${i + 1}">${icon('x')}</button>
          </div>`).join('')}
      </div>
      <div class="expense-foot">
        <button type="button" class="btn btn--neutral btn--sm" data-action="add-line">${icon('plus')}Add another item</button>
        <span class="expense-foot__total">Total <strong class="num" data-region="exp-total">${peso(total)}</strong></span>
        <button type="button" class="btn btn--primary" data-action="save-expenses">${complete.length > 1 ? `Save ${complete.length} expenses` : 'Save expense'}</button>
      </div>`;
  }

  /** Update the running total and button label without re-rendering the inputs being typed in. */
  function refreshExpenseTotals() {
    const complete = lines.filter((l) => l.description.trim() && Number(l.amount) > 0);
    const totalEl = $('[data-region=exp-total]');
    if (totalEl) totalEl.textContent = peso(complete.reduce((s, l) => s + Number(l.amount), 0));
    const save = $('[data-action=save-expenses]');
    if (save) save.textContent = complete.length > 1 ? `Save ${complete.length} expenses` : 'Save expense';
  }

  function renderSales() {
    const target = $('[data-region=sales]');
    const countEl = $('[data-region=sales-count]');
    if (!txs) { target.innerHTML = loadingBlock(); countEl.textContent = ''; return; }
    countEl.textContent = `${txs.length} transaction${txs.length === 1 ? '' : 's'}`;
    if (!txs.length) { target.innerHTML = emptyBlock('No sales in this shift yet.'); return; }
    const t = rep.totals(txs);
    target.innerHTML = `
      <table class="data-table data-table--compact">
        <thead><tr>
          <th scope="col">Time</th>
          <th scope="col">Table</th>
          <th scope="col" class="t-right">Played</th>
          <th scope="col" class="t-right">Table fee</th>
          <th scope="col" class="t-right">Products</th>
          <th scope="col">Payment</th>
          <th scope="col">Cashier</th>
          <th scope="col" class="t-right">Total</th>
          <th scope="col"><span class="sr-only">Receipt</span></th>
        </tr></thead>
        <tbody>
          ${txs.map((x) => {
            const p = rep.paymentsOf(x);
            return `
          <tr>
            <td class="cell-nowrap">${fmtTime(x.createdAt)}${shiftTag(x.createdAt)}</td>
            <th scope="row">
              <span class="cell-strong">${x.tableId ? esc(x.tableName) : 'Walk-in'}</span>
              ${x.tableFeeVoided ? `<span class="cell-sub">Table fee voided · ${peso(x.refundAmount)} refunded</span>` : ''}
            </th>
            <td class="t-right num cell-num">${x.tableId ? fmtHuman(x.durationMs || 0) : '—'}</td>
            <td class="t-right num cell-num">${peso(x.tableFee)}</td>
            <td class="t-right num cell-num">${peso(x.productTotal)}</td>
            <td>${METHOD_LABEL[x.method] || esc(x.method)}${x.method === 'split' ? `<span class="cell-sub num">${peso(p.cash)} cash · ${peso(p.gcash)} GCash</span>` : ''}</td>
            <td>${esc(x.cashierName)}</td>
            <td class="t-right num cell-num cell-total">${peso(x.total)}</td>
            <td class="t-right"><button type="button" class="btn btn--neutral btn--sm" data-tx-id="${esc(x.id)}" aria-label="View receipt, ${fmtTime(x.createdAt)}">${icon('receipt')}View</button></td>
          </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr>
          <th scope="row" colspan="3">Total</th>
          <td class="t-right num cell-num">${peso(t.tableFee)}</td>
          <td class="t-right num cell-num">${peso(t.productTotal)}</td>
          <td class="num cell-num" colspan="2">${peso(t.cash)} cash · ${peso(t.gcash)} GCash</td>
          <td class="t-right num cell-num cell-total">${peso(t.total)}</td>
          <td></td>
        </tr></tfoot>
      </table>`;
  }

  function renderExpenses() {
    const target = $('[data-region=expenses]');
    const countEl = $('[data-region=exp-count]');
    if (!expenses) { target.innerHTML = loadingBlock(); countEl.textContent = ''; return; }
    countEl.textContent = expenses.length ? `${expenses.length} item${expenses.length === 1 ? '' : 's'} · ${peso(rep.expenseTotal(expenses))}` : '';
    if (!expenses.length) { target.innerHTML = emptyBlock('No expenses logged in this shift.'); return; }
    target.innerHTML = `
      <table class="data-table data-table--compact">
        <thead><tr>
          <th scope="col">Time</th>
          <th scope="col">What for</th>
          <th scope="col">Logged by</th>
          <th scope="col" class="t-right">Amount</th>
          ${owner ? '<th scope="col"><span class="sr-only">Remove</span></th>' : ''}
        </tr></thead>
        <tbody>
          ${expenses.map((e) => `
          <tr>
            <td class="cell-nowrap">${fmtTime(e.createdAt)}${shiftTag(e.createdAt)}</td>
            <th scope="row" class="cell-strong">${esc(e.description)}</th>
            <td>${esc(e.cashierName)}</td>
            <td class="t-right num cell-num">${peso(e.amount)}</td>
            ${owner ? `<td class="t-right"><button type="button" class="btn btn--danger-ghost btn--sm" data-remove-expense="${esc(e.id)}" aria-label="Remove expense: ${esc(e.description)}">Remove</button></td>` : ''}
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <th scope="row" colspan="3">Total</th>
          <td class="t-right num cell-num cell-total">${peso(rep.expenseTotal(expenses))}</td>
          ${owner ? '<td></td>' : ''}
        </tr></tfoot>
      </table>`;
  }

  function renderProducts() {
    const target = $('[data-region=products]');
    if (!txs) { target.innerHTML = loadingBlock(); return; }
    const products = rep.topProducts(txs);
    target.innerHTML = products.length ? `
      <table class="data-table data-table--compact">
        <thead><tr>
          <th scope="col">Item</th>
          <th scope="col" class="t-right">Qty</th>
          <th scope="col" class="t-right">Revenue</th>
        </tr></thead>
        <tbody>
          ${products.map((p) => `
          <tr>
            <th scope="row" class="cell-strong">${esc(p.name)}</th>
            <td class="t-right num cell-num">${p.qty}</td>
            <td class="t-right num cell-num">${peso(p.revenue)}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : emptyBlock('No items sold in this shift.');
  }

  function render() {
    $('[data-region=range-label]').textContent = rangeLabel();
    renderStats();
    renderSales();
    renderExpenses();
    renderProducts();
  }

  /* ---------- actions ---------- */

  async function saveExpenses(button) {
    const started = lines.filter((l) => l.description.trim() || l.amount !== '');
    if (started.some((l) => !l.description.trim() || !(Number(l.amount) > 0))) {
      toast('Fill in both what it was for and the amount on each line you started.', 'error');
      return;
    }
    const count = await busy(button, () => svc.recordExpenses(started, ctx.user));
    if (!count) return;
    toast(count === 1 ? 'Expense saved to this shift.' : `${count} expenses saved to this shift.`);
    lines = [newLine(), newLine(), newLine()];
    renderExpenseForm();
  }

  function confirmRemove(expense) {
    openDialog({
      title: 'Remove expense?',
      body: `<p><strong>${esc(expense.description)}</strong>, ${peso(expense.amount)}, logged by ${esc(expense.cashierName)} at ${fmtTime(expense.createdAt)}.</p>
        <p class="muted small">Remove it only if it was entered by mistake. The shift's cash to count goes up by this amount.</p>`,
      submitLabel: 'Remove expense',
      submitClass: 'btn--danger',
      onSubmit: async () => {
        await svc.removeExpense(expense.id);
        toast('Expense removed.');
      },
    });
  }

  function csvRows() {
    const t = rep.totals(txs, expenses);
    // The Shift column only appears when the hall runs Day and Night shifts.
    const shiftCol = (v) => (!twoShifts() ? [] : typeof v === 'number' ? [rep.SHIFT_SHORT[rep.shiftOf(v)]] : [v]);
    return [
      ['Golden Break Billiard Hall shift report', rangeLabel()],
      [],
      ['Time', ...shiftCol('Shift'), 'Table', 'Played (min)', 'Table fee', 'Products', 'Total', 'Method', 'Cash', 'GCash', 'Cashier', 'Remarks'],
      ...txs.map((x) => {
        const p = rep.paymentsOf(x);
        return [
          fmtTime(x.createdAt), ...shiftCol(x.createdAt), x.tableId ? x.tableName : 'Walk-in',
          x.tableId ? Math.round((x.durationMs || 0) / 60000) : '', x.tableFee, x.productTotal, x.total,
          METHOD_LABEL[x.method] || x.method, p.cash, p.gcash, x.cashierName,
          x.tableFeeVoided ? `Table fee voided (${x.voidReason}), refunded ${x.refundAmount}` : '',
        ];
      }),
      ['Total', ...shiftCol(''), '', '', t.tableFee, t.productTotal, t.total, '', t.cash, t.gcash, '', ''],
      [],
      ['Expenses'],
      ['Time', ...shiftCol('Shift'), 'What for', 'Logged by', 'Amount'],
      ...expenses.map((e) => [fmtTime(e.createdAt), ...shiftCol(e.createdAt), e.description, e.cashierName, e.amount]),
      ['Total', ...shiftCol(''), '', '', t.expenses],
      [],
      ['Summary'],
      ['Sales', t.total],
      ['Cash collected', t.cash],
      ['GCash collected', t.gcash],
      ['Expenses', t.expenses],
      ['Cash to count', t.cashToCount],
      ['Net sales', t.net],
    ];
  }

  function exportCsv() {
    if (!txs || !expenses) return;
    const blob = new Blob(['﻿', rep.toCsv(csvRows())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const suffix = shift === 'full' ? key : `${key}-${shift}`;
    const a = Object.assign(document.createElement('a'), { href: url, download: `golden-break-shift-${suffix}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- events ---------- */

  let picked = false; // once someone picks a shift, a settings change no longer moves the selection

  function setShift(nextKey, nextShift) {
    if (!nextKey) { dateInput.value = key; return; }
    [key, shift] = [nextKey > today ? today : nextKey, nextShift];
    dateInput.value = key;
    renderPicker();
    renderExpenseForm();
    subscribe();
  }

  dateInput.addEventListener('change', () => { picked = true; setShift(dateInput.value, shift); });
  el.addEventListener('change', (e) => {
    if (e.target.name === 'shift') { picked = true; setShift(key, e.target.value); }
    if (e.target.dataset.action === 'two-shifts') {
      const box = e.target;
      busy(box, () => svc.setTwoShifts(box.checked)).then((ok) => {
        if (ok === undefined) box.checked = twoShifts();
        else toast(box.checked ? 'Day and Night shifts are on.' : 'Back to one shift per business day.');
      });
    }
  });

  /** One shift → always the full business day. Two shifts → default to the shift on duty now. */
  function onSettings() {
    const box = $('[data-action=two-shifts]');
    if (box) box.checked = twoShifts();
    const next = !twoShifts() ? 'full' : picked ? shift : (key === today ? rep.shiftOf(Date.now()) : 'full');
    if (next !== shift) setShift(key, next);
    else { renderPicker(); render(); }
  }

  el.addEventListener('input', (e) => {
    const input = e.target.closest('[data-field]');
    const row = input?.closest('[data-line]');
    const line = row && lines.find((l) => l.id === row.dataset.line);
    if (!line) return;
    line[input.dataset.field] = input.value;
    refreshExpenseTotals();
  });

  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'csv') exportCsv();
    if (action === 'print') window.print();
    if (action === 'add-line') {
      lines.push(newLine());
      renderExpenseForm();
      el.querySelector(`#exp-desc-${lines.at(-1).id}`)?.focus();
    }
    if (action === 'save-expenses') saveExpenses(e.target.closest('button'));

    const removeLine = e.target.closest('[data-remove-line]');
    if (removeLine) {
      lines = lines.length === 1 ? [newLine()] : lines.filter((l) => l.id !== removeLine.dataset.removeLine);
      renderExpenseForm();
    }
    const removeExpense = e.target.closest('[data-remove-expense]');
    const expense = removeExpense && expenses?.find((x) => x.id === removeExpense.dataset.removeExpense);
    if (expense && owner) confirmRemove(expense);
    const txBtn = e.target.closest('[data-tx-id]');
    const tx = txBtn && txs?.find((x) => x.id === txBtn.dataset.txId);
    if (tx) receiptDialog(tx);
  });

  // Roll the expense form over when the shift on duty changes while this page is open.
  const clock = setInterval(() => {
    const visible = !$('[data-region=expense-form]').hidden;
    if (visible !== isCurrent()) renderExpenseForm();
  }, 30000);

  const offSettings = on('settings', onSettings);

  renderPicker();
  renderExpenseForm();
  subscribe();
  return () => { unsubs.forEach((off) => off()); offSettings(); clearInterval(clock); };
}
