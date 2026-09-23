import { state, on } from './state.js';
import * as svc from './services.js';
import {
  esc, icon, peso, fmtDuration, fmtCountdown, fmtDateTime, fmtTime, fmtBooking, METHOD_LABEL, openDialog, toast, preserveFocus, busy,
} from './ui.js';
import {
  canCancelGame, cancelTimeLeft, CANCEL_REASONS, elapsedMs, feeBreakdown, PRICING_LABEL, PRICING, tableFee, BOOKING_PRESETS,
} from './billing.js';
import { serverNow } from './clock.js';
import * as printer from './printer.js';
import { isOwnerLevel, isSuperadmin } from './roles.js';

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
        <div><dt>Fee if fully used</dt><dd class="num" data-fee></dd></div>
        <div><dt>Ends around</dt><dd class="num" data-ends></dd></div>
      </dl>
      <p class="muted small">The customer is billed only for the time actually played, so ending early costs less. The hall rate: the first hour plus a 5-minute grace, then ₱${PRICING.bracketPrice} every ${PRICING.bracketMinutes} minutes.</p>`,
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
        dlg.querySelector('[data-fee]').textContent = add ? peso(tableFee(total)) : '—';
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

/**
 * Shrinks a chosen photo to a small data URL so it can sit directly on a Firestore document.
 * PNG (lossless) for anything with sharp edges that must stay scannable/legible, like a QR code —
 * JPEG's compression artifacts can blur the fine modules enough that a phone camera can't read it.
 */
function compressImage(file, maxSize = 640, quality = 0.7, format = 'jpeg') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(`image/${format}`, format === 'png' ? undefined : quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

export const cueThumb = (c, size = 'thumb--sm') => (c.photo
  ? `<img class="thumb ${size} cue-thumb" src="${esc(c.photo)}" alt="">`
  : `<span class="thumb ${size} thumb--slate" aria-hidden="true">${icon('cue')}</span>`);

/** Add or edit one cue stick: photo, name, brand, weight, price. Owner-only, opened from Manage Cue Sticks. */
export function cueStickDialog(cueStick) {
  const editing = Boolean(cueStick);
  let photo = cueStick?.photo || null;
  const { dlg } = openDialog({
    title: editing ? 'Edit cue stick' : 'Add cue stick',
    submitLabel: editing ? 'Save changes' : 'Add cue stick',
    body: `
      <div class="field" data-region="photo-field"></div>
      <div class="field">
        <label for="cs-name">Name</label>
        <input id="cs-name" name="name" required maxlength="60" placeholder="e.g. Predator Sport II" value="${esc(cueStick?.name ?? '')}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="cs-brand">Brand</label>
          <input id="cs-brand" name="brand" maxlength="40" value="${esc(cueStick?.brand ?? '')}">
        </div>
        <div class="field">
          <label for="cs-weight">Weight</label>
          <input id="cs-weight" name="weight" maxlength="20" placeholder="e.g. 19oz" value="${esc(cueStick?.weight ?? '')}">
        </div>
      </div>
      <div class="field">
        <label for="cs-price">Price (₱)</label>
        <input id="cs-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${cueStick?.price ?? ''}">
      </div>
      ${editing && cueStick.status === 'sold' ? `<p class="field__hint">Sold ${fmtDateTime(cueStick.soldAt)} by ${esc(cueStick.soldByName)}. You can still fix these details for your records.</p>` : ''}`,
    onOpen(innerDlg) {
      const field = innerDlg.querySelector('[data-region=photo-field]');
      const renderPhoto = () => {
        field.innerHTML = `
          <label for="cs-photo">Photo</label>
          <div class="photo-pick">
            <span class="photo-pick__preview" aria-hidden="true">${photo ? `<img src="${esc(photo)}" alt="">` : icon('camera')}</span>
            <div class="photo-pick__actions">
              <input id="cs-photo" type="file" accept="image/*" class="sr-only">
              <label for="cs-photo" class="btn btn--neutral btn--sm">${icon('camera')}${photo ? 'Change photo' : 'Add photo'}</label>
              ${photo ? '<button type="button" class="link-btn link-btn--danger" data-action="remove-photo">Remove</button>' : ''}
            </div>
          </div>`;
        field.querySelector('#cs-photo').addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try { photo = await compressImage(file); renderPhoto(); } catch (err) { toast(err.message, 'error'); }
        });
        field.querySelector('[data-action=remove-photo]')?.addEventListener('click', () => { photo = null; renderPhoto(); });
      };
      renderPhoto();
    },
    async onSubmit(fd) {
      const data = {
        name: requireName(fd, 'name', 'Name'),
        brand: String(fd.get('brand') || '').trim(),
        weight: String(fd.get('weight') || '').trim(),
        price: requireNumber(fd, 'price', 'Price'),
        photo,
      };
      if (editing) await svc.updateCueStick(cueStick.id, data);
      else await svc.addCueStick(data);
      toast(editing ? `${data.name} updated` : `${data.name} added`);
    },
  });
}

/** Owner-only cue stick admin: mirrors Manage Tables — add a cue, or edit one's photo/details. */
export function manageCueSticksDialog() {
  let off = () => {};
  const { dlg } = openDialog({
    title: 'Manage cue sticks',
    wide: true,
    cancelLabel: 'Done',
    body: `
      <button type="button" class="btn btn--primary" data-action="add-cue">${icon('plus')}Add cue stick</button>
      <ul class="manage-list" data-region="cues" aria-label="Cue sticks"></ul>`,
    onClose: () => off(),
  });
  const list = dlg.querySelector('[data-region=cues]');
  const render = () => preserveFocus(list, () => {
    list.innerHTML = state.cueSticks.length ? state.cueSticks.map((c) => `
      <li class="manage-row">
        ${cueThumb(c)}
        <span class="manage-row__text">
          <span class="manage-row__name">${esc(c.name)}</span>
          <span class="manage-row__sub">${c.brand ? `${esc(c.brand)} · ` : ''}${peso(c.price)} · ${c.status === 'sold' ? 'Sold' : 'Available'}</span>
        </span>
        <button type="button" class="btn btn--neutral btn--sm" data-edit="${esc(c.id)}" data-fk="edit-${esc(c.id)}" aria-label="Edit ${esc(c.name)}">${icon('edit')}Edit</button>
      </li>`).join('') : '<li class="muted">No cue sticks yet.</li>';
  });
  off = on('cueSticks', render);
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-action=add-cue]')) cueStickDialog();
    const edit = e.target.closest('[data-edit]');
    const cue = edit && state.cueSticks.find((c) => c.id === edit.dataset.edit);
    if (cue) cueStickDialog(cue);
  });
  render();
}

/**
 * Move a table's running session — timer, items, rounds, booking length — to a different table. The
 * bill keeps counting from when it first started; only an available table can receive it. Opened from
 * the table-actions panel for a live (not yet ended) session.
 */
export function transferTableDialog(fromTable, currentUser) {
  let off = () => {};
  const { dlg, close } = openDialog({
    title: `Transfer ${esc(fromTable.name)}`,
    cancelLabel: 'Cancel',
    body: `
      <p class="muted small">Moves the running timer, items and rounds to another table. The bill keeps counting from when it first started — nothing resets.</p>
      <ul class="manage-list" data-region="tables" aria-label="Available tables"></ul>`,
    onClose: () => off(),
  });
  const list = dlg.querySelector('[data-region=tables]');
  const render = () => preserveFocus(list, () => {
    const available = state.tables.filter((t) => t.id !== fromTable.id && t.status === 'available');
    list.innerHTML = available.length ? available.map((t) => `
      <li class="manage-row">
        <span class="manage-row__text">
          <span class="manage-row__name">${esc(t.name)}</span>
          <span class="manage-row__sub">Available</span>
        </span>
        <button type="button" class="btn btn--primary btn--sm" data-to="${esc(t.id)}" data-fk="to-${esc(t.id)}">Move here</button>
      </li>`).join('') : '<li class="muted">No available tables right now.</li>';
  });
  off = on('tables', render);
  dlg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-to]');
    if (!btn) return;
    const to = state.tables.find((t) => t.id === btn.dataset.to);
    busy(btn, async () => {
      await svc.transferTable(fromTable.id, btn.dataset.to, currentUser);
      toast(`${fromTable.name} moved to ${to?.name ?? 'the new table'}`);
      close();
    });
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
          ${isSuperadmin(currentUser) ? `<option value="superadmin" ${member?.role === 'superadmin' ? 'selected' : ''}>Superadmin (hidden from owners)</option>` : ''}
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
  const { dlg } = openDialog({
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
          <p class="receipt__table">${tx.tableId ? esc(tx.tableName) : tx.saleType === 'cue-stick' ? 'Cue Stick Sale' : 'Walk-in sale'}</p>
          <p class="muted">${fmtDateTime(tx.createdAt)} · ${esc(tx.cashierName)}</p>
          ${tx.transfers?.length ? `<p class="muted small">Started at ${esc(tx.transfers[0].fromTableName)}, moved to ${esc(tx.tableName)}${tx.transfers.length > 1 ? ` (${tx.transfers.length} moves)` : ''} at ${fmtTime(tx.transfers[tx.transfers.length - 1].at)}.</p>` : ''}
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
      </div>
      <div class="receipt-print" data-region="receipt-print"></div>`,
  });

  // Thermal printing, same as Marimar Inn: print when a printer is connected, preview any time.
  const region = dlg.querySelector('[data-region=receipt-print]');
  const off = printer.subscribePrinter((s) => {
    if (!region.isConnected) { off(); return; }
    region.innerHTML = `
      ${s.kind ? `<button type="button" class="btn btn--primary btn--sm" data-rp="print">${icon('print')}Print receipt</button>` : ''}
      <button type="button" class="btn btn--neutral btn--sm" data-rp="preview">${icon('eye')}Preview print</button>
      ${s.kind ? '' : '<button type="button" class="link-btn" data-rp="setup">Connect a thermal printer</button>'}`;
  });
  region.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rp]');
    if (!b) return;
    if (b.dataset.rp === 'setup') printerDialog();
    if (b.dataset.rp === 'preview') thermalPreviewDialog({ title: 'Receipt preview', lines: printer.previewSaleReceipt(tx), onPrint: () => printer.printSaleReceipt(tx) });
    if (b.dataset.rp === 'print') {
      b.disabled = true;
      try { await printer.printSaleReceipt(tx); toast('Receipt sent to the printer.'); } catch (err) { toast(printer.printerErrorMessage(err), 'error'); } finally { b.disabled = false; }
    }
  });
}

