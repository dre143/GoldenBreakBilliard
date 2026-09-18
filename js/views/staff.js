import { mode } from '../db.js';
import { state, on } from '../state.js';
import { staffDialog } from '../dialogs.js';
import { esc, icon, initials, relTime, isOnline, fmtDate, pageHeader, loadingBlock, emptyBlock, preserveFocus } from '../ui.js';

export function mount(el, ctx) {
  el.innerHTML = `
    ${pageHeader({
      title: 'Staff & Accounts',
      subtitle: 'Who can sign in, and what they can do',
      actions: `<button type="button" class="btn btn--primary" data-action="add">${icon('plus')}Add Staff</button>`,
    })}
    <section class="role-notes" aria-label="Role permissions">
      <article class="card role-note">
        <h2 class="card-title">Cashier</h2>
        <p class="muted">Runs table sessions, adds orders and completes checkout. Sees inventory (view only) and transactions.</p>
      </article>
      <article class="card role-note">
        <h2 class="card-title">Owner</h2>
        <p class="muted">Everything a cashier can do, plus product &amp; stock management, table rates, the dashboard and staff accounts.</p>
      </article>
    </section>
    <section class="card card--flush" aria-label="Staff accounts">
      <div class="table-wrap" data-region="table"></div>
    </section>
    ${mode === 'demo' ? '<p class="muted small">Demo mode: new accounts appear on the sign-in picker; no password is needed.</p>' : ''}`;

  const wrap = el.querySelector('[data-region=table]');

  function render() {
    if (!state.loaded.users) { wrap.innerHTML = loadingBlock(); return; }
    if (!state.users.length) { wrap.innerHTML = emptyBlock('No staff yet.'); return; }
    preserveFocus(wrap, () => {
      wrap.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Presence</th>
              <th scope="col">Account</th>
              <th scope="col">Added</th>
              <th scope="col" class="t-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${state.users.map((u) => {
              const online = isOnline(u);
              return `
              <tr>
                <td>
                  <div class="cell-product">
                    <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(u.name))}</span>
                    <div>
                      <p class="cell-strong">${esc(u.name)}${u.id === ctx.user.uid ? ' <span class="muted">(you)</span>' : ''}</p>
                      <p class="cell-sub">${esc(u.email)}</p>
                    </div>
                  </div>
                </td>
                <td><span class="badge ${u.role === 'owner' ? 'badge--in-use' : 'badge--neutral'}">${u.role === 'owner' ? 'Owner' : 'Cashier'}</span></td>
                <td><span class="presence ${online ? 'is-online' : ''}"><span class="presence__dot" aria-hidden="true"></span>${online ? 'Online' : `Offline · ${relTime(u.lastSeen)}`}</span></td>
                <td>${u.active === false ? '<span class="badge badge--danger">Deactivated</span>' : '<span class="badge badge--available">Active</span>'}</td>
                <td class="cell-nowrap">${u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                <td class="t-right">
                  <button type="button" class="btn btn--neutral btn--sm" data-action="edit" data-id="${esc(u.id)}" data-fk="edit-${esc(u.id)}" aria-label="Edit ${esc(u.name)}">${icon('edit')}Edit</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    });
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'add') staffDialog(null, ctx.user);
    if (btn.dataset.action === 'edit') {
      const member = state.users.find((u) => u.id === btn.dataset.id);
      if (member) staffDialog(member, ctx.user);
    }
  });

  const off = on('users', render);
  render();
  return off;
}
