// Showcase: a fullscreen, TV-friendly slideshow of the cue stick catalog — meant for a screen behind
// the counter or near the tables, not a screen staff use day to day. It reads the same live cueSticks
// data as everything else, so adding, editing or selling a cue updates the loop automatically; nothing
// here is ever re-exported or re-uploaded by hand. Reached from a link on the Cue Sticks page — point
// whatever device drives the TV (an old laptop, an Android TV box, a Fire Stick's browser) at this route
// and leave it fullscreen.
import { state, on } from '../state.js';
import { esc, peso, icon } from '../ui.js';

const SLIDE_MS = 7000;

export function mount(el) {
  const shell = document.querySelector('.shell');
  shell?.classList.add('showcase-mode');

  el.innerHTML = `
    <div class="showcase">
      <a class="showcase__back" href="#/cue-sticks">${icon('arrowLeft')}Back to app</a>
      <div class="showcase__stage" data-region="stage"></div>
      <div class="showcase__dots" data-region="dots"></div>
    </div>`;

  const stage = el.querySelector('[data-region=stage]');
  const dots = el.querySelector('[data-region=dots]');
  let index = 0;
  let timer = null;

  const items = () => state.cueSticks.filter((c) => c.status === 'available');

  function render() {
    const list = items();
    if (!list.length) {
      stage.innerHTML = `
        <div class="showcase__empty">
          <p class="showcase__eyebrow">Golden Break Pro Shop</p>
          <p>Cue sticks coming soon.</p>
        </div>`;
      dots.innerHTML = '';
      return;
    }
    if (index >= list.length) index = 0;
    const c = list[index];
    stage.innerHTML = `
      <div class="showcase__card">
        <div class="showcase__photo">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : icon('cue')}</div>
        <div class="showcase__info">
          <p class="showcase__eyebrow">Golden Break Pro Shop</p>
          <h1 class="showcase__name">${esc(c.name)}</h1>
          <p class="showcase__meta">${[c.brand, c.weight].filter(Boolean).map(esc).join(' · ') || ' '}</p>
          <p class="showcase__price">${peso(c.price)}</p>
        </div>
      </div>`;
    dots.innerHTML = list.length > 1 ? list.map((_, i) => `<span class="showcase__dot${i === index ? ' is-active' : ''}"></span>`).join('') : '';
  }

  function advance() {
    const list = items();
    if (list.length < 2) return;
    index = (index + 1) % list.length;
    render();
  }

  function restart() {
    clearInterval(timer);
    timer = setInterval(advance, SLIDE_MS);
  }

  const off = on('cueSticks', () => { if (index >= items().length) index = 0; render(); });
  render();
  restart();

  return () => {
    clearInterval(timer);
    off();
    shell?.classList.remove('showcase-mode');
  };
}
