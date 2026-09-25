// Transactions: find one sale, reprint its receipt, or void a short game's table fee.
// Money totals (sales, expenses, cash to count) live in Reports, so this page is only a searchable list.
import { db } from '../db.js';
import { CANCEL_WINDOW_MS } from '../billing.js';
import { receiptDialog } from '../dialogs.js';
import {
  esc, peso, fmtTime, fmtDate, fmtHuman, startOfDay, addDays, METHOD_LABEL,
  pageHeader, searchField, loadingBlock, emptyBlock, toast,
} from '../ui.js';

const RANGES = [
  { key: 'today', label: 'Today', since: () => startOfDay() },
  { key: '7d', label: 'Last 7 days', since: () => addDays(startOfDay(), -6) },
  { key: '30d', label: 'Last 30 days', since: () => addDays(startOfDay(), -29) },
];

const CANCEL_MINUTES = CANCEL_WINDOW_MS / 60000;
const saleLabel = (r) => (r.tableId ? r.tableName : r.saleType === 'cue-stick' ? 'Cue Stick' : 'Walk-in');

export function mount(el, ctx) {
  let range = 'today';
  let query = '';
  let rows = null;
  let unsub = () => {};

  el.innerHTML = `
    ${pageHeader({
      title: 'Transactions',
      subtitle: 'Find a sale and reprint its receipt. For totals and cash to count, see Reports.',
    })}
    <p class="tx-rule">To cancel a game with no table fee, open the table and use <strong>Cancel game</strong> in its first
      ${CANCEL_MINUTES} minutes, before paying. After ${CANCEL_MINUTES} minutes there is no cancel, and a paid sale can't be changed.</p>
    <section class="card card--flush" aria-labelledby="tx-title">
      <div class="toolbar">
        <div>
          <h2 class="card-title" id="tx-title">Sales</h2>
          <p class="card-sub" data-region="count"></p>
        </div>
        <div class="toolbar__controls">
          ${searchField('tx-search', 'Search transactions', 'Table, cashier, item, or QRPH ref')}
          <div class="field report-controls__shift">
            <label for="tx-range" class="sr-only">Date range</label>
            <select id="tx-range">
              ${RANGES.map((r) => `<option value="${r.key}" ${r.key === range ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="table-wrap" data-region="table"></div>
    </section>`;

  const wrap = el.querySelector('[data-region=table]');
  const count = el.querySelector('[data-region=count]');

  function filtered() {
    if (!query) return rows;
    return rows.filter((r) => `${saleLabel(r)} ${r.cashierName} ${METHOD_LABEL[r.method]} ${r.gcashRef || ''} ${(r.items || []).map((i) => i.name).join(' ')}`
      .toLowerCase().includes(query));
  }

  function render() {
    if (!rows) { wrap.innerHTML = loadingBlock('Loading transactions…'); count.textContent = ''; return; }
    const list = filtered();
    count.textContent = `${list.length} sale${list.length === 1 ? '' : 's'}`;
    if (!list.length) {
      wrap.innerHTML = emptyBlock(rows.length ? 'No sales match your search.' : 'No sales in this range yet.');
      return;
    }
    const showDate = range !== 'today';
    wrap.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th scope="col">${showDate ? 'Date & time' : 'Time'}</th>
          <th scope="col">Table</th>
          <th scope="col">Played</th>
          <th scope="col">Payment</th>
          <th scope="col">Cashier</th>
          <th scope="col" class="t-right">Total</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          ${list.map((r) => `
          <tr>
            <td class="cell-nowrap">${showDate ? `${fmtDate(r.createdAt)}, ` : ''}${fmtTime(r.createdAt)}</td>
            <td>
              <strong>${esc(saleLabel(r))}</strong>
              ${r.gameCancelled ? `<span class="tx-voided">Game cancelled · ${esc(r.cancelReason)}</span>` : ''}
              ${r.tableFeeVoided ? `<span class="tx-voided">Table fee voided · ${peso(r.refundAmount)} refunded</span>` : ''}
            </td>
            <td class="cell-nowrap">${r.tableId ? fmtHuman(r.durationMs || 0) : '—'}</td>
            <td class="cell-nowrap">${METHOD_LABEL[r.method] || esc(r.method)}${r.gcashRef ? `<span class="cell-sub">Ref ${esc(r.gcashRef)}</span>` : ''}</td>
            <td class="cell-nowrap">${esc(r.cashierName)}</td>
            <td class="t-right num"><strong>${peso(r.total)}</strong></td>
            <td class="t-right cell-nowrap">
              <button type="button" class="link-btn" data-id="${esc(r.id)}" aria-label="Receipt for ${esc(saleLabel(r))}, ${fmtTime(r.createdAt)}">Receipt</button>
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

  el.querySelector('#tx-range').addEventListener('change', (e) => { range = e.target.value; subscribe(); });
  el.querySelector('#tx-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    const tx = b && rows?.find((r) => r.id === b.dataset.id);
    if (tx) receiptDialog(tx);
  });

  subscribe();
  return () => unsub();
}