/**
 * Start ticket for a table just opened: a courtesy slip (table, start time, mode, the rate) for the
 * customer to keep and hand back to the cashier when they're done. Not a bill — the actual charge is
 * only ever computed at checkout from the stored start/end stamps, printed there as the usual receipt.
 */
export function startTicketDialog(ticket) {
  const { dlg } = openDialog({
    title: 'Start ticket',
    cancelLabel: 'Close',
    body: `
      <div class="receipt">
        <div class="receipt__head">
          <p class="receipt__table">${esc(ticket.tableName)}</p>
          <p class="muted">Started ${fmtTime(ticket.startedAtMs)} · ${esc(ticket.cashierName)}</p>
        </div>
        <dl class="sum-lines">
          <div class="sum-row"><dt>${ticket.plannedMs ? 'Booked' : 'Mode'}</dt><dd>${ticket.plannedMs ? fmtBooking(ticket.plannedMs) : 'Open time'}</dd></div>
        </dl>
        <p class="muted small">Give this to the customer; the cashier bills the table when they're done, from the actual time played.</p>
      </div>
      <div class="receipt-print" data-region="ticket-print"></div>`,
  });

  const region = dlg.querySelector('[data-region=ticket-print]');
  const off = printer.subscribePrinter((s) => {
    if (!region.isConnected) { off(); return; }
    region.innerHTML = `
      ${s.kind ? `<button type="button" class="btn btn--primary btn--sm" data-rp="print">${icon('print')}Print ticket</button>` : ''}
      <button type="button" class="btn btn--neutral btn--sm" data-rp="preview">${icon('eye')}Preview print</button>
      ${s.kind ? '' : '<button type="button" class="link-btn" data-rp="setup">Connect a thermal printer</button>'}`;
  });
  region.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rp]');
    if (!b) return;
    if (b.dataset.rp === 'setup') printerDialog();
    if (b.dataset.rp === 'preview') thermalPreviewDialog({ title: 'Start ticket preview', lines: printer.previewStartTicket(ticket), onPrint: () => printer.printStartTicket(ticket) });
    if (b.dataset.rp === 'print') {
      b.disabled = true;
      try { await printer.printStartTicket(ticket); toast('Ticket sent to the printer.'); } catch (err) { toast(printer.printerErrorMessage(err), 'error'); } finally { b.disabled = false; }
    }
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
/* ---------- thermal printer ---------- */

