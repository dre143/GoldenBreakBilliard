// Responsive helpers shared by every page.
//
// Wide tables (5+ columns) turn into stacked cards on phones (see ".stack-table" in css/styles.css). That
// needs each cell to know its column header, so this watches the page and, whenever a table appears or is
// redrawn, copies each header's text onto the cells below it as data-label. No page template needs to
// change: any table with a real <thead> is handled the same way.

const MIN_COLUMNS = 5; // narrower tables fit on a phone as they are

function headerLabels(table) {
  const labels = [];
  for (const th of table.querySelectorAll('thead th')) {
    // Icon-only / screen-reader-only headers (e.g. "Actions") get no visible label.
    const visible = th.querySelector('.sr-only') ? '' : th.textContent.trim();
    for (let i = 0; i < (th.colSpan || 1); i++) labels.push(visible);
  }
  return labels;
}

function prepare(table) {
  if (table.dataset.stacked) return;
  const labels = headerLabels(table);
  if (labels.length < MIN_COLUMNS) return;
  for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
    let col = 0;
    for (const cell of row.children) {
      if (cell.tagName === 'TD' && !cell.hasAttribute('data-label')) cell.dataset.label = labels[col] ?? '';
      col += cell.colSpan || 1;
    }
  }
  table.dataset.stacked = '1';
  // A table marked data-scroll (the paper-style daily sales sheet) keeps a controlled sideways scroll;
  // every other wide table becomes cards on phones.
  if (!table.hasAttribute('data-scroll')) table.classList.add('stack-table');
}

/** Label every table under root now, and keep doing it as pages and dialogs redraw. Returns a stop function. */
export function watchStackedTables(root = document.body) {
  const run = () => root.querySelectorAll('table:not([data-stacked])').forEach(prepare);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; run(); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  run();
  return () => observer.disconnect();
}
