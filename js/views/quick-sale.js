// Quick Sale: a walk-in item-only sale, no table and no timer. The cart lives only in this view
// (not in Firestore) until the sale completes — services.completeQuickSale checks and deducts
// stock atomically at that point, the same way a table checkout does, so nothing can oversell.
import { state, on } from '../state.js';
import * as svc from '../services.js';
import { round2, itemsTotal, itemsCount } from '../billing.js';
import { receiptDialog } from '../dialogs.js';
import {
  esc, icon, peso, thumb, pageHeader, emptyBlock, busy, toast, openDialog, METHOD_LABEL, preserveFocus,
} from '../ui.js';

export function mount(el, ctx) {
  let cart = []; // { productId, name, category, price, qty }
  let method = 'cash';
  let completing = false;

  el.innerHTML = `
    ${pageHeader({
      title: 'Quick Sale — Walk-in',
      subtitle: 'No table required · items only',
      actions: `
        <span class="badge badge--in-use">Walk-in</span>
        <a class="btn btn--neutral" href="#/tables">${icon('arrowLeft')}Back to Tables</a>`,
    })}
    <div class="checkout">
      <div class="checkout__main">
        <section class="card order" aria-labelledby="order-title">
          <div class="card-head">
            <h2 class="card-title" id="order-title">Items</h2>
            <span class="card-sub" data-region="item-count"></span>
          </div>
          <div class="quick-actions">
            <button type="button" class="pill-action pill-action--item" data-action="add-product">${icon('plus')}Add Item</button>
          </div>
          <ul class="order-list" data-region="items" aria-label="Products on this sale"></ul>
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
          <button type="button" class="btn btn--amber btn--block btn--lg" data-action="complete">${icon('check')}Complete Sale</button>
        </section>
      </aside>
    </div>`;

  const $ = (sel) => el.querySelector(sel);

  function renderItems() {
    const list = $('[data-region=items]');
    preserveFocus(list, () => {
      list.innerHTML = cart.length
        ? cart.map((i) => {
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
        : `<li class="order-empty">Scan or search a product above to add it to this sale.</li>`;
    });
    $('[data-region=item-count]').textContent = `${itemsCount(cart)} item${itemsCount(cart) === 1 ? '' : 's'}`;
  }

  function renderLines() {
    $('[data-region=lines]').innerHTML = `
      <dl class="sum-lines">
        ${cart.map((i) => `
        <div class="sum-row">
          <dt>${i.qty} × ${esc(i.name)}</dt>
          <dd class="num">${peso(i.price * i.qty)}</dd>
        </div>`).join('')}
        ${cart.length ? `
        <div class="sum-row sum-row--muted">
          <dt>Products subtotal</dt>
          <dd class="num">${peso(itemsTotal(cart))}</dd>
        </div>` : ''}
      </dl>`;
  }

  function tick() {
    const total = itemsTotal(cart);
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
    renderItems();
    renderLines();
    tick();
  }

  function changeItem(productId, delta) {
    const idx = cart.findIndex((i) => i.productId === productId);
    const qty = (idx >= 0 ? cart[idx].qty : 0) + delta;
    if (qty <= 0) {
      if (idx >= 0) cart.splice(idx, 1);
    } else {
      const p = state.products.find((x) => x.id === productId);
      if (delta > 0 && p && qty > p.stock) {
        toast(p.stock > 0 ? `Only ${p.stock} ${p.name} in stock.` : `${p.name} is out of stock.`, 'error');
        return;
      }
      const line = { productId, name: p?.name ?? cart[idx].name, category: p?.category ?? cart[idx].category, price: p?.price ?? cart[idx].price, qty };
      if (idx >= 0) cart[idx] = line; else cart.push(line);
    }
    render();
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
      const onBill = new Map(cart.map((i) => [i.productId, i.qty]));
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
    offs = [on('products', renderList)];
    dlg.querySelector('#pp-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pid]');
      if (!b) return;
      const p = state.products.find((x) => x.id === b.dataset.pid);
      if (!p) return;
      changeItem(p.id, 1);
      renderList();
      toast(`Added ${p.name}`);
    });
    renderList();
  }

  async function complete(btn) {
    if (!cart.length) { toast('Add at least one item to the sale.', 'error'); return; }
    const raw = $('#cash-tendered').value;
    const tendered = method === 'cash' && raw !== '' ? Number(raw) : null;
    const splitRaw = $('#split-cash').value;
    if (method === 'split' && splitRaw === '') {
      toast('Enter the cash portion for a split payment.', 'error');
      $('#split-cash').focus();
      return;
    }
    const cashPart = method === 'split' ? Number(splitRaw) : null;
    completing = true;
    btn.disabled = true;
    try {
      const record = await svc.completeQuickSale({ items: cart, method, tendered, cashPart }, ctx.user);
      location.hash = '#/tables';
      receiptDialog(record, { fresh: true });
    } catch (err) {
      completing = false;
      btn.disabled = false;
      toast(err.message, 'error');
    }
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'inc': return changeItem(btn.dataset.pid, 1);
      case 'dec': return changeItem(btn.dataset.pid, -1);
      case 'add-product': return openProductPicker();
      case 'complete': return complete(btn);
      default: return undefined;
    }
  });

  el.querySelectorAll('input[name=pay-method]').forEach((r) => r.addEventListener('change', () => {
    method = r.value;
    $('[data-region=cash]').hidden = method !== 'cash';
    $('[data-region=split]').hidden = method !== 'split';
    tick();
  }));
  $('#cash-tendered').addEventListener('input', tick);
  $('#split-cash').addEventListener('input', tick);

  const offs = [on('products', render)];
  render();
  return () => offs.forEach((off) => off());
}
