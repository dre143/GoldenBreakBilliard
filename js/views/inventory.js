import { state, on } from '../state.js';
import { isLowStock } from '../billing.js';
import { productDialog, addStockDialog } from '../dialogs.js';
import { esc, icon, peso, thumb, pageHeader, searchField, loadingBlock, emptyBlock, preserveFocus } from '../ui.js';
import { isOwnerLevel } from '../roles.js';

export function mount(el, ctx) {
  const owner = isOwnerLevel(ctx.user);
  let query = '';
  let category = 'all';
  let categoryKey = '';

  el.innerHTML = `
    ${pageHeader({
      title: 'Inventory',
      subtitle: owner ? 'Products, stock levels and restocking' : 'Live stock levels · view only',
      actions: owner ? `<button type="button" class="btn btn--primary" data-action="add-product">${icon('plus')}Add Product</button>` : '',
    })}
    <section class="stats" data-region="stats" aria-label="Inventory summary"></section>
    <section class="card card--flush" aria-labelledby="inv-title">
      <div class="toolbar">
        <h2 class="card-title" id="inv-title">Products</h2>
        <div class="toolbar__controls">
          ${searchField('inv-search', 'Search products')}
          <div class="select">
            <label for="inv-cat" class="sr-only">Filter by category</label>
            <select id="inv-cat"><option value="all">All categories</option></select>
          </div>
        </div>
      </div>
      <div class="table-wrap" data-region="table"></div>
    </section>`;

  const stats = el.querySelector('[data-region=stats]');
  const wrap = el.querySelector('[data-region=table]');
  const select = el.querySelector('#inv-cat');

  function renderStats() {
    const products = state.products;
    const cats = new Set(products.map((p) => p.category));
    const low = products.filter(isLowStock).length;
    const units = products.reduce((n, p) => n + (p.stock || 0), 0);
    const restocked = state.restocks.reduce((n, r) => n + r.qty, 0);
    stats.innerHTML = `
      <article class="stat">
        <p class="stat__label">Total products</p>
        <p class="stat__value num">${products.length}</p>
        <p class="stat__sub">${units.toLocaleString()} units on hand</p>
      </article>
      <article class="stat">
        <p class="stat__label">Categories</p>
        <p class="stat__value num">${cats.size}</p>
        <p class="stat__sub">${esc([...cats].sort().slice(0, 3).join(', ')) || '—'}${cats.size > 3 ? '…' : ''}</p>
      </article>
      <article class="stat ${low ? 'stat--danger' : ''}">
        <p class="stat__label">Low stock</p>
        <p class="stat__value num">${low}</p>
        <p class="stat__sub">${low ? 'At or below reorder level' : 'Everything is stocked'}</p>
      </article>
      <article class="stat">
        <p class="stat__label">Restocked this week</p>
        <p class="stat__value num">${state.restocks.length}</p>
        <p class="stat__sub">${restocked.toLocaleString()} units received</p>
      </article>`;
  }

  function syncCategories() {
    const cats = [...new Set(state.products.map((p) => p.category))].sort();
    const key = cats.join('|');
    if (key === categoryKey) return;
    categoryKey = key;
    if (category !== 'all' && !cats.includes(category)) category = 'all';
    select.innerHTML = `<option value="all">All categories</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}`;
    select.value = category;
  }

  function renderTable() {
    if (!state.loaded.products) { wrap.innerHTML = loadingBlock('Loading products…'); return; }
    const rows = state.products.filter((p) =>
      (category === 'all' || p.category === category)
      && (!query || `${p.name} ${p.category}`.toLowerCase().includes(query)));
    if (!rows.length) {
      wrap.innerHTML = state.products.length
        ? emptyBlock('No products match these filters.')
        : emptyBlock('No products yet.', owner ? 'Add drinks, snacks and accessories to start selling.' : 'The owner hasn’t added products yet.');
      return;
    }
    preserveFocus(wrap, () => {
      wrap.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Category</th>
              <th scope="col" class="t-right">Stock</th>
              <th scope="col" class="t-right">Reorder level</th>
              <th scope="col">Status</th>
              ${owner ? '<th scope="col" class="t-right"><span class="sr-only">Actions</span></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map((p) => {
              const low = isLowStock(p);
              return `
              <tr>
                <td>
                  <div class="cell-product">
                    ${thumb(p.name, p.category, 'thumb--sm')}
                    <div>
                      <p class="cell-strong">${esc(p.name)}</p>
                      <p class="cell-sub num">${peso(p.price)}</p>
                    </div>
                  </div>
                </td>
                <td>${esc(p.category)}</td>
                <td class="t-right num cell-num ${low ? 'stock-low' : ''}">${p.stock}</td>
                <td class="t-right num cell-num">${p.reorderLevel}</td>
                <td>${p.stock <= 0
                  ? '<span class="badge badge--danger">Out of Stock</span>'
                  : low ? '<span class="badge badge--danger">Low Stock</span>' : '<span class="badge badge--available">In Stock</span>'}</td>
                ${owner ? `
                <td class="t-right">
                  <div class="row-actions">
                    <button type="button" class="btn btn--neutral btn--sm" data-action="add-stock" data-id="${esc(p.id)}" data-fk="stock-${esc(p.id)}" aria-label="Add stock to ${esc(p.name)}">${icon('plus')}Add Stock</button>
                    <button type="button" class="btn btn--neutral btn--sm" data-action="edit" data-id="${esc(p.id)}" data-fk="edit-${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${icon('edit')}Edit</button>
                  </div>
                </td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    });
  }

  el.querySelector('#inv-search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderTable(); });
  select.addEventListener('change', () => { category = select.value; renderTable(); });
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !owner) return;
    const product = state.products.find((p) => p.id === btn.dataset.id);
    if (btn.dataset.action === 'add-product') productDialog();
    if (btn.dataset.action === 'edit' && product) productDialog(product);
    if (btn.dataset.action === 'add-stock' && product) addStockDialog(product, ctx.user);
  });

  const offs = [
    on('products', () => { renderStats(); syncCategories(); renderTable(); }),
    on('restocks', renderStats),
  ];
  renderStats();
  syncCategories();
  renderTable();
  return () => offs.forEach((off) => off());
}
