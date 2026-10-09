// Puzzle-piece bin (owner idea, 2026-10-09): drop whole 42 mm cells the pocket
// doesn't need, as long as the min-wall rule still holds, so the bin
// becomes an L / T shape. Pure geometry (no OpenCV / OCCT): which cells
// can go, and the outline of the cells that stay.
// no imports: both workers use this (the CV worker for the layout, the
// CAD worker for the body), so it stays free of either one's modules.
// Same values as profilestage.js / bin3d.js GRID and GAP.
const GRID = 42.0, GAP = 0.5;

/** cell (i, j) centre, matching bin3d.cellCenters + the layout centre */
export function cellCenter(i, j, nx, ny, center) {
  return [(i - (nx - 1) / 2) * GRID + center[0], (j - (ny - 1) / 2) * GRID + center[1]];
}

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Which cells of the nx×ny grid the bin keeps. A cell is USED if the
 *  pocket (finger scoops included: they're in pocketPts) comes within
 *  minWall + GAP/2 of its square, or covers its centre. Only unused cells
 *  reachable from outside are dropped (flood fill from the border), so
 *  an enclosed unused cell stays and the bin never gets a hole; a pinch
 *  (two kept cells touching only at a corner) re-keeps a dropped cell
 *  so the outline stays one simple loop.
 *  -> { keep: [[i, j], ...], drop: n, kept: bool[i][j] } */
export function puzzleCells(pocketPts, nx, ny, center, minWall) {
  const used = Array.from({ length: nx }, () => new Array(ny).fill(false));
  const x0 = center[0] - (nx * GRID) / 2, y0 = center[1] - (ny * GRID) / 2;
  const r = minWall + GAP / 2;
  for (const [x, y] of pocketPts) {
    const i0 = Math.max(0, Math.floor((x - r - x0) / GRID));
    const i1 = Math.min(nx - 1, Math.floor((x + r - x0) / GRID));
    const j0 = Math.max(0, Math.floor((y - r - y0) / GRID));
    const j1 = Math.min(ny - 1, Math.floor((y + r - y0) / GRID));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (used[i][j]) continue;
        // distance from (x, y) to the cell's square
        const sx0 = x0 + i * GRID, sy0 = y0 + j * GRID;
        const dx = Math.max(sx0 - x, 0, x - (sx0 + GRID));
        const dy = Math.max(sy0 - y, 0, y - (sy0 + GRID));
        if (Math.hypot(dx, dy) <= r) used[i][j] = true;
      }
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!used[i][j] && inside(pocketPts, ...cellCenter(i, j, nx, ny, center))) {
        used[i][j] = true;
      }
    }
  }
  // drop = unused AND reachable from outside through unused cells
  const dropped = Array.from({ length: nx }, () => new Array(ny).fill(false));
  const stack = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const border = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
      if (border && !used[i][j]) { dropped[i][j] = true; stack.push([i, j]); }
    }
  }
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      if (!used[a][b] && !dropped[a][b]) { dropped[a][b] = true; stack.push([a, b]); }
    }
  }
  // no pinches: kept cells meeting only at a corner get a dropped
  // neighbour back (repeat until none)
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i + 1 < nx; i++) {
      for (let j = 0; j + 1 < ny; j++) {
        const a = !dropped[i][j], b = !dropped[i + 1][j];
        const c = !dropped[i][j + 1], d = !dropped[i + 1][j + 1];
        if (a && d && !b && !c) { dropped[i + 1][j] = false; changed = true; }
        if (b && c && !a && !d) { dropped[i][j] = false; changed = true; }
      }
    }
  }
  const keep = [];
  const kept = dropped.map((col) => col.map((v) => !v));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) if (kept[i][j]) keep.push([i, j]);
  return { keep, drop: nx * ny - keep.length, kept };
}

/** Outline of the kept cells: one CCW loop of corner points (mm), inset
 *  by GAP/2 like the full bin (W = nx·42 − 0.5), straight runs merged.
 *  Each vertex: { p: [x, y], convex } (convex = left turn on the CCW
 *  loop). */
export function puzzleOutline(kept, nx, ny, center) {
  // boundary edges of the kept cells, CCW around each cell, in grid units;
  // edges shared by two kept cells don't appear
  const K = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && kept[i][j];
  const next = new Map();
  const key = (x, y) => `${x},${y}`;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!K(i, j)) continue;
      if (!K(i, j - 1)) next.set(key(i, j), [i + 1, j]);         // bottom
      if (!K(i + 1, j)) next.set(key(i + 1, j), [i + 1, j + 1]); // right
      if (!K(i, j + 1)) next.set(key(i + 1, j + 1), [i, j + 1]); // top
      if (!K(i - 1, j)) next.set(key(i, j + 1), [i, j]);         // left
    }
  }
  if (!next.size) return [];
  const [sk] = next.keys();
  const start = sk.split(",").map(Number);
  const loop = [start];
  for (let cur = next.get(sk); key(...cur) !== sk; cur = next.get(key(...cur))) {
    loop.push(cur);
    if (loop.length > 4 * nx * ny + 4) throw new Error("puzzle-piece outline did not close");
  }
  // keep only the corners (direction changes)
  const n = loop.length;
  const corners = [];
  for (let k = 0; k < n; k++) {
    const a = loop[(k - 1 + n) % n], b = loop[k], c = loop[(k + 1) % n];
    const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (cross !== 0) corners.push({ g: b, convex: cross > 0 });
  }
  // grid -> mm, each edge moved GAP/2 inward (left of travel on a CCW
  // loop): the corner moves by the sum of its two edges' inward normals
  const x0 = center[0] - (nx * GRID) / 2, y0 = center[1] - (ny * GRID) / 2;
  const m = corners.length;
  return corners.map(({ g, convex }, k) => {
    const prev = corners[(k - 1 + m) % m].g, nxt = corners[(k + 1) % m].g;
    const din = [Math.sign(g[0] - prev[0]), Math.sign(g[1] - prev[1])];
    const dout = [Math.sign(nxt[0] - g[0]), Math.sign(nxt[1] - g[1])];
    const h = GAP / 2;
    return {
      p: [x0 + g[0] * GRID + h * (-din[1] - dout[1]),
          y0 + g[1] * GRID + h * (din[0] + dout[0])],
      convex,
    };
  });
}
