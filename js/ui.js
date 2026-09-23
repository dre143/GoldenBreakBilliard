import { ICONS } from './icons.js';
import { serverNow, HALL_TZ, HALL_OFFSET_MS } from './clock.js';
import { state } from './state.js';

export const icon = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- formatting ---------- */

const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
export const peso = (n) => pesoFmt.format(Number(n) || 0);
export function pesoCompact(n) {
  if (n >= 1000) return `₱${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `₱${Math.round(n)}`;
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
/** Short countdown, e.g. "4:58". */
export function fmtCountdown(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
export function fmtHuman(ms) {
  const m = Math.ceil(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
/** Booked length, e.g. "2h", "1h 30m", "45m". */
export function fmtBooking(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-PH', { timeZone: HALL_TZ, hour: 'numeric', minute: '2-digit' });
export const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-PH', { timeZone: HALL_TZ, month: 'short', day: 'numeric' });
export const fmtDateTime = (ts) => `${fmtDate(ts)}, ${fmtTime(ts)}`;
export const todayLabel = () =>
  new Date().toLocaleDateString('en-PH', { timeZone: HALL_TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

// Calendar days on the hall's clock (midnight in the Philippines), not the device's time zone. The hall has no
// daylight saving, so a day is always exactly 24 hours.
const DAY_MS = 24 * 60 * 60 * 1000;
export function startOfDay(ts = Date.now()) {
  return Math.floor((ts + HALL_OFFSET_MS) / DAY_MS) * DAY_MS - HALL_OFFSET_MS;
}
export function addDays(ts, n) {
  return ts + n * DAY_MS;
}

export function relTime(ts) {
  if (!ts) return 'never';
  const m = Math.round((serverNow() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export const isOnline = (u) => !!u.online && (u.demoPresence || serverNow() - (u.lastSeen || 0) < 3 * 60000);

// 'card' is kept only so older transactions still display a label; it's no longer offered.
export const METHOD_LABEL = { cash: 'Cash', gcash: 'GCash', split: 'Split', card: 'Card', none: 'No charge' };

/* ---------- small components ---------- */

/**
 * GCash payment: the hall's own "Scan to Pay" QR (if the owner has uploaded one, via the GCash QR tool
 * in the sidebar) so the customer can scan and pay right here, plus the reference input (last 5 digits)
 * for the audit trail — shown for GCash and Split payments on Checkout, Quick Sale and Cue Sticks.
 */
export const gcashRefField = () => `
  <div class="cash" data-region="gcash-ref" hidden>
    ${state.settings.gcashQr ? `
    <div class="gcash-qr">
      <img class="gcash-qr__img" src="${esc(state.settings.gcashQr)}" alt="GCash QR code">
      <p class="gcash-qr__hint">Have the customer scan this to pay, then enter the reference number below.</p>
    </div>` : ''}
    <div class="field">
      <label for="gcash-ref">GCash ref no. <span class="muted">(last 5 digits)</span></label>
      <input id="gcash-ref" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="e.g. 48213">
    </div>
  </div>`;

/** Keep only digits in the GCash reference input while typing. */
export function wireGcashRef(root) {
  const input = root.querySelector('#gcash-ref');
  input?.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 5); });
  return input;
}

const STATUS = {
  available: ['Available', 'available'],
  in_use: ['In Use', 'in-use'],
};
export const statusBadge = (status) => {
  const [label, cls] = STATUS[status] || [status, 'neutral'];
  return `<span class="badge badge--${cls}">${label}</span>`;
};

const CATEGORY_TONES = { Beverages: 'felt', Snacks: 'amber', Food: 'clay', Accessories: 'slate' };
export function thumb(name, category, size = '') {
  const tone = CATEGORY_TONES[category] || 'slate';
  return `<span class="thumb thumb--${tone} ${size}" aria-hidden="true">${esc(initials(name))}</span>`;
}

/** Icon-only Refresh / Thermal printer / Cash drawer buttons. Clicks are handled once, in app.js (data-tool). */
export const toolIcons = (cls = '', owner = false) => `
  <div class="tool-icons ${cls}" role="group" aria-label="Tools">
    <button type="button" class="tool-btn" data-tool="refresh" aria-label="Refresh" title="Refresh">${icon('refresh')}</button>
    <button type="button" class="tool-btn" data-tool="printer" aria-label="Thermal printer" title="Thermal printer">${icon('print')}<span class="tool-dot" aria-hidden="true"></span></button>
    <button type="button" class="tool-btn" data-tool="drawer" aria-label="Cash drawer" title="Cash drawer">${icon('box')}</button>
    ${owner ? `<button type="button" class="tool-btn" data-tool="gcash-qr" aria-label="GCash QR" title="GCash QR">${icon('qr')}</button>` : ''}
  </div>`;

export const pageHeader = ({ title, subtitle = '', actions = '' }) => `
  <header class="page-head">
    <div class="page-head__text">
      <h1 class="page-title">${title}</h1>
      <p class="page-sub">${subtitle}</p>
    </div>
    ${actions ? `<div class="page-head__actions">${actions}</div>` : ''}
  </header>`;

export const searchField = (id, label, placeholder = label) => `
  <div class="search">
    <label for="${id}" class="sr-only">${label}</label>
    ${icon('search')}
    <input id="${id}" type="search" placeholder="${placeholder}" autocomplete="off">
  </div>`;

export const loadingBlock = (label = 'Loading…') =>
  `<div class="empty" role="status"><span class="spinner" aria-hidden="true"></span><p>${label}</p></div>`;

export const emptyBlock = (title, text = '', action = '') =>
  `<div class="empty"><p class="empty__title">${title}</p>${text ? `<p>${text}</p>` : ''}${action}</div>`;

/** Re-render a region without losing keyboard focus on an element tagged data-fk. */
export function preserveFocus(container, render) {
  const active = document.activeElement;
  const key = container.contains(active) ? active.closest('[data-fk]')?.dataset.fk : null;
  render();
  if (key) container.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus();
}

/* ---------- feedback ---------- */

export function toast(message, type = 'info') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  host.append(el);
  setTimeout(() => el.classList.add('is-leaving'), type === 'error' ? 5200 : 3200);
  setTimeout(() => el.remove(), type === 'error' ? 5600 : 3600);
}

/** Run an async action from a button: disables it while pending, toasts errors. */
export async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong.', 'error');
    return undefined;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

/**
 * Accessible modal built on <dialog>. onSubmit(formData, dialog) may throw to show an inline error,
 * or return false to keep the dialog open.
 */
export function openDialog({ title, body, submitLabel = 'Save', submitClass = 'btn--primary', cancelLabel = 'Cancel', onSubmit, onOpen, onClose, wide = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal${wide ? ' modal--wide' : ''}`;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  dlg.setAttribute('aria-labelledby', titleId);
  dlg.innerHTML = `
    <form class="modal__form">
      <header class="modal__head">
        <h2 class="modal__title" id="${titleId}">${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </header>
      <div class="modal__body">${body}</div>
      <footer class="modal__foot">
        <p class="form-error" role="alert" hidden></p>
        <div class="modal__buttons">
          ${cancelLabel ? `<button type="button" class="btn btn--neutral" data-close>${cancelLabel}</button>` : ''}
          ${onSubmit ? `<button type="submit" class="btn ${submitClass}">${submitLabel}</button>` : ''}
        </div>
      </footer>
    </form>`;
  document.body.append(dlg);

  const form = dlg.querySelector('form');
  const errorEl = dlg.querySelector('.form-error');
  // Clean up synchronously: the native 'close' event can be deferred (e.g. in a background tab),
  // which would leave a dead dialog and its live subscriptions behind.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    dlg.remove();
    onClose?.();
  };
  const close = () => {
    if (dlg.open) dlg.close();
    finish();
  };

  dlg.addEventListener('close', finish); // Esc key
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    errorEl.hidden = true;
    try {
      if ((await onSubmit(new FormData(form), dlg)) !== false) close();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  });

  dlg.showModal();
  onOpen?.(dlg);
  return { dlg, close };
}
