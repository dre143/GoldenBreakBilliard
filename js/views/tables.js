import { state, on } from '../state.js';
import * as svc from '../services.js';
import {
  manageTablesDialog, bookingDialog, transferTableDialog, startTicketDialog,
} from '../dialogs.js';
import { isTimed } from '../billing.js';
import { serverNow } from '../clock.js';
import { updateTableTimers } from './shared.js';
import { poolCard } from './pool-card.js';
import {
  esc, icon, todayLabel, fmtBooking, openDialog,
  pageHeader, searchField, loadingBlock, emptyBlock, preserveFocus, busy, toast,
} from '../ui.js';
import { isOwnerLevel } from '../roles.js';

export function mount(el, ctx) {
  const owner = isOwnerLevel(ctx.user);
  let query = '';

  el.innerHTML = `
    ${pageHeader({
      title: 'Tables',
      subtitle: esc(todayLabel()),
      actions: `
        ${searchField('table-search', 'Search tables')}
        <a class="btn btn--neutral" href="#/quick-sale">${icon('bag')}Quick Sale</a>
        ${owner ? `<button type="button" class="btn btn--neutral" data-action="manage-tables">${icon('edit')}Manage Tables</button>` : ''}`,
    })}
    <section class="pool-grid" data-region="grid" aria-label="Billiard tables"></section>`;

  const grid = el.querySelector('[data-region=grid]');

  function renderGrid() {
    if (!state.loaded.tables) { grid.innerHTML = loadingBlock('Loading tables…'); return; }
    const rows = state.tables.filter((t) => !query || t.name.toLowerCase().includes(query) || String(t.number) === query);
    preserveFocus(grid, () => {
      grid.innerHTML = rows.length
        ? rows.map((t) => poolCard(t)).join('')
        : state.tables.length
          ? emptyBlock('No tables match your search.')
          : emptyBlock('No tables yet.', owner ? 'Use Manage Tables to add your first table.' : 'Ask the owner to set up tables.');
    });
  }

  const offs = [
    on('tables', renderGrid),
    on('tick', () => updateTableTimers(grid)),
  ];

  el.querySelector('#table-search').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  /** Tapping a table card opens its actions; nothing is shown on the card itself. */
  function tableActions(table) {
    const live = table.status === 'in_use' && Boolean(table.session);
    const name = table.name;
    const { dlg, close } = openDialog({
      title: esc(name),
      cancelLabel: 'Close',
      body: live
        ? `<p class="muted">${table.session.ended ? 'Session ended, waiting for payment.' : isTimed(table.session) ? `Booked ${esc(fmtBooking(table.session.plannedMs))}, in use.` : 'Open time, in use.'}</p>
           <div class="table-actions">
             <a class="btn btn--amber btn--lg" href="#/checkout/${encodeURIComponent(table.id)}" data-close-dialog>${icon(table.session.ended ? 'receipt' : 'stop')}${table.session.ended ? 'Checkout' : 'Stop &amp; Bill'}</a>
             ${!table.session.ended ? `<button type="button" class="btn btn--neutral btn--lg" data-action="transfer">${icon('transfer')}Transfer Table</button>` : ''}
           </div>`
        : `<p class="muted">Available. Start a session on this table.</p>
           <div class="table-actions">
             <button type="button" class="btn btn--primary btn--lg" data-action="open-time">${icon('play')}Open Time</button>
             <button type="button" class="btn btn--neutral btn--lg" data-action="set-hours">${icon('clock')}Set Hours</button>
           </div>`,
    });
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-dialog]')) { close(); return; }
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'open-time') {
        busy(btn, async () => {
          const startedAtMs = serverNow();
          await svc.startSession(table.id, ctx.user);
          close();
          toast(`${name}: open time started`);
          startTicketDialog({
            tableName: name, plannedMs: 0, startedAtMs, cashierName: ctx.user.name,
          });
        });
      }
      if (btn.dataset.action === 'transfer') {
        close();
        transferTableDialog(table, ctx.user);
      }
      if (btn.dataset.action === 'set-hours') {
        close();
        bookingDialog({
          title: `Set hours · ${esc(name)}`,
          submitLabel: 'Start',
          onPick: async (ms) => {
            const startedAtMs = serverNow();
            await svc.startSession(table.id, ctx.user, { booking: ms });
            toast(`${name}: ${fmtBooking(ms)} started`);
            startTicketDialog({
              tableName: name, plannedMs: ms, startedAtMs, cashierName: ctx.user.name,
            });
          },
        });
      }
    });
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'manage-tables') manageTablesDialog();
    if (btn.dataset.action === 'open-table') {
      const table = state.tables.find((t) => t.id === btn.dataset.id);
      if (table) tableActions(table);
    }
  });

  renderGrid();
  return () => offs.forEach((off) => off());
}
