import { state, on } from '../state.js';
import * as svc from '../services.js';
import {
  elapsedMs, tableFee, sessionFee, itemsTotal, itemsCount, round2, feeBreakdown, nextIncreaseAt, PRICING, PRICING_LABEL,
  billableMs, isTimed, plannedMs, remainingMs, overtimeMs, canCancelGame, cancelTimeLeft,
} from '../billing.js';
import { receiptDialog, bookingDialog, cancelGameDialog } from '../dialogs.js';
import * as printer from '../printer.js';
import { updateTableTimers } from './shared.js';
import { poolCard } from './pool-card.js';
import {
  esc, icon, peso, fmtDuration, fmtCountdown, fmtTime, fmtBooking, statusBadge, thumb, pageHeader,
  loadingBlock, emptyBlock, preserveFocus, busy, toast, openDialog, METHOD_LABEL, gcashRefField, wireGcashRef,
} from '../ui.js';

export function mount(el, ctx) {
  return ctx.params[0] ? mountBill(el, ctx, ctx.params[0]) : mountPicker(el);
}

/* ---------- table picker (Checkout without a table) ---------- */

function mountPicker(el) {
  el.innerHTML = `
    ${pageHeader({ title: 'Checkout', subtitle: 'Choose an active table to bill' })}
    <section class="pool-grid" data-region="grid" aria-label="Tables with open sessions"></section>`;
  const grid = el.querySelector('[data-region=grid]');

  const render = () => {
    if (!state.loaded.tables) { grid.innerHTML = loadingBlock('Loading tables…'); return; }
    const active = state.tables.filter((t) => t.session);
    grid.innerHTML = active.length
      ? active.map(poolCard).join('')
      : emptyBlock('No open sessions.', 'Start a session from Tables, then bill it here.', '<a class="btn btn--primary" href="#/tables">Go to Tables</a>');
  };

  const offs = [on('tables', render), on('tick', () => updateTableTimers(grid))];
  render();
  return () => offs.forEach((off) => off());
}

/* ---------- bill for one table ---------- */

