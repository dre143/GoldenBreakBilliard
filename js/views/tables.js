import { db } from '../db.js';
import { state, on } from '../state.js';
import * as svc from '../services.js';
import { manageTablesDialog, bookingDialog } from '../dialogs.js';
import { updateTableTimers } from './shared.js';
import { activeSales } from '../billing.js';
import { poolCard } from './pool-card.js';
import {
  esc, icon, peso, todayLabel, startOfDay, fmtBooking,
  pageHeader, searchField, loadingBlock, emptyBlock, preserveFocus, busy, toast,
} from '../ui.js';

export function mount(el, ctx) {
  const owner = ctx.user.role === 'owner';
  let query = '';
  let revenue = null;

  el.innerHTML = `
    ${pageHeader({
      title: 'Tables',
      subtitle: esc(todayLabel()),
      actions: `
        ${searchField('table-search', 'Search tables')}
        <a class="btn btn--neutral" href="#/quick-sale">${icon('bag')}Quick Sale</a>
        ${owner ? `<button type="button" class="btn btn--neutral" data-action="manage-tables">${icon('edit')}Manage Tables</button>` : ''}`,
    })}
    <ul class="chips" data-region="chips" aria-label="Floor summary"></ul>
    <section class="pool-grid" data-region="grid" aria-label="Billiard tables"></section>`;

  const chips = el.querySelector('[data-region=chips]');
  const grid = el.querySelector('[data-region=grid]');

  function renderChips() {
    const count = (s) => state.tables.filter((t) => t.status === s).length;
    chips.innerHTML = `
      <li class="chip"><span class="dot dot--live" aria-hidden="true"></span>In Use <strong class="num">${count('in_use')}</strong></li>
      <li class="chip"><span class="dot dot--idle" aria-hidden="true"></span>Available <strong class="num">${count('available')}</strong></li>
      <li class="chip chip--revenue">Today’s table revenue <strong class="num">${revenue == null ? '—' : peso(revenue)}</strong></li>`;
  }

  function renderGrid() {
    if (!state.loaded.tables) { grid.innerHTML = loadingBlock('Loading tables…'); return; }
    const rows = state.tables.filter((t) => !query || t.name.toLowerCase().includes(query) || String(t.number) === query);
    preserveFocus(grid, () => {
      grid.innerHTML = rows.length
        ? rows.map(poolCard).join('')
        : state.tables.length
          ? emptyBlock('No tables match your search.')
          : emptyBlock('No tables yet.', owner ? 'Use Manage Tables to add your first table.' : 'Ask the owner to set up tables.');
    });
  }

  const offs = [
    on('tables', () => { renderChips(); renderGrid(); }),
    on('tick', () => updateTableTimers(grid)),
    db.listen('transactions', (rows) => {
      revenue = activeSales(rows).reduce((sum, r) => sum + (r.tableFee || 0), 0);
      renderChips();
    }, { where: [['createdAt', '>=', startOfDay()]] }),
  ];

  el.querySelector('#table-search').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'manage-tables') manageTablesDialog();
    const table = state.tables.find((t) => t.id === btn.dataset.id);
    const name = table?.name ?? 'Table';
    if (btn.dataset.action === 'open-time') {
      busy(btn, async () => { await svc.startSession(btn.dataset.id, ctx.user); toast(`${name}: open time started`); });
    }
    if (btn.dataset.action === 'set-hours') {
      bookingDialog({
        title: `Set hours · ${esc(name)}`,
        submitLabel: 'Start',
        onPick: async (ms) => {
          await svc.startSession(btn.dataset.id, ctx.user, { booking: ms });
          toast(`${name}: ${fmtBooking(ms)} started`);
        },
      });
    }
  });

  renderChips();
  renderGrid();
  return () => offs.forEach((off) => off());
}