/** On-screen look of a thermal print: the exact lines the printer receives, on a paper strip. */
export const paperStrip = (lines, paperWidth) => `
  <div class="paper" style="--paper-ch:${paperWidth}">
    <div class="paper__roll">${lines.map((l) => `<div class="paper__line paper__line--${l.align}">${esc(l.text) || '&nbsp;'}</div>`).join('')}</div>
  </div>`;

/** Preview of a thermal print, with a Print button when a printer is connected. */
export function thermalPreviewDialog({ title = 'Print preview', lines, onPrint }) {
  const connected = Boolean(printer.getPrinterState().kind);
  openDialog({
    title,
    cancelLabel: 'Close',
    submitLabel: 'Print',
    body: `
      <p class="muted small">This is how it will look on the thermal printer.${connected ? '' : ' Connect a printer (sidebar) to print it.'}</p>
      ${paperStrip(lines, printer.getPrinterState().paperWidth)}`,
    onSubmit: connected && onPrint ? async () => {
      await onPrint();
      toast('Sent to the printer.');
    } : undefined,
  });
}

/**
 * Thermal printer setup (Marimar Inn's printer panel): connect by Bluetooth, USB, or the RawBT app,
 * choose the paper width, preview and print a test page, disconnect or forget the saved printer.
 */