function mountBill(el, ctx, tableId) {
  let method = 'cash';
  let completing = false;
  let built = false;
  let cancelShown = false; // whether the Cancel game offer is on screen (it goes away after 5 minutes)
  const table = () => state.tables.find((t) => t.id === tableId);

  el.innerHTML = `
    <header class="page-head">
      <div class="page-head__text">
        <h1 class="page-title" data-region="title">Checkout</h1>
        <p class="page-sub" data-region="sub">&nbsp;</p>
      </div>
      <div class="page-head__actions">
        <a class="btn btn--neutral" href="#/tables">${icon('arrowLeft')}Back to Tables</a>
      </div>
    </header>
    <div data-region="body"></div>`;

  const $ = (sel) => el.querySelector(sel);
  const body = $('[data-region=body]');

  function build() {
    body.innerHTML = `
      <div class="checkout">
        <div class="checkout__main">
          <section class="timer-panel" data-region="timer" aria-label="Session time"></section>
          <section class="card session-tools" aria-labelledby="tools-title">
            <h2 class="sr-only" id="tools-title">Session actions</h2>
            <div class="session-tools__row" data-region="tools"></div>
          </section>
          <section class="card order" aria-labelledby="order-title">
            <div class="card-head">
              <h2 class="card-title" id="order-title">Order items</h2>
              <span class="card-sub" data-region="item-count"></span>
            </div>
            <ul class="order-list" data-region="items" aria-label="Products on this bill"></ul>
          </section>
        </div>
        <aside class="checkout__side">
          <section class="card summary" aria-labelledby="sum-title">
            <h2 class="card-title" id="sum-title">Bill summary</h2>
            <div data-region="lines"></div>
            <hr class="divider">
            <div class="summary-total">
              <span class="summary-total__label">Total</span>
              <span class="num summary-total__value" data-live="total" aria-live="off"></span>
            </div>
            <div class="pay">
              <p class="pay__label" id="pay-label">Payment method</p>
              <div class="seg" role="radiogroup" aria-labelledby="pay-label">
                ${svc.PAYMENT_METHODS.map((m) => `
                  <label class="seg__opt">
                    <input type="radio" name="pay-method" value="${m}" ${m === method ? 'checked' : ''}>
                    <span>${METHOD_LABEL[m]}</span>
                  </label>`).join('')}
              </div>
            </div>
            <div class="cash" data-region="cash">
              <div class="field">
                <label for="cash-tendered">Cash tendered</label>
                <input id="cash-tendered" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Exact amount">
              </div>
              <div class="cash__change">
                <span>Change</span>
                <span class="num" data-live="change">—</span>
              </div>
            </div>
            <div class="cash" data-region="split" hidden>
              <div class="field">
                <label for="split-cash">Cash portion</label>
                <input id="split-cash" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount paid in cash">
              </div>
              <div class="cash__change">
                <span>GCash portion (balance)</span>
                <span class="num" data-live="split-gcash">—</span>
              </div>
            </div>
            ${gcashRefField()}
            <button type="button" class="btn btn--amber btn--block btn--lg" data-action="complete">${icon('check')}Complete Transaction</button>
          </section>
        </aside>
      </div>`;
    built = true;

    body.querySelectorAll('input[name=pay-method]').forEach((r) => r.addEventListener('change', () => {
      method = r.value;
      $('[data-region=cash]').hidden = method !== 'cash';
      $('[data-region=split]').hidden = method !== 'split';
      $('[data-region=gcash-ref]').hidden = method === 'cash';
      tick();
    }));
    $('#cash-tendered').addEventListener('input', tick);
    $('#split-cash').addEventListener('input', tick);
    wireGcashRef(body);
  }

  function renderTimer(t) {
    const s = t.session;
    const cancellable = canCancelGame(t);
    cancelShown = cancellable;
    preserveFocus($('[data-region=timer]'), () => {
      $('[data-region=timer]').classList.toggle('is-stopped', Boolean(s.ended));
      $('[data-region=timer]').innerHTML = `
        <div class="timer-panel__top">
          <span class="eyebrow">Elapsed time · ${esc(t.name)}</span>
          ${s.cancelled ? '<span class="badge badge--danger">Game cancelled</span>' : s.ended ? '<span class="badge badge--ended">Session Ended</span>' : statusBadge(t.status)}
        </div>
        ${s.cancelled ? `
        <p class="cancel-note">Cancelled by ${esc(s.cancelled.byName)} (${esc(s.cancelled.reason)}). No table fee. Take payment for the items below.</p>` : ''}
        ${cancellable ? `
        <div class="cancel-offer">
          <button type="button" class="btn btn--danger-ghost" data-action="cancel-game" data-fk="cancel-game">${icon('x')}Cancel game</button>
          <span class="cancel-offer__text">No charge if cancelled in the first 5 minutes · <strong class="num" data-live="cancel-left"></strong> left</span>
        </div>` : ''}
        <div class="led led--lg">
          <span class="led__digits num" data-live="elapsed">${fmtDuration(elapsedMs(t))}</span>
        </div>
        <p class="timer-panel__meta">${isTimed(s) ? `<strong>Booked ${fmtBooking(plannedMs(s))}</strong>` : '<strong>Open time</strong>'} · Started ${fmtTime(s.startedAt)}${s.ended && s.endedAt ? ` · ended ${fmtTime(s.endedAt)}` : isTimed(s) ? ` · ends ${fmtTime(s.startedAt + plannedMs(s))}` : ''} · ${PRICING_LABEL}</p>
        ${isTimed(s) ? '<p class="timer-panel__booking" data-live="booking" aria-live="off"></p>' : ''}
        ${s.ended ? '' : '<p class="timer-panel__next" data-live="next" aria-live="off"></p>'}
        ${s.ended ? '' : `
        <div class="timer-panel__controls">
          <button type="button" class="btn btn--light" data-action="extend" data-fk="extend">${icon('clock')}${isTimed(s) ? 'Add time' : 'Set hours'}</button>
          <button type="button" class="btn btn--end" data-action="end" data-fk="end">${icon('stop')}End Session</button>
          <span class="timer-panel__hint">Ending stops the clock for billing. This can’t be undone.</span>
        </div>`}`;
    });
  }

  function renderTools(t) {
    const rounds = t.session.rounds || 0;
    const lightOn = Boolean(t.light);
    const region = $('[data-region=tools]');
    preserveFocus(region, () => {
      region.innerHTML = `
        <div class="quick-actions">
          <div class="round-group">
            <button type="button" class="pill-action pill-action--round" data-action="round" data-fk="round">
              ${icon('rack')}Log Round<span class="pill-action__count num">${rounds}</span>
            </button>
            <button type="button" class="icon-btn icon-btn--outline" data-action="round-undo" data-fk="round-undo" aria-label="Remove last round" ${rounds ? '' : 'disabled'}>${icon('minus')}</button>
          </div>
          <button type="button" class="pill-action pill-action--item" data-action="add-product" data-fk="add-item">${icon('plus')}Add Item</button>
        </div>
        <button type="button" class="light-switch" role="switch" aria-checked="${lightOn}" aria-labelledby="light-label" data-action="light" data-fk="light">
          <span class="light-switch__track" aria-hidden="true"><span class="light-switch__thumb"></span></span>
          <span class="light-switch__text">
            <span class="light-switch__label" id="light-label">Table light</span>
            <span class="light-switch__state" aria-hidden="true">${lightOn ? 'Light On' : 'Light Off'}</span>
          </span>
        </button>`;
    });
  }

  function renderItems(t) {
    const items = t.session.items || [];
    const list = $('[data-region=items]');
    preserveFocus(list, () => {
      list.innerHTML = items.length
        ? items.map((i) => {
          const product = state.products.find((p) => p.id === i.productId);
          const atMax = product ? i.qty >= product.stock : true;
          return `
          <li class="order-item">
            ${thumb(i.name, i.category)}
            <div class="order-item__info">
              <p class="order-item__name">${esc(i.name)}</p>
              <p class="order-item__price num">${peso(i.price)} each</p>
            </div>
            <div class="stepper" role="group" aria-label="Quantity of ${esc(i.name)}">
              <button type="button" class="stepper__btn" data-action="dec" data-pid="${esc(i.productId)}" data-fk="dec-${esc(i.productId)}" aria-label="${i.qty === 1 ? 'Remove' : 'Decrease'} ${esc(i.name)}">${icon('minus')}</button>
              <span class="stepper__val num">${i.qty}</span>
              <button type="button" class="stepper__btn" data-action="inc" data-pid="${esc(i.productId)}" data-fk="inc-${esc(i.productId)}" aria-label="Increase ${esc(i.name)}" ${atMax ? 'disabled' : ''}>${icon('plus')}</button>
            </div>
            <p class="order-item__total num">${peso(i.price * i.qty)}</p>
          </li>`;
        }).join('')
        : `<li class="order-empty">No products on this bill yet. Use Add Item for drinks, snacks or accessories.</li>`;
    });
  }

  function renderLines(t) {
    const items = t.session.items || [];
    $('[data-region=lines]').innerHTML = `
      <dl class="sum-lines">
        <div class="sum-row">
          <dt>Table fee<span class="sum-sub"><span data-live="dur"></span> · <span data-live="breakdown"></span></span></dt>
          <dd class="num" data-live="fee"></dd>
        </div>
        ${t.session.rounds ? `
        <div class="sum-row sum-row--muted">
          <dt>Rounds played</dt>
          <dd class="num">${t.session.rounds}</dd>
        </div>` : ''}
        ${items.map((i) => `
        <div class="sum-row">
          <dt>${i.qty} × ${esc(i.name)}</dt>
          <dd class="num">${peso(i.price * i.qty)}</dd>
        </div>`).join('')}
        ${items.length ? `
        <div class="sum-row sum-row--muted">
          <dt>Products subtotal</dt>
          <dd class="num">${peso(itemsTotal(items))}</dd>
        </div>` : ''}
      </dl>`;
  }

  function tick() {
    const t = table();
    if (!built || !t?.session) return;
    const s = t.session;
    const ms = elapsedMs(t);
    if (canCancelGame(t) !== cancelShown) renderTimer(t); // the 5-minute cancel window just closed
    const billed = billableMs(s, ms); // booked hours are the minimum charge
    const fee = sessionFee(s, ms); // ₱0 once the game was cancelled
    const total = round2(fee + itemsTotal(s.items));
    const setText = (key, v) => { const n = $(`[data-live=${key}]`); if (n) n.textContent = v; };
    setText('elapsed', fmtDuration(ms));
    setText('cancel-left', fmtCountdown(cancelTimeLeft(t)));
    setText('dur', isTimed(s) && billed > ms ? `${fmtDuration(ms)} played, ${fmtBooking(plannedMs(s))} booked` : `${fmtDuration(ms)} played`);
    setText('breakdown', s.cancelled ? 'game cancelled, no charge' : feeBreakdown(billed));
    setText('fee', peso(fee));
    if (isTimed(s)) {
      const over = overtimeMs(s, ms);
      setText('booking', over > 0 ? `Overtime +${fmtDuration(over)}, billed at ₱${PRICING.bracketPrice} per started ${PRICING.bracketMinutes} min` : `Time left ${fmtDuration(remainingMs(s, ms))}`);
      $('[data-live=booking]')?.classList.toggle('is-over', over > 0);
    }
    // Tell staff when the fee next goes up (within a booking it can't go up until the booking runs out).
    const nextAt = Math.max(nextIncreaseAt(billed), plannedMs(s));
    setText('next', `Goes up to ${peso(tableFee(nextAt + 1))} after ${fmtDuration(nextAt)} · in ${fmtDuration(Math.max(0, nextAt - ms))}`);
    setText('total', peso(total));
    const raw = $('#cash-tendered').value;
    const tendered = Number(raw);
    setText('change', raw === '' || Number.isNaN(tendered) ? '—' : tendered >= total ? peso(tendered - total) : `Short ${peso(total - tendered)}`);
    $('[data-live=change]')?.classList.toggle('is-short', raw !== '' && tendered < total);

    // Split: GCash covers whatever the cash portion doesn't (recomputed live as the table fee grows).
    const splitRaw = $('#split-cash').value;
    const cashPart = Number(splitRaw);
    const splitValid = splitRaw !== '' && cashPart > 0 && cashPart < total;
    setText('split-gcash', splitRaw === '' ? '—' : splitValid ? peso(total - cashPart) : `Cash must be under ${peso(total)}`);
    $('[data-live=split-gcash]')?.classList.toggle('is-short', splitRaw !== '' && !splitValid);
  }

  function render() {
    if (completing) return;
    const title = $('[data-region=title]');
    const sub = $('[data-region=sub]');
    if (!state.loaded.tables) { body.innerHTML = loadingBlock('Loading bill…'); built = false; return; }
    const t = table();
    if (!t?.session) {
      built = false;
      title.textContent = 'Checkout';
      sub.textContent = t ? `${t.name} has no open session` : 'Table not found';
      body.innerHTML = `<div class="card">${emptyBlock('Nothing to bill here.', 'This table may have just been checked out on another terminal.', '<a class="btn btn--primary" href="#/checkout">Choose another table</a>')}</div>`;
      return;
    }
    if (!built) build();
    title.textContent = `Checkout · ${t.name}`;
    sub.textContent = `Opened by ${t.session.openedByName || 'staff'} at ${fmtTime(t.session.startedAt)}`;
    renderTimer(t);
    renderTools(t);
    renderItems(t);
    const n = itemsCount(t.session.items);
    $('[data-region=item-count]').textContent = `${n} item${n === 1 ? '' : 's'}`;
    renderLines(t);
    tick();
  }

  function openProductPicker() {
    let query = '';
    let offs = [];
    const { dlg } = openDialog({
      title: 'Add product',
      wide: true,
      cancelLabel: 'Done',
      body: `
        <div class="field">
          <label for="pp-search">Search products</label>
          <input id="pp-search" type="search" autocomplete="off" placeholder="Beer, fries, chalk…">
        </div>
        <ul class="pick-list" data-region="pp-list" aria-label="Products"></ul>`,
      onClose: () => offs.forEach((off) => off()),
    });
    const list = dlg.querySelector('[data-region=pp-list]');
    const renderList = () => {
      const onBill = new Map((table()?.session?.items || []).map((i) => [i.productId, i.qty]));
      const rows = state.products.filter((p) => !query || `${p.name} ${p.category}`.toLowerCase().includes(query));
      preserveFocus(list, () => {
        list.innerHTML = rows.length ? rows.map((p) => {
          const inCart = onBill.get(p.id) || 0;
          const left = p.stock - inCart;
          return `
          <li>
            <button type="button" class="pick-product" data-pid="${esc(p.id)}" data-fk="pp-${esc(p.id)}" ${left <= 0 ? 'disabled' : ''}>
              ${thumb(p.name, p.category)}
              <span class="pick-product__text">
                <span class="pick-product__name">${esc(p.name)}</span>
                <span class="pick-product__meta">${esc(p.category)} · ${p.stock <= 0 ? 'Out of stock' : `${p.stock} in stock`}${inCart ? ` · ${inCart} on bill` : ''}</span>
              </span>
              <span class="pick-product__price num">${peso(p.price)}</span>
            </button>
          </li>`;
        }).join('') : `<li>${emptyBlock('No products found.')}</li>`;
      });
    };
    offs = [on('products', renderList), on('tables', renderList)];
    dlg.querySelector('#pp-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pid]');
      if (!b) return;
      const p = state.products.find((x) => x.id === b.dataset.pid);
      busy(b, async () => { await svc.changeItem(tableId, b.dataset.pid, 1); toast(`Added ${p?.name ?? 'product'}`); });
    });
    renderList();
  }

  async function complete(btn) {
    const t = table();
    if (!t?.session) return;
    const raw = $('#cash-tendered').value;
    const tendered = method === 'cash' && raw !== '' ? Number(raw) : null;
    const splitRaw = $('#split-cash').value;
    if (method === 'split' && splitRaw === '') {
      toast('Enter the cash portion for a split payment.', 'error');
      $('#split-cash').focus();
      return;
    }
    const cashPart = method === 'split' ? Number(splitRaw) : null;
    const gcashRef = $('#gcash-ref').value;
    const total = round2(sessionFee(t.session, elapsedMs(t)) + itemsTotal(t.session.items));
    if ((method === 'gcash' || method === 'split') && total > 0 && gcashRef.length !== 5) {
      toast('Enter the last 5 digits of the GCash reference number.', 'error');
      $('#gcash-ref').focus();
      return;
    }
    // The total on screen is an estimate while the clock runs; the server-stamped end time decides.
    const expectedTotal = round2(sessionFee(t.session, elapsedMs(t)) + itemsTotal(t.session.items));
    completing = true;
    btn.disabled = true;
    try {
      const record = await svc.completeCheckout(tableId, { method, tendered, cashPart, gcashRef, expectedTotal }, ctx.user);
      // Cash changed hands: open the drawer (if the printer is connected and "On cash pay" is on).
      printer.kickDrawerForCash(record.payments?.cash).then((err) => err && toast(`Paid, but the drawer said: ${err}`, 'error'));
      location.hash = '#/tables';
      receiptDialog(record, { fresh: true });
    } catch (err) {
      completing = false;
      btn.disabled = false;
      render();
      if (err instanceof svc.TotalChangedError) {
        toast(`Clock stopped at ${fmtDuration(err.durationMs)}. Final total is ${peso(err.total)}. Confirm the payment and press Complete again.`, 'error');
        $('#cash-tendered')?.dispatchEvent(new Event('input'));
      } else {
        toast(err.message, 'error');
      }
    }
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'extend': {
        const t = table();
        if (!t?.session) return undefined;
        const booked = plannedMs(t.session);
        const played = elapsedMs(t);
        return bookingDialog({
          title: booked ? `Add time · ${esc(t.name)}` : `Set hours · ${esc(t.name)}`,
          submitLabel: booked ? 'Add time' : 'Set hours',
          // An open-time table switched to a booking counts the time already played.
          baseMs: booked,
          elapsedNow: played,
          onPick: async (ms) => {
            const total = await svc.extendSession(tableId, ms);
            toast(`${t.name}: booked ${fmtBooking(total)}`);
          },
        });
      }
      case 'end': return busy(btn, async () => { await svc.endSession(tableId); toast('Session ended · clock stopped'); });
      case 'cancel-game': {
        const t = table();
        if (!t?.session) return undefined;
        return cancelGameDialog(t, {
          onDone: ({ hasItems }) => { if (!hasItems) location.hash = '#/tables'; },
        });
      }
      case 'inc': return busy(btn, () => svc.changeItem(tableId, btn.dataset.pid, 1));
      case 'dec': return busy(btn, () => svc.changeItem(tableId, btn.dataset.pid, -1));
      case 'add-product': return openProductPicker();
      case 'round': return busy(btn, () => svc.logRound(tableId, 1));
      case 'round-undo': return busy(btn, () => svc.logRound(tableId, -1));
      case 'light': {
        const turnOn = btn.getAttribute('aria-checked') !== 'true';
        return busy(btn, async () => { await svc.setLight(tableId, turnOn); toast(`${table()?.name ?? 'Table'} light ${turnOn ? 'on' : 'off'}`); });
      }
      case 'complete': return complete(btn);
      default: return undefined;
    }
  });

  const offs = [on('tables', render), on('products', () => { const t = table(); if (built && t?.session) renderItems(t); }), on('tick', tick)];
  render();
  return () => offs.forEach((off) => off());
}
