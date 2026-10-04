// Stage 3 port: rotation alignment. Mirrors scan2step/pose.py plus the
// mm-conversion / orientation steps of pipeline.contour_from_photo.
// The symmetry axis is found on the raster mask (mirror-IoU, coarse to
// fine) but applied ANALYTICALLY to the sub-pixel contour — never
// resample the contour through a raster (reference hard-won lesson).

// cv2.getRotationMatrix2D((cx,cy), angle, 1) with the R[0,2] += W/2 - cx
// recentering shift applied, as a flat 2x3 row-major array.
function rotMat(cx, cy, angleDeg, cols) {
  const t = (angleDeg * Math.PI) / 180;
  const a = Math.cos(t), b = Math.sin(t);
  return [a, b, (1 - a) * cx - b * cy + (cols / 2 - cx),
          -b, a, b * cx + (1 - a) * cy];
}

function mirrorIou(c, mask, cx, cy, angleDeg) {
  const M = c.matFromArray(2, 3, c.CV_64FC1, rotMat(cx, cy, angleDeg, mask.cols));
  const r = new c.Mat();
  c.warpAffine(mask, r, M, new c.Size(mask.cols, mask.rows), c.INTER_NEAREST,
    c.BORDER_CONSTANT, new c.Scalar(0, 0, 0, 0));
  const d = r.data, W = r.cols, H = r.rows;
  let inter = 0, union = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const a = d[row + x], b = d[row + W - 1 - x];
      if (a & b) inter++;
      if (a | b) union++;
    }
  }
  M.delete(); r.delete();
  return union ? inter / union : 0;
}

// np.arange: values start + i*step while < stop
function arange(start, stop, step) {
  const out = [];
  for (let i = 0; start + i * step < stop; i++) out.push(start + i * step);
  return out;
}

// Python max(seq, key=f): first element attaining the max
function argmaxBy(values, f) {
  let best = values[0], bestV = f(values[0]);
  for (let i = 1; i < values.length; i++) {
    const v = f(values[i]);
    if (v > bestV) { bestV = v; best = values[i]; }
  }
  return best;
}

const mod = (x, m) => ((x % m) + m) % m;

/** mask: CV_8UC1 0/1. Returns { angle, center: [cx, cy], iou }. */
export function findPose(c, mask, log = () => {}) {
  const d = mask.data, W = mask.cols, H = mask.rows;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) if (d[row + x]) { sx += x; sy += y; n++; }
  }
  const cx = sx / n, cy = sy / n;

  const sm = new c.Mat();
  c.resize(mask, sm, new c.Size(0, 0), 0.25, 0.25, c.INTER_NEAREST);
  const scx = cx * 0.25, scy = cy * 0.25;
  const coarse = argmaxBy(arange(-20, 20.01, 1.0), (a) => mirrorIou(c, sm, scx, scy, a));
  const mid = argmaxBy(arange(coarse - 1.5, coarse + 1.51, 0.25),
    (a) => mirrorIou(c, sm, scx, scy, a));
  sm.delete();
  const fine = argmaxBy(arange(mid - 0.25, mid + 0.251, 0.05),
    (a) => mirrorIou(c, mask, cx, cy, a));
  const iou = mirrorIou(c, mask, cx, cy, fine);

  // PCA cross-check (np.cov with N-1 divisor; 2x2 analytic eigenvector)
  let sxx = 0, sxy = 0, syy = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!d[row + x]) continue;
      const dx = x - cx, dy = y - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
  }
  const a = sxx / (n - 1), b = sxy / (n - 1), c2 = syy / (n - 1);
  const lMax = (a + c2) / 2 + Math.hypot((a - c2) / 2, b);
  let vx, vy;
  if (b === 0) { [vx, vy] = a >= c2 ? [1, 0] : [0, 1]; }
  else { vx = b; vy = lMax - a; }
  const pcaDeg = (Math.atan2(vx, vy) * 180) / Math.PI;
  const pcaDev = Math.min(
    Math.abs(mod(pcaDeg - fine + 90, 180) - 90),
    Math.abs(mod(pcaDeg + fine + 90, 180) - 90));
  log(`rotation ${fine >= 0 ? "+" : ""}${fine.toFixed(2)} deg, mirror IoU ` +
      `${iou.toFixed(4)}, PCA axis ${pcaDeg >= 0 ? "+" : ""}${pcaDeg.toFixed(2)} deg`);
  if (pcaDev > 1.5) {
    log(`WARNING: PCA axis disagrees with symmetry axis by ${pcaDev.toFixed(2)} deg`);
  }
  return { angle: fine, center: [cx, cy], iou };
}

/** Apply the alignment rotation to sub-pixel contour points (image px). */
export function rotateContour(contourPx, angleDeg, [cx, cy], cols) {
  const [r0, r1, r2, r3, r4, r5] = rotMat(cx, cy, angleDeg, cols);
  return contourPx.map(([x, y]) => [r0 * x + r1 * y + r2, r3 * x + r4 * y + r5]);
}

// pipeline.contour_from_photo tail: px -> centered mm (+Y up), tip up,
// clockwise orientation.
export function toOrientedMm(cRot, pxmm, log = () => {}) {
  let pts = cRot.map(([x, y]) => [x / pxmm, -y / pxmm]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const centerMm = [(maxX + minX) / 2, (maxY + minY) / 2];
  pts = pts.map(([x, y]) => [x - centerMm[0], y - centerMm[1]]);

  // tip_up: narrow end to +Y, width measured from the contour itself
  const ys = pts.map((p) => p[1]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const h = yMax - yMin;
  const bandWidth = (lo, hi) => {
    let n = 0, lo2 = Infinity, hi2 = -Infinity;
    for (const [x, y] of pts) {
      if (y >= lo && y <= hi) { n++; lo2 = Math.min(lo2, x); hi2 = Math.max(hi2, x); }
    }
    return n < 3 ? Infinity : hi2 - lo2;
  };
  const top = bandWidth(yMax - 0.2 * h, yMax - 0.02 * h);
  const bot = bandWidth(yMin + 0.02 * h, yMin + 0.2 * h);
  const flipped = top > bot;
  if (flipped) {
    pts = pts.map(([x, y]) => [-x, -y]); // 180 deg about the origin
    log(`flipped 180 deg (tip was down: top width ${top.toFixed(1)} > ` +
        `bottom ${bot.toFixed(1)} mm)`);
  }

  // enforce clockwise orientation (negative shoelace area)
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = i === 0 ? pts.length - 1 : i - 1; // np.roll(v, 1)[i] = v[i-1]
    area2 += pts[i][0] * pts[j][1] - pts[i][1] * pts[j][0];
  }
  if (0.5 * area2 > 0) pts.reverse();
  return { cMm: pts, flipped, centerMm };
}