export function printerDialog() {
  let off = () => {};
  const { dlg } = openDialog({
    title: 'Thermal printer',
    cancelLabel: 'Close',
    body: '<div data-region="printer"></div>',
    onClose: () => off(),
  });
  const region = dlg.querySelector('[data-region=printer]');
  let picking = false; // tablet app: the paired-printer list opens after tapping Connect via Bluetooth

  const render = (s) => {
    const kindLabel = { bluetooth: 'Bluetooth', serial: 'USB', rawbt: 'via RawBT app', native: 'Tablet Bluetooth' }[s.kind] || '';
    const inApp = !s.kind && printer.isNativeApp();
    const paired = inApp && picking ? printer.listNativePrinters() : null;
    region.innerHTML = `
      <p class="printer-status">
        <span class="printer-dot ${s.kind ? 'is-on' : ''}" aria-hidden="true"></span>
        ${s.kind ? `<strong>Connected</strong> · ${esc(s.name)} · ${kindLabel}` : '<strong>Not connected</strong>'}
      </p>
      ${s.kind ? `
      <div class="printer-actions">
        <button type="button" class="btn btn--neutral" data-p="test">${icon('print')}Print test</button>
        <button type="button" class="btn btn--neutral" data-p="preview">${icon('eye')}Preview test</button>
        <button type="button" class="btn btn--neutral" data-p="disconnect">Disconnect</button>
      </div>` : inApp ? `
      <div class="printer-actions printer-actions--stack">
        <button type="button" class="btn btn--primary" data-p="native-connect">Connect via Bluetooth</button>
        ${paired ? `${paired.length ? paired.map((d) => `<button type="button" class="btn btn--neutral" data-p="native" data-id="${esc(d.id)}">${esc(d.name)}</button>`).join('')
          : '<p class="muted small">No paired printers yet. Pair the thermal printer in Android Settings → Bluetooth first, then tap Refresh.</p>'}
        <button type="button" class="btn btn--neutral" data-p="refresh">Refresh printer list</button>` : ''}
        <button type="button" class="btn btn--neutral" data-p="preview">${icon('eye')}Preview test</button>
      </div>
      <p class="muted small">Pair the printer once in Android Settings → Bluetooth, then tap Connect via Bluetooth and choose it. It connects over the tablet's own Bluetooth, so no extra app is needed.</p>` : `
      <div class="printer-actions printer-actions--stack">
        <button type="button" class="btn btn--neutral" data-p="bluetooth">Connect via Bluetooth</button>
        <button type="button" class="btn btn--neutral" data-p="serial">Connect via USB cable</button>
        <button type="button" class="btn btn--neutral" data-p="rawbt">Print via RawBT app (Android)</button>
        <button type="button" class="btn btn--neutral" data-p="preview">${icon('eye')}Preview test</button>
      </div>
      <p class="muted small">Most cheap 58mm printers use classic Bluetooth, which browsers can't reach directly. On an Android
        phone or tablet, install the free <strong>RawBT</strong> app, pair the printer in RawBT, then choose "Print via RawBT app".
        A USB printer works from Chrome or Edge on a computer.</p>`}
      <div class="field">
        <label for="paper-width">Paper width</label>
        <select id="paper-width" data-p="paper">
          <option value="32" ${s.paperWidth === 32 ? 'selected' : ''}>58mm (32 characters)</option>
          <option value="48" ${s.paperWidth === 48 ? 'selected' : ''}>80mm (48 characters)</option>
        </select>
      </div>
      <button type="button" class="link-btn" data-p="forget">Forget saved printer</button>`;
  };
  off = printer.subscribePrinter(render);

  region.addEventListener('change', (e) => { if (e.target.dataset.p === 'paper') printer.setPaperWidth(Number(e.target.value)); });
  region.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b || b.tagName === 'SELECT') return;
    const run = async (fn, ok) => {
      b.disabled = true;
      try { await fn(); if (ok) toast(ok); } catch (err) { if (err?.name !== 'NotFoundError') toast(printer.printerErrorMessage(err), 'error'); } finally { if (b.isConnected) b.disabled = false; }
    };
    switch (b.dataset.p) {
      case 'bluetooth': return run(printer.connectBluetooth, 'Thermal printer connected.');
      case 'serial': return run(printer.connectSerial, 'Thermal printer connected.');
      case 'rawbt': return run(async () => printer.connectRawBt(), 'Receipts will print through the RawBT app.');
      case 'native': {
        const device = printer.listNativePrinters().find((d) => d.id === b.dataset.id);
        return device && run(async () => printer.connectNative(device), `Connected to ${device.name}.`);
      }
      case 'native-connect': {
        const list = printer.listNativePrinters();
        if (list.length === 1) return run(async () => printer.connectNative(list[0]), `Connected to ${list[0].name}.`);
        picking = true;
        return render(printer.getPrinterState());
      }
      case 'refresh': return render(printer.getPrinterState());
      case 'test': return run(printer.printTestPage, 'Test sent to the printer.');
      case 'preview': return thermalPreviewDialog({ title: 'Printer test preview', lines: printer.previewTestPage(), onPrint: printer.printTestPage });
      case 'disconnect': printer.disconnectPrinter(); return toast('Printer disconnected.');
      case 'forget': return run(printer.forgetPrinter, 'Saved printer forgotten.');
      default: return undefined;
    }
  });
}
/* ---------- cash drawer (Marimar Inn) ---------- */

