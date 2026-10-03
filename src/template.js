// Template layout — MUST stay numerically identical to the reference
// implementation's scan2step/template.py layout(). One definition drives
// the printable PDF (reference repo) and this detector.
export const PX_REF = 20.0; // px/mm of the reference warp canvas
export const PAGES = { letter: [215.9, 279.4], a4: [210.0, 297.0] };
export const ID_BASE = { letter: 0, a4: 24 }; // DICT_4X4_50 ids 0..49
export const MARKER_MM = 16.0;
export const MARGIN_MM = 6.0;
export const GAP_MM = 4.0; // marker band -> field gap
const N_ACROSS = 6;
const N_DOWN = 6;

function linspace(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

/** Returns { W, H, markers: Map(id -> [x, y]), field: [x0,y0,x1,y1] }; mm, y down. */
export function layout(page) {
  const [W, H] = PAGES[page];
  const s = MARKER_MM, m = MARGIN_MM;
  let id = ID_BASE[page];
  const markers = new Map();
  const xs = linspace(m, W - m - s, N_ACROSS);
  for (const x of xs) markers.set(id++, [x, m]);
  for (const x of xs) markers.set(id++, [x, H - m - s]);
  const ys = linspace(m + s + GAP_MM, H - m - 2 * s - GAP_MM, N_DOWN);
  for (const y of ys) markers.set(id++, [m, y]);
  for (const y of ys) markers.set(id++, [W - m - s, y]);
  const inset = m + s + GAP_MM;
  return { W, H, markers, field: [inset, inset, W - inset, H - inset] };
}

/** TL, TR, BR, BL in template mm (y down) — matches detectMarkers order. */
export function markerCornersMm(x, y) {
  const s = MARKER_MM;
  return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
}
