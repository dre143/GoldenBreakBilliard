// Decorative background billiard balls for the sign-in screen's atmosphere (not app icons —
// full-color rendered spheres, unlike the stroke icons in icons.js). Ambient only: low-opacity,
// blurred, corner-scattered by the caller via CSS. See BALL_KINDS for the four used.

const BALL_STYLES = {
  solid8: { base: '#2A2A2E', dark: '#08080A', light: '#5B5B60', number: '#111' },
  solid5: { base: '#F08C2A', dark: '#9A4E0A', light: '#FFC77A', number: '#7A3B08' },
  solid3: { base: '#E0362F', dark: '#8E1712', light: '#FF8E85', number: '#8E1712' },
  striped13: { base: '#F4F1E8', dark: '#C9C3AF', light: '#FFFFFF', number: '#B85C1A', stripe: '#F0932B' },
};

function ballSvg(number, kind) {
  const s = BALL_STYLES[kind];
  const uid = `${kind}-${number}`;
  const striped = kind === 'striped13';
  const fontSize = String(number).length > 1 ? 30 : 38;
  return `
    <svg viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="sh-${uid}" cx="34%" cy="28%" r="78%">
          <stop offset="0%" stop-color="${s.light}"/>
          <stop offset="55%" stop-color="${s.base}"/>
          <stop offset="100%" stop-color="${s.dark}"/>
        </radialGradient>
        <clipPath id="cl-${uid}"><circle cx="50" cy="50" r="46"/></clipPath>
      </defs>
      <circle cx="50" cy="50" r="46" fill="url(#sh-${uid})"/>
      ${striped ? `<g clip-path="url(#cl-${uid})"><rect x="0" y="33" width="100" height="34" fill="${s.stripe}"/></g>` : ''}
      <circle cx="50" cy="50" r="19" fill="#fff"/>
      <text x="50" y="58" text-anchor="middle" font-family="'Oswald', sans-serif" font-weight="700"
        font-size="${fontSize}" fill="${s.number}">${number}</text>
      <ellipse cx="35" cy="30" rx="13" ry="7.5" fill="#fff" opacity=".5" transform="rotate(-28 35 30)"/>
    </svg>`;
}

/** Corner placement classes vary the size/position so the scatter doesn't read as a grid. */
export const BALL_KINDS = [
  { number: 8, kind: 'solid8', pos: 'tl' },
  { number: 5, kind: 'solid5', pos: 'tr' },
  { number: 3, kind: 'solid3', pos: 'bl' },
  { number: 13, kind: 'striped13', pos: 'br' },
];

export const backgroundBalls = () => `
  <div class="gb-balls" aria-hidden="true">
    ${BALL_KINDS.map(({ number, kind, pos }) => `<div class="gb-ball gb-ball--${pos}">${ballSvg(number, kind)}</div>`).join('')}
  </div>`;