const isOwnerUser = () => isOwnerLevel(state.user);

/** Open the drawer: the owner directly, a cashier with the PIN the owner set. */
export function openDrawerDialog() {
  if (isOwnerUser()) {
    printer.openCashDrawer()
      .then(() => toast('Drawer opened.'))
      .catch((err) => toast(printer.printerErrorMessage(err), 'error'));
    return;
  }
  if (!state.settings.drawerPinSet) {
    toast('No drawer PIN yet. Ask the owner to set one (Cash drawer in the sidebar).', 'error');
    return;
  }
  openDialog({
    title: 'Open cash drawer',
    submitLabel: 'Open drawer',
    body: `
      <div class="field">
        <label for="drawer-pin">Drawer PIN</label>
        <input id="drawer-pin" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required autofocus>
      </div>
      <p class="muted small">Enter the PIN the owner gave you.</p>`,
    async onSubmit(fd) {
      if (!(await svc.verifyDrawerPin(fd.get('pin')))) throw new Error('That PIN doesn’t match. Ask the owner.');
      await printer.openCashDrawer();
      toast('Drawer opened.');
    },
  });
}

/**
 * Cash drawer panel: "On cash pay" switch (this device), Open drawer, and for the owner the drawer PIN.
 * The drawer is plugged into the thermal printer, so the printer has to be connected.
 */
