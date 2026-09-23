// Showcase: a fullscreen, TV-friendly slideshow — table status, then the cue stick catalog — meant for
// a screen behind the counter or near the tables, not a screen staff use day to day. It reads the same
// live tables/cueSticks data as everything else, so a table freeing up or a cue selling out updates the
// loop on its own; nothing here is ever re-exported or re-uploaded by hand.
//
// Reached two ways: a link on the Cue Sticks page (for a staff account glancing at it), or as the forced
// landing screen for a "display" account (see js/roles.js, js/app.js) — a role meant for an unattended
// device (an old laptop, an Android TV box, a Fire Stick's browser) signed in once and left fullscreen,
// with firestore.rules locking what it can read to just tables and cue sticks.
import { state, on } from '../state.js';
import * as svc from '../services.js';
import { auth } from '../db.js';
import { esc, peso, icon } from '../ui.js';
import { isDisplay } from '../roles.js';

const SLIDE_MS = 7000;

function tablesSlide() {
  const tables = [...state.tables].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return `
    <div class="showcase__tables">
      <p class="showcase__eyebrow">Golden Break Billiard Hall</p>
      <h1 class="showcase__tables-title">Table Status</h1>
      ${tables.length ? `
      <div class="showcase__table-grid">
        ${tables.map((t) => {
          const occupied = t.status === 'in_use';
          return `
          <div class="showcase__table-card ${occupied ? 'is-occupied' : 'is-open'}">
            <span class="showcase__table-dot" aria-hidden="true"></span>
            <span class="showcase__table-name">${esc(t.name)}</span>
            <span class="showcase__table-status">${occupied ? 'In Use' : 'Available'}</span>
          </div>`;
        }).join('')}
      </div>` : '<p class="showcase__meta">No tables yet.</p>'}
    </div>`;
}

function cueSlide(c) {
  return `
    <div class="showcase__card">
      <div class="showcase__photo">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : icon('cue')}</div>
      <div class="showcase__info">
        <p class="showcase__eyebrow">Golden Break Pro Shop</p>
        <h1 class="showcase__name">${esc(c.name)}</h1>
        <p class="showcase__meta">${[c.brand, c.weight].filter(Boolean).map(esc).join(' · ') || ' '}</p>
        <p class="showcase__price">${peso(c.price)}</p>
      </div>
    </div>`;
}

export function mount(el) {
  const shell = document.querySelector('.shell');
  shell?.classList.add('showcase-mode');
  const display = isDisplay(state.user);

  el.innerHTML = `
    <div class="showcase">
      ${display
        ? `<button type="button" class="showcase__back" data-action="sign-out">${icon('logout')}Sign out</button>`
        : `<a class="showcase__back" href="#/cue-sticks">${icon('arrowLeft')}Back to app</a>`}
      <div class="showcase__stage" data-region="stage"></div>
      <div class="showcase__dots" data-region="dots"></div>
    </div>`;

  const stage = el.querySelector('[data-region=stage]');
  const dots = el.querySelector('[data-region=dots]');
  let index = 0;
  let timer = null;

  const slides = () => [{ type: 'tables' }, ...state.cueSticks.filter((c) => c.status === 'available').map((cue) => ({ type: 'cue', cue }))];

  function render() {
    const list = slides();
    if (index >= list.length) index = 0;
    const slide = list[index];
    stage.innerHTML = slide.type === 'tables' ? tablesSlide() : cueSlide(slide.cue);
    dots.innerHTML = list.length > 1 ? list.map((_, i) => `<span class="showcase__dot${i === index ? ' is-active' : ''}"></span>`).join('') : '';
  }

  function advance() {
    const list = slides();
    if (list.length < 2) return;
    index = (index + 1) % list.length;
    render();
  }

  function restart() {
    clearInterval(timer);
    timer = setInterval(advance, SLIDE_MS);
  }

  async function signOut(btn) {
    btn.disabled = true;
    try {
      if (state.user) await svc.setPresence(state.user.uid, false).catch(() => {});
      await auth.signOut();
    } catch {
      btn.disabled = false;
    }
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action=sign-out]');
    if (btn) signOut(btn);
  });

  const offs = [
    on('cueSticks', () => { if (index >= slides().length) index = 0; render(); }),
    on('tables', render),
  ];
  render();
  restart();

  return () => {
    clearInterval(timer);
    offs.forEach((off) => off());
    shell?.classList.remove('showcase-mode');
  };
}
