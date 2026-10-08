// Scallop suggestions that save a grid unit. Pure geometry, no OpenCV:
// the pocket's bbox is predicted as bbox(base fit ∪ scallop circles) —
// closing/blending only fill in between, never past that union — and
// pushed through the same unit rounding as layout(). Predictions only
// propose candidates; main.js verifies each with a real fit before
// showing it, so a suggestion never appears unless it truly helps.
import { GRID, GAP } from "./profilestage.js";

export const D_MIN = 15; // mm; smaller is no use as a finger scallop
const MARGIN = 0.3;      // mm of slack on predictions (refit dev, strict)

export function pocketExtent(fit, scallops, d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of fit) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  if (d > 0) {
    const r = d / 2;
    for (const [x, y] of scallops) {
      if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r;
      if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r;
    }
  }
  return { x0, y0, x1, y1 };
}

/** grid units for an extent, as layout() rounds them (+ margin) */
export function binUnits(e, minWall, margin = 0) {
  return {
    nx: Math.ceil((e.x1 - e.x0 + margin + 2 * minWall + GAP) / GRID),
    ny: Math.ceil((e.y1 - e.y0 + margin + 2 * minWall + GAP) / GRID),
  };
}

const smaller = (u, cur) =>
  u.nx <= cur.nx && u.ny <= cur.ny && u.nx * u.ny < cur.nx * cur.ny;

/** Largest whole-mm scallop size below d (>= D_MIN) at the current
 *  spots that predicts a smaller bin than `cur` ({nx, ny}, the real
 *  layout). null when even the bare tool needs the current bin. */
export function suggestSize(fit, scallops, d, minWall, cur) {
  if (!(d > D_MIN) || !scallops.length) return null;
  const bare = binUnits(pocketExtent(fit, [], 0), minWall, MARGIN);
  if (!smaller(bare, cur)) return null;
  for (let dd = Math.ceil(d) - 1; dd >= D_MIN; dd--) {
    const u = binUnits(pocketExtent(fit, scallops, dd), minWall, MARGIN);
    if (smaller(u, cur)) return { d: dd, ...u };
  }
  return null;
}

function snap(fit, pt) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < fit.length; i++) {
    const dd = (fit[i][0] - pt[0]) ** 2 + (fit[i][1] - pt[1]) ** 2;
    if (dd < best) { best = dd; bi = i; }
  }
  return [fit[bi][0], fit[bi][1]];
}

/** Spots on the outline (a mirrored pair across x = 0 when there are
 *  two scallops, as dragging does) where size d predicts a smaller bin;
 *  returns the one closest to where the scallops are now. */
export function suggestPosition(fit, scallops, d, minWall, cur, samples = 400) {
  if (!(d > 0) || !scallops.length || !fit.length) return null;
  const bare = binUnits(pocketExtent(fit, [], 0), minWall, MARGIN);
  if (!smaller(bare, cur)) return null;
  const pair = scallops.length > 1;
  const stride = Math.max(1, Math.floor(fit.length / samples));
  let best = null;
  for (let i = 0; i < fit.length; i += stride) {
    const p = [fit[i][0], fit[i][1]];
    const cand = pair ? [p, snap(fit, [-p[0], p[1]])] : [p];
    const u = binUnits(pocketExtent(fit, cand, d), minWall, MARGIN);
    if (!smaller(u, cur)) continue;
    // distance moved: best matching of new spots to current ones
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let move = dist(cand[0], scallops[0]);
    if (pair) {
      move = Math.min(Math.max(dist(cand[0], scallops[0]), dist(cand[1], scallops[1])),
                      Math.max(dist(cand[0], scallops[1]), dist(cand[1], scallops[0])));
    }
    if (!best || move < best.move) best = { scallops: cand, move, ...u };
  }
  return best;
}
