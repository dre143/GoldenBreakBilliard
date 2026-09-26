// Showcase: a fullscreen, TV-friendly digital-signage loop meant for a 16:9 screen behind the counter
// or near the tables — not a screen staff use day to day. It reads the same live tables/cueSticks data
// as everything else, so a table freeing up or a cue selling out updates the loop on its own; nothing
// here is ever re-exported or re-uploaded by hand.
//
// Reached two ways: a link on the Cue Sticks page (for a staff account glancing at it), or as the forced
// landing screen for a "display" account (see js/roles.js, js/app.js) — a role meant for an unattended
// device (an old laptop, an Android TV box, a Fire Stick's browser) signed in once and left fullscreen,
// with firestore.rules locking what it can read to just tables, cue sticks, and the owner's Showcase
// content (settings/showcase — see js/dialogs.js showcaseSettingsDialog).
//
// Four slide types rotate: Live Table Status (always the real, live data — never edited here), Champion
// Spotlight, Featured Cue/Product and a Promo/Announcement slide. The owner turns the last three on/off
// and edits their content from Cue Sticks → "Customize Showcase"; Featured falls back to the newest
// available cue stick when the owner hasn't set one, so the slot is never empty.
import { state, on } from '../state.js';
import * as svc from '../services.js';
import { auth } from '../db.js';
import { esc, peso, icon } from '../ui.js';
import { isDisplay } from '../roles.js';
import { poolCard } from './pool-card.js';
import { updateTableTimers } from './shared.js';

const SLIDE_MS = 9000; // ~8-10s, per slide, as asked

/* ---------- slide content ---------- */

// The exact same card the Tables screen uses — same timer, bill, rate, hour-mark and overtime states —
// so the TV shows the real thing, not a simplified summary. updateTableTimers() (below) keeps it ticking
// live once a second, the same way the Tables screen's own grid does.
function tablesSlide() {
  const tables = [...state.tables].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const live = tables.filter((t) => t.status === 'in_use' && t.session);
  const available = tables.length - live.length;
  return `
    <div class="showcase__tables">
      <div class="showcase__tables-head">
        <p class="showcase__eyebrow">Golden Break Billiard Hall</p>
        <h1 class="showcase__tables-title">Live Table Status</h1>
        <p class="showcase__tables-sub">${live.length} in play · ${available} open</p>
      </div>
      ${tables.length ? `<div class="pool-grid showcase__pool-grid">${tables.map((t) => poolCard(t)).join('')}</div>` : '<p class="showcase__meta">No tables yet.</p>'}
    </div>`;
}

function championSlide(c) {
  return `
    <div class="showcase__spot showcase__spot--champion">
      <div class="showcase__spot-photo showcase__spot-photo--round">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : icon('users')}</div>
      <div class="showcase__spot-info">
        <p class="showcase__eyebrow showcase__eyebrow--gold">${icon('rack')}Champion Spotlight</p>
        <p class="showcase__placement">${esc(c.placement || 'Champion')}</p>
        <h1 class="showcase__name">${esc(c.playerName)}</h1>
        ${c.tournamentTitle ? `<p class="showcase__meta showcase__meta--lg">${esc(c.tournamentTitle)}</p>` : ''}
        ${c.achievement ? `<p class="showcase__achievement">${icon('check')}${esc(c.achievement)}</p>` : ''}
      </div>
    </div>`;
}

function featuredSlide(f) {
  return `
    <div class="showcase__spot showcase__spot--featured">
      <div class="showcase__spot-photo">${f.photo ? `<img src="${esc(f.photo)}" alt="">` : icon('cue')}</div>
      <div class="showcase__spot-info">
        <p class="showcase__eyebrow">${icon('cue')}Featured Cue</p>
        <h1 class="showcase__name">${esc(f.name)}</h1>
        ${f.meta ? `<p class="showcase__meta">${esc(f.meta)}</p>` : ''}
        ${f.description ? `<p class="showcase__desc">${esc(f.description)}</p>` : ''}
        ${f.price != null ? `<p class="showcase__price">${peso(f.price)}</p>` : ''}
      </div>
    </div>`;
}

