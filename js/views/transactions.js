import { db } from '../db.js';
import { canVoidTableFee } from '../billing.js';
import { receiptDialog, voidTableFeeDialog } from '../dialogs.js';
import {
  esc, icon, peso, fmtDateTime, fmtDuration, startOfDay, addDays, METHOD_LABEL,
  pageHeader, searchField, loadingBlock, emptyBlock, toast,
} from '../ui.js';

const RANGES = [
  { key: 'today', label: 'Today', since: () => startOfDay() },
  { key: '7d', label: '7 days', since: () => addDays(startOfDay(), -6) },
  { key: '30d', label: '30 days', since: () => addDays(startOfDay(), -29) },
];

export function mount(el, ctx) {
  let range = 'today';
  let query = '';
  let rows = null;
  let unsub = () => {};

  el.innerHTML = `
    ${pageHeader({
      title: 'Transactions',
      subtitle: 'Completed table sessions and product sales',
      actions: `
        ${searchField('tx-search', 'Search transactions', 'Table, cashier, product')}
        <div class="seg seg--inline" role="radiogroup" aria-label="Date range">
          ${RANGES.map((r) => `
            <label class="seg__opt">
              <input type="radio" name="tx-range" value="${r.key}" ${r.key === range ? 'checked' : ''}>
              <span>${r.label}</span>
            </label>`).join('')}
        </div>`,
    })}
    <ul class="chips" data-region="chips" aria-label="Totals for this range"></ul>
    <section class="card card--flush" aria-label="Transactions">
      <div class="table-wrap" data-region="table"></div>
    </section>`;

  const chips = el.querySelector('[data-region=chips]');
  const wrap = el.querySelector('[data-region=table]');

  function filtered() {
    if (!query) return rows;
    return rows.filter((r) => `${r.tableId ? r.tableName : 'Walk-in'} ${r.cashierName} ${METHOD_LABEL[r.method]} ${(r.items || []).map((i) => i.name).join(' ')}`
      .toLowerCase().includes(query));
  }

  function render() {
    if (!rows) { wrap.innerHTML = loadingBlock('Loading transactions…'); chips.innerHTML = ''; return; }
    const list = filtered();
    // Sum tx.tableFee/tx.total as stored: a table-fee-voided sale already carries the reduced
    // amounts (fee waived, items still counted), so nothing needs to be excluded here.
    const voidedCount = list.filter((r) => r.tableFeeVoided).length;
    const sum = (f) => list.reduce((s, r) => s + (r[f] || 0), 0);
    chips.innerHTML = `
      <li class="chip">Transactions <strong class="num">${list.length}</strong></li>
      ${voidedCount ? `<li class="chip chip--void">Table fee voided <strong class="num">${voidedCount}</strong></li>` : ''}
      <li class="chip"><span class="dot dot--felt" aria-hidden="true"></span>Tables <strong class="num">${peso(sum('tableFee'))}</strong></li>
      <li class="chip"><span class="dot dot--amber" aria-hidden="true"></span>Products <strong class="num">${peso(sum('productTotal'))}</strong></li>
      <li class="chip chip--revenue">Total <strong class="num">${peso(sum('total'))}</strong></li>`;
    if (!list.length) {
      wrap.innerHTML = emptyBlock(rows.length ? 'No transactions match your search.' : 'No transactions in this range yet.');
      return;
    }
    wrap.innerHTML = `
      <table class="data-table data-table--compact">
        <thead>
          <tr>
            <th scope="col">Date &amp; time</th>
            <th scope="col">Table</th>
            <th scope="col" class="t-right">Duration</th>
            <th scope="col" class="t-right">Items</th>
            <th scope="col">Payment</th>
            <th scope="col">Cashier</th>
            <th scope="col" class="t-right">Total</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((r) => `
          <tr>
            <td class="cell-nowrap">${fmtDateTime(r.createdAt)}</td>
            <td class="cell-strong">${r.tableId ? esc(r.tableName) : '<span class="badge badge--neutral">Walk-in</span>'}${r.tableFeeVoided ? ' <span class="badge badge--danger">Table fee voided</span>' : ''}</td>
            <td class="t-right num cell-num">${r.tableId ? fmtDuration(r.durationMs) : '—'}</td>
            <td class="t-right num cell-num">${(r.items || []).reduce((n, i) => n + i.qty, 0)}</td>
            <td><span class="badge badge--neutral">${METHOD_LABEL[r.method] || esc(r.method)}</span></td>
            <td class="cell-nowrap">${esc(r.cashierName)}</td>
            <td class="t-right num cell-num cell-total">${peso(r.total)}</td>
            <td class="t-right">
              <div class="row-actions">
                ${canVoidTableFee(r, ctx.user) ? `<button type="button" class="btn btn--danger-ghost btn--sm" data-void="${esc(r.id)}" aria-label="Void table fee for ${esc(r.tableName)}, ${fmtDateTime(r.createdAt)}">${icon('x')}Void table fee</button>` : ''}
                <button type="button" class="btn btn--neutral btn--sm" data-id="${esc(r.id)}" aria-label="View receipt for ${r.tableId ? esc(r.tableName) : 'walk-in sale'}, ${fmtDateTime(r.createdAt)}">${icon('receipt')}View</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function subscribe() {
    unsub();
    rows = null;
    render();
    const since = RANGES.find((r) => r.key === range).since();
    unsub = db.listen('transactions', (data) => {
      rows = data.sort((a, b) => b.createdAt - a.createdAt);
      render();
    }, { where: [['createdAt', '>=', since]] }, (err) => toast(err.message, 'error'));
  }

  el.querySelectorAll('input[name=tx-range]').forEach((r) => r.addEventListener('change', () => { range = r.value; subscribe(); }));
  el.querySelector('#tx-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
  wrap.addEventListener('click', (e) => {
    const voidBtn = e.target.closest('button[data-void]');
    const b = voidBtn || e.target.closest('button[data-id]');
    const tx = b && rows?.find((r) => r.id === (voidBtn ? voidBtn.dataset.void : b.dataset.id));
    if (!tx) return;
    if (voidBtn) voidTableFeeDialog(tx);
    else receiptDialog(tx);
  });

  subscribe();
  return () => unsub();
}
