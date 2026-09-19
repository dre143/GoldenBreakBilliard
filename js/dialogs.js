import { state, on } from './state.js';
import * as svc from './services.js';
import {
  esc, icon, peso, fmtDuration, fmtCountdown, fmtDateTime, fmtTime, fmtBooking, METHOD_LABEL, openDialog, toast, preserveFocus,
} from './ui.js';
import {
  canCancelGame, cancelTimeLeft, CANCEL_REASONS, elapsedMs, feeBreakdown, PRICING_LABEL, PRICING, tableFee, BOOKING_PRESETS,
} from './billing.js';
import { serverNow } from './clock.js';

const num = (v) => Number(String(v).trim());

function requireName(fd, key = 'name', label = 'Name') {
  const v = String(fd.get(key) || '').trim();
  if (!v) throw new Error(`${label} is required.`);
  return v;
}

function requireNumber(fd, key, label, { min = 0, integer = false } = {}) {
  const raw = fd.get(key);
  const v = num(raw);
  if (raw === '' || Number.isNaN(v) || v < min || (integer && !Number.isInteger(v))) {
    throw new Error(`${label} must be ${integer ? 'a whole number' : 'a number'} of at least ${min}.`);
  }
  return v;
}

export function tableDialog(table) {
  const editing = Boolean(table);
  const nextNumber = Math.max(0, ...state.tables.map((t) => t.number || 0)) + 1;
  openDialog({
    title: editing ? `Edit ${esc(table.name)}` : 'Add table',
    submitLabel: editing ? 'Save changes' : 'Add table',
    body: `
      <div class="field">
        <label for="t-name">Table name</label>
        <input id="t-name" name="name" required maxlength="40" value="${esc(table?.name ?? `Table ${String(nextNumber).padStart(2, '0')}`)}">
      </div>
      <p class="field__hint">Every table uses the hall rate: ${PRICING_LABEL}.</p>`,
    async onSubmit(fd) {
      const data = { name: requireName(fd, 'name', 'Table name') };
      if (editing) await svc.updateTable(table.id, data);
      else await svc.addTable({ ...data, number: nextNumber });
      toast(editing ? `${data.name} updated` : `${data.name} added`);
    },
  });
}

/**
 * Pick a booked length: presets (1/2/3 hours) or custom hours + minutes in 15-minute steps, with a
 * live price preview. Used for "Set Hours" (new booking) and "Add time" (extending one).
 * baseMs: time already booked (for extensions); elapsedNow: time already played (for the preview).
 */
