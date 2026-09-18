import { esc, peso, pesoCompact } from '../ui.js';

/* Dual-bar chart (inline SVG): green = table revenue, amber = product sales, one group per day. */

function niceMax(value) {
  const raw = Math.max(value, 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return step * 4;
}

function topRounded(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function barChart(days) {
  const W = 640, H = 250, padL = 52, padR = 8, padT = 14, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = niceMax(Math.max(...days.flatMap((d) => [d.table, d.product])));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const group = plotW / days.length;
  const bw = Math.min(22, group * 0.3);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f;
    return `<line class="chart__grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="chart__axis" x="${padL - 10}" y="${y(v) + 4}" text-anchor="end">${pesoCompact(v)}</text>`;
  }).join('');

  const bars = days.map((d, i) => {
    const cx = padL + group * (i + 0.5);
    return `<g>
      <title>${d.full}: tables ${peso(d.table)}, products ${peso(d.product)}</title>
      <rect x="${cx - group / 2}" y="${padT}" width="${group}" height="${plotH}" fill="transparent"/>
      <path class="chart__bar chart__bar--felt" d="${topRounded(cx - bw - 2, y(d.table), bw, padT + plotH - y(d.table), 4)}"/>
      <path class="chart__bar chart__bar--amber" d="${topRounded(cx + 2, y(d.product), bw, padT + plotH - y(d.product), 4)}"/>
      <text class="chart__axis ${d.today ? 'chart__axis--today' : ''}" x="${cx}" y="${H - 10}" text-anchor="middle">${d.today ? 'Today' : d.label}</text>
    </g>`;
  }).join('');

  const summary = days.map((d) => `${d.full}: tables ${peso(d.table)}, products ${peso(d.product)}`).join('; ');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly revenue by day. ${esc(summary)}" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <line class="chart__base" x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}"/>
    ${bars}
  </svg>`;
}
