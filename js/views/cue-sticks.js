// Cue Sticks: a separate little shop, not mixed into Quick Sale. A photo showcase of the cues
// currently in stock, a cart of the ones being sold right now (each cue is a unique physical item, so
// "adding" one just picks it once — no quantity), and the same payment flow as everywhere else.
import { state, on } from '../state.js';
import * as svc from '../services.js';
import { round2 } from '../billing.js';
import { receiptDialog, manageCueSticksDialog, cueThumb } from '../dialogs.js';
import * as printer from '../printer.js';
import {
  esc, icon, peso, pageHeader, emptyBlock, busy, toast, METHOD_LABEL, preserveFocus,
  gcashRefField, gcashQrBlock, wireGcashRef,
} from '../ui.js';
import { isOwnerLevel } from '../roles.js';

export function mount(el, ctx) {
  const owner = isOwnerLevel(ctx.user);
  let cart = []; // { cueStickId, name, brand, weight, price, photo }
  let method = 'cash';
  let completing = false;

  el.innerHTML = `
    ${pageHeader({
      title: 'Cue Sticks',
      subtitle: 'The shop’s cue stick catalog — sell one straight from here.',
      actions: `
        <a class="btn btn--neutral" href="#/showcase">${icon('cue')}Open Showcase</a>
        ${owner ? `<button type="button" class="btn btn--neutral" data-action="manage">${icon('edit')}Manage Cue Sticks</button>` : ''}`,
    })}
    <div class="checkout">
      <div class="checkout__main">
        <section class="card" aria-labelledby="showcase-title">
          <div class="card-head">
            <h2 class="card-title" id="showcase-title">In stock</h2>
            <span class="card-sub" data-region="showcase-count"></span>
          </div>
          <div class="cue-showcase" data-region="showcase"></div>
        </section>
        <section class="card order" aria-labelledby="cart-title">
          <div class="card-head">
            <h2 class="card-title" id="cart-title">Selling now</h2>
            <span class="card-sub" data-region="item-count"></span>
          </div>
          <ul class="order-list" data-region="items" aria-label="Cue sticks on this sale"></ul>
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
          <button type="button" class="btn btn--amber btn--block btn--lg" data-action="complete">${icon('check')}Complete Sale</button>
        </section>
      </aside>
    </div>`;

  const $ = (sel) => el.querySelector(sel);
  const inCart = (id) => cart.some((c) => c.cueStickId === id);
  const cartTotal = () => round2(cart.reduce((s, c) => s + c.price, 0));

  function renderShowcase() {
    const target = $('[data-region=showcase]');
    const available = state.cueSticks.filter((c) => c.status === 'available' && !inCart(c.id));
    target.innerHTML = available.length ? available.map((c) => `
      <button type="button" class="cue-card" data-add="${esc(c.id)}" data-fk="add-${esc(c.id)}">
        <span class="cue-card__photo" aria-hidden="true">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : icon('cue')}</span>
        <span class="cue-card__name">${esc(c.name)}</span>
        <span class="cue-card__meta">${[c.brand, c.weight].filter(Boolean).map(esc).join(' · ') || '—'}</span>
        <span class="cue-card__price num">${peso(c.price)}</span>
      </button>`).join('') : emptyBlock(
      state.cueSticks.length ? 'Every cue stick is either sold or already on this sale.' : 'No cue sticks yet.',
      owner ? 'Use Manage Cue Sticks to add the first one.' : 'Ask the owner to add cue sticks.',
    );
    $('[data-region=showcase-count]').textContent = `${available.length} available`;
  }

  function renderItems() {
    const list = $('[data-region=items]');
    preserveFocus(list, () => {
      list.innerHTML = cart.length ? cart.map((c) => `
        <li class="order-item">
          ${cueThumb(c)}
          <div class="order-item__info">
            <p class="order-item__name">${esc(c.name)}</p>
            <p class="order-item__price num">${[c.brand, c.weight].filter(Boolean).map(esc).join(' · ') || peso(c.price)}</p>
          </div>
          <button type="button" class="btn btn--neutral btn--sm" data-remove="${esc(c.cueStickId)}" aria-label="Remove ${esc(c.name)}">${icon('x')}Remove</button>
          <p class="order-item__total num">${peso(c.price)}</p>
        </li>`).join('') : '<li class="order-empty">Tap a cue stick above to add it to this sale.</li>';
    });
    $('[data-region=item-count]').textContent = `${cart.length} item${cart.length === 1 ? '' : 's'}`;
  }

  function renderLines() {
    $('[data-region=lines]').innerHTML = `
      <dl class="sum-lines">
        ${cart.map((c) => `
        <div class="sum-row">
          <dt>${esc(c.name)}</dt>
          <dd class="num">${peso(c.price)}</dd>
        </div>`).join('')}
      </dl>`;
  }

  function tick() {
    const total = cartTotal();
    const setText = (key, v) => { const n = $(`[data-live=${key}]`); if (n) n.textContent = v; };
    setText('total', peso(total));
    const raw = $('#cash-tendered').value;
    const tendered = Number(raw);
    setText('change', raw === '' || Number.isNaN(tendered) ? '—' : tendered >= total ? peso(tendered - total) : `Short ${peso(total - tendered)}`);
    $('[data-live=change]')?.classList.toggle('is-short', raw !== '' && tendered < total);

    const splitRaw = $('#split-cash').value;
    const cashPart = Number(splitRaw);
    const splitValid = splitRaw !== '' && cashPart > 0 && cashPart < total;
    setText('split-gcash', splitRaw === '' ? '—' : splitValid ? peso(total - cashPart) : `Cash must be under ${peso(total)}`);
    $('[data-live=split-gcash]')?.classList.toggle('is-short', splitRaw !== '' && !splitValid);
  }

  function render() {
    if (completing) return;
    renderShowcase();
    renderItems();
    renderLines();
    tick();
  }

  function addToCart(id) {
    const c = state.cueSticks.find((x) => x.id === id);
    if (!c || c.status !== 'available' || inCart(id)) return;
    cart.push({
      cueStickId: c.id, name: c.name, brand: c.brand, weight: c.weight, price: c.price, photo: c.photo,
    });
    render();
  }

  function removeFromCart(id) {
    cart = cart.filter((c) => c.cueStickId !== id);
    render();
  }

  async function complete(btn) {
    if (!cart.length) { toast('Add at least one cue stick to the sale.', 'error'); return; }
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
    if ((method === 'gcash' || method === 'split') && gcashRef.length !== 5) {
      toast('Enter the last 5 digits of the GCash reference number.', 'error');
      $('#gcash-ref').focus();
      return;
    }
    completing = true;
    btn.disabled = true;
    try {
      const items = cart.map((c) => ({
        cueStickId: c.cueStickId, name: c.name, brand: c.brand, price: c.price,
      }));
      const record = await svc.completeCueStickSale({ items, method, tendered, cashPart, gcashRef }, ctx.user);
      printer.kickDrawerForCash(record.payments?.cash).then((err) => err && toast(`Sold, but the drawer said: ${err}`, 'error'));
      cart = [];
      completing = false;
      method = 'cash';
      el.querySelector('input[name=pay-method][value=cash]').checked = true;
      $('[data-region=cash]').hidden = false;
      $('[data-region=split]').hidden = true;
      $('[data-region=gcash-ref]').hidden = true;
      $('#cash-tendered').value = '';
      $('#split-cash').value = '';
      const gcashInput = $('#gcash-ref');
      if (gcashInput) gcashInput.value = '';
      render();
      btn.disabled = false;
      receiptDialog(record, { fresh: true });
    } catch (err) {
      completing = false;
      btn.disabled = false;
      toast(err.message, 'error');
    }
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action=manage]')) { manageCueSticksDialog(); return; }
    const add = e.target.closest('[data-add]');
    if (add) { addToCart(add.dataset.add); return; }
    const remove = e.target.closest('[data-remove]');
    if (remove) { removeFromCart(remove.dataset.remove); return; }
    if (e.target.closest('[data-action=complete]')) complete(e.target.closest('button'));
  });

  el.querySelectorAll('input[name=pay-method]').forEach((r) => r.addEventListener('change', () => {
    method = r.value;
    $('[data-region=cash]').hidden = method !== 'cash';
    $('[data-region=split]').hidden = method !== 'split';
    $('[data-region=gcash-ref]').hidden = method === 'cash';
    tick();
  }));
  $('#cash-tendered').addEventListener('input', tick);
  $('#split-cash').addEventListener('input', tick);
  wireGcashRef(el);

  const offs = [
    on('cueSticks', render),
    // The GCash QR loads via its own settings listener, which can resolve after this screen already
    // built its static HTML — refresh just that region rather than relying on a one-time render.
    on('settings', () => { const q = $('[data-region=gcash-qr]'); if (q) q.innerHTML = gcashQrBlock(); }),
  ];
  render();
  return () => offs.forEach((off) => off());
}