function promoSlide(p) {
  return `
    <div class="showcase__spot showcase__spot--promo${p.photo ? '' : ' showcase__spot--centered'}">
      ${p.photo ? `<div class="showcase__spot-photo">${`<img src="${esc(p.photo)}" alt="">`}</div>` : ''}
      <div class="showcase__spot-info">
        <p class="showcase__eyebrow showcase__eyebrow--amber">${icon('bell')}Happening Now</p>
        <h1 class="showcase__name">${esc(p.headline)}</h1>
        ${p.body ? `<p class="showcase__meta showcase__meta--lg">${esc(p.body)}</p>` : ''}
      </div>
    </div>`;
}

const SLIDE_HTML = { tables: tablesSlide, champion: championSlide, featured: featuredSlide, promo: promoSlide };

/** The featured slide's data: the owner's own pick if they've set one, otherwise the newest available
 * cue stick, so the slot is never empty without the owner having to configure anything. */
function featuredData(sc) {
  const own = sc.featured;
  if (own?.enabled && own.name) return { name: own.name, price: own.price, description: own.description, photo: own.photo, meta: null };
  const cue = state.cueSticks.find((c) => c.status === 'available');
  if (!cue) return null;
  return { name: cue.name, price: cue.price, description: null, photo: cue.photo, meta: [cue.brand, cue.weight].filter(Boolean).join(' · ') };
}

/** What's in the rotation right now: Live Table Status always first, then whichever owner-set slides
 * are switched on and have something to show (Featured falls back to a real cue stick — see above). */
function buildSlides() {
  const sc = state.settings.showcase || {};
  const list = [{ type: 'tables', data: null }];
  if (sc.champion?.enabled && sc.champion.playerName) list.push({ type: 'champion', data: sc.champion });
  const featured = featuredData(sc);
  if (featured) list.push({ type: 'featured', data: featured });
  if (sc.promo?.enabled && sc.promo.headline) list.push({ type: 'promo', data: sc.promo });
  return list;
}

/* ---------- mount ---------- */

export function mount(el) {
  const shell = document.querySelector('.shell');
  shell?.classList.add('showcase-mode');
  const display = isDisplay(state.user);

  el.innerHTML = `
    <div class="showcase">
      ${display
        ? `<button type="button" class="showcase__back" data-action="sign-out">${icon('logout')}Sign out</button>`
        : `<a class="showcase__back" href="#/cue-sticks">${icon('arrowLeft')}Back to app</a>`}
      <div class="showcase__stage">
        <div class="showcase__layer is-active" data-region="layer-0"></div>
        <div class="showcase__layer" data-region="layer-1"></div>
      </div>
      <div class="showcase__dots" data-region="dots"></div>
    </div>`;

  const layers = [el.querySelector('[data-region=layer-0]'), el.querySelector('[data-region=layer-1]')];
  const dots = el.querySelector('[data-region=dots]');
  let active = 0; // which layer is currently visible
  let index = 0; // index into the current slide list
  let timer = null;

  const currentType = () => buildSlides()[index]?.type;

  function renderDots(list) {
    dots.innerHTML = list.length > 1 ? list.map((_, i) => `<span class="showcase__dot${i === index ? ' is-active' : ''}"></span>`).join('') : '';
  }

  /** Repaint the slide that's already on screen (live data changed) — no crossfade, just fresh content. */
  function refresh() {
    const list = buildSlides();
    if (index >= list.length) index = 0;
    const slide = list[index];
    layers[active].innerHTML = (SLIDE_HTML[slide.type] || (() => ''))(slide.data);
    renderDots(list);
  }

  /** Move to the next slide with a smooth crossfade: paint the hidden layer, then swap which is visible. */
  function advance() {
    const list = buildSlides();
    if (list.length < 2) { refresh(); return; }
    index = (index + 1) % list.length;
    const slide = list[index];
    const next = active === 0 ? 1 : 0;
    layers[next].innerHTML = (SLIDE_HTML[slide.type] || (() => ''))(slide.data);
    layers[next].classList.add('is-active');
    layers[active].classList.remove('is-active');
    active = next;
    renderDots(list);
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
    on('cueSticks', () => { if (currentType() === 'tables' || currentType() === 'featured') refresh(); }),
    on('tables', () => { if (currentType() === 'tables') refresh(); }),
    on('settings', () => { if (index >= buildSlides().length) index = 0; refresh(); }),
    on('tick', () => { if (currentType() === 'tables') updateTableTimers(layers[active]); }),
  ];
  refresh();
  restart();

  return () => {
    clearInterval(timer);
    offs.forEach((off) => off());
    shell?.classList.remove('showcase-mode');
  };
}