export function cashDrawerDialog() {
  const offs = [];
  const { dlg } = openDialog({
    title: 'Cash drawer',
    cancelLabel: 'Close',
    body: '<div data-region="drawer"></div>',
    onClose: () => offs.forEach((off) => off()),
  });
  const region = dlg.querySelector('[data-region=drawer]');

  const render = () => {
    const connected = Boolean(printer.getPrinterState().kind);
    const onCash = printer.isDrawerEnabled();
    region.innerHTML = `
      ${connected ? '' : `
      <p class="drawer-warn">The drawer is plugged into the thermal printer. <button type="button" class="link-btn" data-d="printer">Connect the printer</button> first.</p>`}
      <div class="drawer-row">
        <div>
          <p class="drawer-row__title">On cash pay</p>
          <p class="muted small">${onCash
            ? 'The drawer opens when a customer pays cash (or the cash part of a split). GCash leaves it closed.'
            : 'The drawer stays closed during sales. Use Open drawer when you need it.'}</p>
        </div>
        <button type="button" class="btn ${onCash ? 'btn--primary' : 'btn--neutral'} btn--sm" data-d="toggle" aria-pressed="${onCash}">${onCash ? 'On' : 'Off'}</button>
      </div>
      <div class="drawer-row">
        <div>
          <p class="drawer-row__title">Open drawer</p>
          <p class="muted small">${isOwnerUser() ? 'Opens it now.' : state.settings.drawerPinSet ? 'Needs the PIN the owner set.' : 'No PIN set yet. Ask the owner.'}</p>
        </div>
        <button type="button" class="btn btn--neutral btn--sm" data-d="open" ${connected ? '' : 'disabled'}>Open drawer</button>
      </div>
      ${isOwnerUser() ? `
      <div class="drawer-pin">
        <div class="field">
          <label for="new-drawer-pin">${state.settings.drawerPinSet ? 'Change cashier PIN' : 'Set a PIN for cashiers'}</label>
          <input id="new-drawer-pin" type="text" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="e.g. 2026">
        </div>
        <button type="button" class="btn btn--neutral btn--sm" data-d="save-pin">Save PIN</button>
      </div>` : ''}`;
  };

  offs.push(printer.subscribePrinter(render), on('settings', render));
  region.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    if (b.dataset.d === 'printer') printerDialog();
    if (b.dataset.d === 'toggle') {
      printer.setDrawerEnabled(!printer.isDrawerEnabled());
      toast(printer.isDrawerEnabled() ? 'On cash pay: the drawer opens when a customer pays cash.' : 'On cash pay is off.');
    }
    if (b.dataset.d === 'open') openDrawerDialog();
    if (b.dataset.d === 'save-pin') {
      const input = region.querySelector('#new-drawer-pin');
      b.disabled = true;
      try {
        await svc.setDrawerPin(input.value);
        toast('Drawer PIN saved. Cashiers can use it now.');
      } catch (err) { toast(err.message, 'error'); } finally { if (b.isConnected) b.disabled = false; }
    }
  });
  region.addEventListener('input', (e) => { if (e.target.id === 'new-drawer-pin') e.target.value = svc.normalizePin(e.target.value).slice(0, 8); });
  // Enter in the PIN box would submit the dialog's own form (and close it), so save instead.
  region.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'new-drawer-pin') { e.preventDefault(); region.querySelector('[data-d=save-pin]')?.click(); }
  });
}

/**
 * The hall's GCash "Scan to Pay" QR code (owner-only): upload once, and it's shown automatically at
 * checkout whenever GCash or Split is chosen (gcashRefField() in js/ui.js), so the customer can scan
 * and pay right there instead of needing a separate printed code at the counter. It's the hall's own
 * merchant code — it carries no amount, so the customer still enters the total themselves, and the
 * cashier still records the last 5 digits of the reference number afterward.
 */
export function gcashQrDialog() {
  let qr = state.settings.gcashQr || null;
  let off = () => {};
  const { dlg } = openDialog({
    title: 'GCash QR code',
    cancelLabel: 'Close',
    body: '<div data-region="qr"></div>',
    onClose: () => off(),
  });
  const region = dlg.querySelector('[data-region=qr]');

  const render = () => {
    region.innerHTML = `
      <p class="muted small">Shown to the customer at checkout whenever GCash or Split is picked, so they can scan and
        pay. This is your hall's own "Scan to Pay" code from the GCash app — it doesn't carry an amount, so the
        customer still enters the total themselves.</p>
      <div class="photo-pick photo-pick--lg">
        <span class="photo-pick__preview" aria-hidden="true">${qr ? `<img src="${esc(qr)}" alt="">` : icon('qr')}</span>
        <div class="photo-pick__actions">
          <input id="gcash-qr-file" type="file" accept="image/*" class="sr-only">
          <label for="gcash-qr-file" class="btn btn--neutral btn--sm">${icon('camera')}${qr ? 'Change QR' : 'Upload QR'}</label>
          ${qr ? '<button type="button" class="link-btn link-btn--danger" data-action="remove-qr">Remove</button>' : ''}
        </div>
      </div>`;
    region.querySelector('#gcash-qr-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const compressed = await compressImage(file, 640, undefined, 'png');
        await svc.setGcashQr(compressed);
        toast('GCash QR saved.');
      } catch (err) { toast(err.message, 'error'); }
    });
    region.querySelector('[data-action=remove-qr]')?.addEventListener('click', async () => {
      await svc.removeGcashQr();
      toast('GCash QR removed.');
    });
  };

  off = on('settings', () => { qr = state.settings.gcashQr || null; render(); });
  render();
}