export function bookingDialog({ title, submitLabel, baseMs = 0, elapsedNow = 0, onPick }) {
  const extending = baseMs > 0;
  openDialog({
    title,
    submitLabel,
    body: `
      <fieldset class="booking-presets">
        <legend>${extending ? 'Add' : 'Hours'}</legend>
        ${[...(extending ? [30 * 60000] : []), ...BOOKING_PRESETS].map((ms, i) => `
        <label class="booking-preset">
          <input type="radio" name="preset" value="${ms}" ${i === (extending ? 1 : 0) ? 'checked' : ''}>
          <span><span class="num booking-preset__len">${fmtBooking(ms)}</span></span>
        </label>`).join('')}
        <label class="booking-preset">
          <input type="radio" name="preset" value="custom">
          <span>Custom</span>
        </label>
      </fieldset>
      <div class="field-row booking-custom" hidden>
        <div class="field">
          <label for="bk-h">Hours</label>
          <select id="bk-h" name="h">${Array.from({ length: 13 }, (_, h) => `<option value="${h}" ${h === 1 ? 'selected' : ''}>${h}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="bk-m">Minutes</label>
          <select id="bk-m" name="m">${[0, 15, 30, 45].map((m) => `<option value="${m}">${m}</option>`).join('')}</select>
        </div>
      </div>
      <dl class="kv">
        <div><dt>${extending ? 'New booking' : 'Booked'}</dt><dd class="num" data-len></dd></div>
        <div><dt>Minimum charge</dt><dd class="num" data-fee></dd></div>
        <div><dt>Ends around</dt><dd class="num" data-ends></dd></div>
      </dl>
      <p class="muted small">Booked time is the minimum charge. If they play longer, the extra time is billed at ₱${PRICING.bracketPrice} per started ${PRICING.bracketMinutes} minutes.</p>`,
    onOpen(dlg) {
      const form = dlg.querySelector('form');
      const custom = dlg.querySelector('.booking-custom');
      const pick = () => {
        const preset = form.elements.preset.value;
        custom.hidden = preset !== 'custom';
        return preset === 'custom'
          ? (Number(form.elements.h.value) * 60 + Number(form.elements.m.value)) * 60000
          : Number(preset);
      };
      const update = () => {
        const add = pick();
        const total = baseMs + add;
        dlg.querySelector('[data-len]').textContent = add ? fmtBooking(total) : '—';
        dlg.querySelector('[data-fee]').textContent = add ? peso(tableFee(Math.max(total, elapsedNow))) : '—';
        dlg.querySelector('[data-ends]').textContent = add ? fmtTime(serverNow() - elapsedNow + total) : '—';
      };
      form.addEventListener('change', update);
      update();
      dlg.pickBooking = pick;
    },
    async onSubmit(fd, dlg) {
      const ms = dlg.pickBooking();
      if (!(ms > 0)) throw new Error('Choose at least 15 minutes.');
      await onPick(ms);
    },
  });
}

/** Owner-only table admin, kept off the floor grid so each table card has a single action. */
export function manageTablesDialog() {
  let off = () => {};
  const { dlg } = openDialog({
    title: 'Manage tables',
    wide: true,
    cancelLabel: 'Done',
    body: `
      <button type="button" class="btn btn--primary" data-action="add-table">${icon('plus')}Add table</button>
      <ul class="manage-list" data-region="tables" aria-label="Tables"></ul>`,
    onClose: () => off(),
  });
  const list = dlg.querySelector('[data-region=tables]');
  const render = () => preserveFocus(list, () => {
    list.innerHTML = state.tables.length ? state.tables.map((t) => `
      <li class="manage-row">
        <span class="manage-row__text">
          <span class="manage-row__name">${esc(t.name)}</span>
          <span class="manage-row__sub">${t.status === 'in_use' ? 'In Use' : 'Available'}</span>
        </span>
        <button type="button" class="btn btn--neutral btn--sm" data-edit="${esc(t.id)}" data-fk="edit-${esc(t.id)}" aria-label="Edit ${esc(t.name)}">${icon('edit')}Edit</button>
      </li>`).join('') : '<li class="muted">No tables yet.</li>';
  });
  off = on('tables', render);
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-action=add-table]')) tableDialog();
    const edit = e.target.closest('[data-edit]');
    const table = edit && state.tables.find((t) => t.id === edit.dataset.edit);
    if (table) tableDialog(table);
  });
  render();
}

export function productDialog(product) {
  const editing = Boolean(product);
  const categories = [...new Set(state.products.map((p) => p.category))].sort();
  openDialog({
    title: editing ? 'Edit product' : 'Add product',
    submitLabel: editing ? 'Save changes' : 'Add product',
    body: `
      <div class="field">
        <label for="p-name">Product name</label>
        <input id="p-name" name="name" required maxlength="60" value="${esc(product?.name ?? '')}">
      </div>
      <div class="field">
        <label for="p-cat">Category</label>
        <input id="p-cat" name="category" required list="p-cat-list" maxlength="30" value="${esc(product?.category ?? '')}">
        <datalist id="p-cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="p-price">Unit price (₱)</label>
          <input id="p-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${product?.price ?? ''}">
        </div>
        ${editing ? '' : `
        <div class="field">
          <label for="p-stock">Opening stock</label>
          <input id="p-stock" name="stock" type="number" inputmode="numeric" min="0" step="1" required value="0">
        </div>`}
        <div class="field">
          <label for="p-reorder">Reorder level</label>
          <input id="p-reorder" name="reorderLevel" type="number" inputmode="numeric" min="0" step="1" required value="${product?.reorderLevel ?? 10}">
        </div>
      </div>
      ${editing ? '<p class="field__hint">Use “Add Stock” to change quantities so restocks are logged.</p>' : ''}`,
    async onSubmit(fd) {
      const data = {
        name: requireName(fd, 'name', 'Product name'),
        category: requireName(fd, 'category', 'Category'),
        price: requireNumber(fd, 'price', 'Price'),
        reorderLevel: requireNumber(fd, 'reorderLevel', 'Reorder level', { integer: true }),
      };
      if (editing) {
        await svc.updateProduct(product.id, data);
      } else {
        await svc.addProduct({ ...data, stock: requireNumber(fd, 'stock', 'Opening stock', { integer: true }) });
      }
      toast(editing ? `${data.name} updated` : `${data.name} added to inventory`);
    },
  });
}

export function addStockDialog(product, user) {
  openDialog({
    title: `Add stock · ${esc(product.name)}`,
    submitLabel: 'Add stock',
    body: `
      <dl class="kv">
        <div><dt>On hand</dt><dd class="num">${product.stock}</dd></div>
        <div><dt>Reorder level</dt><dd class="num">${product.reorderLevel}</dd></div>
        <div><dt>After restock</dt><dd class="num" data-after>${product.stock}</dd></div>
      </dl>
      <div class="field">
        <label for="s-qty">Quantity received</label>
        <input id="s-qty" name="qty" type="number" inputmode="numeric" min="1" step="1" required autofocus>
      </div>`,
    onOpen(dlg) {
      const input = dlg.querySelector('#s-qty');
      const after = dlg.querySelector('[data-after]');
      input.addEventListener('input', () => {
        const q = Math.max(0, Math.floor(num(input.value)) || 0);
        after.textContent = product.stock + q;
      });
    },
    async onSubmit(fd) {
      const qty = requireNumber(fd, 'qty', 'Quantity', { min: 1, integer: true });
      const total = await svc.addStock(product.id, qty, user);
      toast(`${product.name}: +${qty} (now ${total})`);
    },
  });
}

export function staffDialog(member, currentUser) {
  const editing = Boolean(member);
  const self = editing && member.id === currentUser.uid;
  openDialog({
    title: editing ? `Edit ${esc(member.name)}` : 'Add staff account',
    submitLabel: editing ? 'Save changes' : 'Create account',
    body: `
      <div class="field">
        <label for="u-name">Full name</label>
        <input id="u-name" name="name" required maxlength="60" autocomplete="off" value="${esc(member?.name ?? '')}">
      </div>
      ${editing ? `<p class="field__hint">Login email: ${esc(member.email)}</p>` : `
      <div class="field">
        <label for="u-email">Login email</label>
        <input id="u-email" name="email" type="email" required autocomplete="off">
      </div>
      <div class="field">
        <label for="u-pass">Temporary password</label>
        <input id="u-pass" name="password" type="password" minlength="6" required autocomplete="new-password">
        <p class="field__hint">At least 6 characters. Share it with the staff member privately.</p>
      </div>`}
      <div class="field">
        <label for="u-role">Role</label>
        <select id="u-role" name="role" ${self ? 'disabled' : ''}>
          <option value="cashier" ${member?.role === 'cashier' || !member ? 'selected' : ''}>Cashier</option>
          <option value="owner" ${member?.role === 'owner' ? 'selected' : ''}>Owner</option>
        </select>
        ${self ? '<p class="field__hint">You can’t change your own role.</p>' : ''}
      </div>
      ${editing && !self ? `
      <label class="check">
        <input type="checkbox" name="active" ${member.active !== false ? 'checked' : ''}>
        <span>Account active (unchecked accounts can’t sign in)</span>
      </label>` : ''}`,
    async onSubmit(fd) {
      const name = requireName(fd, 'name', 'Full name');
      if (editing) {
        const patch = { name };
        if (!self) { patch.role = fd.get('role'); patch.active = fd.get('active') === 'on'; }
        await svc.updateStaff(member.id, patch);
        toast(`${name} updated`);
      } else {
        const email = String(fd.get('email') || '').trim();
        const password = String(fd.get('password') || '');
        if (!email) throw new Error('Login email is required.');
        if (password.length < 6) throw new Error('Password must be at least 6 characters.');
        await svc.createStaff({ name, email, password, role: fd.get('role') });
        toast(`Account created for ${name}`);
      }
    },
  });
}

/**
 * Receipt for a completed sale. A game cancelled within 5 minutes shows its ₱0 table fee and why.
 * (Sales from before Cancel game existed may carry a table-fee void instead; those still display.)
 */
export function receiptDialog(tx, { fresh = false } = {}) {
  const cancelled = Boolean(tx.gameCancelled);
  const voided = Boolean(tx.tableFeeVoided);
  openDialog({
    title: cancelled ? 'Game cancelled' : voided ? 'Table fee voided' : fresh ? 'Transaction complete' : 'Receipt',
    cancelLabel: 'Close',
    body: `
      <div class="receipt ${cancelled || voided ? 'is-voided' : ''}">
        ${cancelled ? `
        <div class="void-banner" role="note">
          <span class="badge badge--danger">Game cancelled</span>
          <span>${esc(tx.cancelReason)}${tx.cancelNote ? ` · “${esc(tx.cancelNote)}”` : ''}<br>
            <span class="muted small">Cancelled by ${esc(tx.cancelledByName)} within the first 5 minutes, so there is no table fee.${tx.productTotal ? ' Items were still charged.' : ''}</span></span>
        </div>` : ''}
        ${voided ? `
        <div class="void-banner" role="note">
          <span class="badge badge--danger">Table fee voided</span>
          <span>${esc(tx.voidReason)}${tx.voidNote ? ` · “${esc(tx.voidNote)}”` : ''}<br>
            <span class="muted small">By ${esc(tx.tableFeeVoidedByName)} at ${fmtDateTime(tx.tableFeeVoidedAt)}. ${peso(tx.refundAmount)} refunded via ${tx.refundMethod === 'gcash' ? 'GCash' : 'Cash'}.</span></span>
        </div>` : ''}
        <div class="receipt__head">
          <p class="receipt__table">${tx.tableId ? esc(tx.tableName) : 'Walk-in sale'}</p>
          <p class="muted">${fmtDateTime(tx.createdAt)} · ${esc(tx.cashierName)}</p>
        </div>
        <dl class="sum-lines">
          ${tx.tableId ? `
          <div class="sum-row">
            <dt>Table fee<span class="sum-sub">${fmtDuration(tx.durationMs)} played${tx.plannedMs ? ` · ${fmtBooking(tx.plannedMs)} booked` : ' · open time'}${cancelled ? ' · cancelled' : ` · ${tx.pricing ? feeBreakdown(tx.billedMs ?? tx.durationMs, tx.pricing) : `${peso(tx.rate)}/hr (old rate)`}`}</span></dt>
            <dd class="num">${voided ? `<s class="muted">${peso(tx.originalTableFee)}</s> Waived` : cancelled ? 'No charge' : peso(tx.tableFee)}</dd>
          </div>
          ${tx.rounds ? `<div class="sum-row sum-row--muted"><dt>Rounds played</dt><dd class="num">${tx.rounds}</dd></div>` : ''}` : ''}
          ${(tx.items || []).map((i) => `
          <div class="sum-row">
            <dt>${i.qty} × ${esc(i.name)}<span class="sum-sub">${peso(i.price)} each</span></dt>
            <dd class="num">${peso(i.total ?? i.price * i.qty)}</dd>
          </div>`).join('')}
        </dl>
        <hr class="divider">
        <div class="summary-total">
          <span class="summary-total__label">Total</span>
          <span class="num summary-total__value">${peso(tx.total)}</span>
        </div>
        <dl class="sum-lines">
          <div class="sum-row"><dt>Paid via</dt><dd>${METHOD_LABEL[tx.method] || esc(tx.method)}</dd></div>
          ${tx.gcashRef ? `<div class="sum-row"><dt>GCash ref no. (last 5)</dt><dd class="num">${esc(tx.gcashRef)}</dd></div>` : ''}
          ${tx.method === 'split' && tx.payments ? `
          <div class="sum-row"><dt>Cash</dt><dd class="num">${peso(tx.payments.cash)}</dd></div>
          <div class="sum-row"><dt>GCash</dt><dd class="num">${peso(tx.payments.gcash)}</dd></div>` : ''}
          ${tx.tendered != null ? `
          <div class="sum-row"><dt>Cash tendered</dt><dd class="num">${peso(tx.tendered)}</dd></div>
          <div class="sum-row sum-row--strong"><dt>Change</dt><dd class="num">${peso(tx.change)}</dd></div>` : ''}
          ${voided ? `<div class="sum-row sum-row--strong"><dt>Refunded (table fee)</dt><dd class="num">${peso(tx.refundAmount)}</dd></div>` : ''}
        </dl>
      </div>`,
  });
}

/**
 * Cancel a game in its first 5 minutes, before anyone pays: reason (required), optional note.
 * No items on the bill → the table is freed straight away with no charge.
 * Items on the bill → the table fee becomes ₱0 and the cashier takes payment for the items.
 */
export function cancelGameDialog(table, { onDone } = {}) {
  const items = table.session.items || [];
  const itemsDue = items.reduce((s, i) => s + i.price * i.qty, 0);
  const { dlg } = openDialog({
    title: `Cancel game · ${esc(table.name)}`,
    submitLabel: items.length ? 'Cancel game' : 'Cancel game, no charge',
    submitClass: 'btn--danger',
    cancelLabel: 'Keep playing',
    body: `
      <p><strong>${esc(table.name)}</strong> · played <span class="num" data-live="played"></span> ·
        <span data-live="left"></span></p>
      <p>${items.length
        ? `The table fee becomes <strong>₱0</strong>. The items on the bill (<strong class="num">${peso(itemsDue)}</strong>) still need to be paid, so take payment for them next.`
        : 'The clock stops and the table is freed with <strong>no charge</strong>.'}</p>
      <fieldset class="reason-list">
        <legend>Reason</legend>
        ${CANCEL_REASONS.map((r, i) => `
        <label class="reason">
          <input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'required' : ''}>
          <span>${esc(r)}</span>
        </label>`).join('')}
      </fieldset>
      <div class="field">
        <label for="cancel-note">Note <span class="muted" data-note-hint>(optional)</span></label>
        <input id="cancel-note" name="note" maxlength="140" placeholder="What happened?">
      </div>
      <p class="muted small">Only possible in the first 5 minutes. This can’t be undone.</p>`,
    onOpen(d) {
      d.querySelectorAll('input[name=reason]').forEach((r) => r.addEventListener('change', () => {
        d.querySelector('[data-note-hint]').textContent = r.value === 'Other' ? '(required)' : '(optional)';
      }));
    },
    async onSubmit(fd) {
      const reason = fd.get('reason');
      if (!reason) throw new Error('Choose a reason for cancelling.');
      const live = state.tables.find((t) => t.id === table.id) || table;
      if (!canCancelGame(live)) throw new Error('This game has run for more than 5 minutes, so it can no longer be cancelled.');
      const result = await svc.cancelGame(table.id, { reason, note: String(fd.get('note') || '') }, state.user);
      if (!result.hasItems) {
        await svc.completeCheckout(table.id, { method: 'none' }, state.user);
        toast(`${result.tableName}: game cancelled, no charge. The table is free.`);
      } else {
        toast(`${result.tableName}: game cancelled. Table fee is ₱0. Take payment for the items.`);
      }
      onDone?.(result);
    },
  });

  // Live countdown while the dialog is open; the window closing disables the button.
  const tick = () => {
    if (!dlg.isConnected) { off(); return; }
    const live = state.tables.find((t) => t.id === table.id);
    if (!live?.session) return;
    const setText = (k, v) => { const n = dlg.querySelector(`[data-live=${k}]`); if (n) n.textContent = v; };
    setText('played', fmtDuration(elapsedMs(live)));
    const left = cancelTimeLeft(live);
    setText('left', left > 0 ? `${fmtCountdown(left)} left to cancel` : 'the 5 minutes are up');
    if (left <= 0) dlg.querySelector('[type=submit]').disabled = true;
  };
  const off = on('tick', tick);
  tick();
  return dlg;
}