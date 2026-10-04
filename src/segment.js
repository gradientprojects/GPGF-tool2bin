// Stage 2 port: illumination-normalized segmentation with sub-pixel
// contour extraction. Numerical mirror of scan2step/segment.py — every
// resize/blur/threshold matches the reference op-for-op (including its
// float32 round-trips and truncating uint8 casts), because the exit gate
// is sub-0.1 mm contour parity. `c` is the ready OpenCV instance.
//
// Channel order: the reference runs on BGR, this port on RGB. Every op
// in the chain (LAB distance, Telea inpaint, per-channel median/blur,
// channel-wise min/max ratio) is channel-symmetric, so results agree.
import { findContours } from "./marching.js";

export const SCORE_TH = 0.40;

// np.median over integer-valued samples via a 256-bin histogram:
// odd n -> middle value, even n -> mean of the two middle values.
function histMedian(hist, n) {
  const lo = (n - 1) >> 1, hi = n >> 1;
  let cum = 0, vLo = -1, vHi = -1;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (vLo < 0 && cum > lo) vLo = v;
    if (vHi < 0 && cum > hi) { vHi = v; return (vLo + vHi) / 2; }
  }
  return 0;
}

// median LAB over a pixel-mask callback (values are integer-valued floats)
function medianLab(data, W, H, inMask) {
  const hist = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inMask(y, x)) continue;
      const i = 3 * (y * W + x);
      hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++;
      n++;
    }
  }
  return [histMedian(hist[0], n), histMedian(hist[1], n), histMedian(hist[2], n)];
}

// scipy binary_fill_holes (4-connected background flood from the border)
function fillHoles(mask, W, H) {
  const reach = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let qt = 0;
  const push = (p) => { if (!mask[p] && !reach[p]) { reach[p] = 1; queue[qt++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  for (let qh = 0; qh < qt; qh++) {
    const p = queue[qh];
    const x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < (H - 1) * W) push(p + W);
  }
  const filled = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) filled[p] = mask[p] || !reach[p] ? 1 : 0;
  return filled;
}

/**
 * warpRgba: CV_8UC4 warped canvas (not consumed). field: [x0,y0,x1,y1] mm
 * or null. Returns { contourPx: [[x,y]...] sub-pixel, mask: CV_8UC1 0/1
 * Mat (caller deletes), areaMm2 }.
 */
export function segment(c, warpRgba, field, pxmm, log = () => {}) {
  const Wc = warpRgba.cols, Hc = warpRgba.rows;
  const rgb = new c.Mat();
  c.cvtColor(warpRgba, rgb, c.COLOR_RGBA2RGB);
  const lab8 = new c.Mat();
  c.cvtColor(rgb, lab8, c.COLOR_RGB2Lab);

  let x0 = 0, y0 = 0, domW = Wc, domH = Hc, rect = null;
  if (field) {
    const f = field.map((v) => Math.trunc(v * pxmm));
    const g = Math.trunc(1 * pxmm);
    x0 = f[0] + g; y0 = f[1] + g;
    domW = f[2] - g - x0; domH = f[3] - g - y0;
    rect = new c.Rect(x0, y0, domW, domH);
  }

  // float32 LAB on the domain: background reference + 0.1x INTER_AREA
  const labDomF = new c.Mat();
  {
    const v = rect ? lab8.roi(rect) : lab8;
    v.convertTo(labDomF, c.CV_32FC3);
    if (rect) v.delete();
  }
  lab8.delete();
  const ld = labDomF.data32F;
  let ref;
  if (field) {
    const a = Math.trunc(1 * pxmm), b = Math.trunc(11 * pxmm);
    ref = medianLab(ld, domW, domH, (y, x) =>
      y >= a && y < domH - a && x >= a && x < domW - a &&
      !(y >= b && y < domH - b && x >= b && x < domW - b));
  } else {
    const m0 = Math.trunc(8 * pxmm), m1 = Math.trunc(28 * pxmm);
    ref = medianLab(ld, domW, domH, (y, x) => {
      const inX = x >= m0 && x < domW - m0;
      if ((y >= m0 && y < m1) || (y >= domH - m1 && y < domH - m0)) return inX;
      if (y >= m0 && y < domH - m0) {
        return (x >= m0 && x < m1) || (x >= domW - m1 && x < domW - m0);
      }
      return false;
    });
  }

  const labs = new c.Mat();
  c.resize(labDomF, labs, new c.Size(0, 0), 0.1, 0.1, c.INTER_AREA);
  labDomF.delete();
  const sw = labs.cols, sh = labs.rows;

  // coarse "not paper" mask, threshold adapting upward under bad lighting
  const ls = labs.data32F;
  const ker25 = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(25, 25));
  let hole = null, th = 0, holeMean = 1;
  for (th of [12, 18, 25, 35, 50]) {
    const coarse = new c.Mat(sh, sw, c.CV_8UC1);
    const cd = coarse.data;
    for (let p = 0; p < sw * sh; p++) {
      const i = 3 * p;
      const d0 = ls[i] - ref[0], d1 = ls[i + 1] - ref[1], d2 = ls[i + 2] - ref[2];
      cd[p] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) > th ? 1 : 0;
    }
    if (hole) hole.delete();
    hole = new c.Mat();
    c.dilate(coarse, hole, ker25);
    coarse.delete();
    holeMean = c.countNonZero(hole) / (sw * sh);
    if (holeMean < 0.5) break;
  }
  ker25.delete();
  if (th > 12) {
    log(`uneven lighting: coarse threshold raised to ${th} ` +
        `(hole ${Math.round(holeMean * 100)}% of field)`);
  }

  // paper background: inpaint across the hole at 0.1x, blur, upsample
  const wDomF = new c.Mat();
  {
    const v = rect ? rgb.roi(rect) : rgb;
    v.convertTo(wDomF, c.CV_32FC3);
    if (rect) v.delete();
  }
  rgb.delete();
  const wsF = new c.Mat();
  c.resize(wDomF, wsF, new c.Size(sw, sh), 0, 0, c.INTER_AREA);
  const ws8 = new c.Mat(sh, sw, c.CV_8UC3);
  {
    const src = wsF.data32F, dst = ws8.data;
    for (let i = 0; i < src.length; i++) {
      // np.clip(...).astype(uint8): truncating cast, not rounding
      const v = src[i];
      dst[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.floor(v);
    }
  }
  wsF.delete();
  let bgs8;
  if (holeMean > 0.7) {
    const hd = hole.data, wd = ws8.data;
    const hist = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
    let nValid = 0;
    for (let p = 0; p < sw * sh; p++) {
      if (hd[p] === 0) {
        hist[0][wd[3 * p]]++; hist[1][wd[3 * p + 1]]++; hist[2][wd[3 * p + 2]]++;
        nValid++;
      }
    }
    let n = nValid;
    if (nValid <= 50) {
      n = sw * sh;
      for (const h of hist) h.fill(0);
      for (let p = 0; p < sw * sh; p++) {
        hist[0][wd[3 * p]]++; hist[1][wd[3 * p + 1]]++; hist[2][wd[3 * p + 2]]++;
      }
    }
    log(`WARNING: background hole covers ${Math.round(holeMean * 100)}% of ` +
        `the field; using flat median background`);
    const med = hist.map((h) => Math.floor(histMedian(h, n))); // .astype(uint8) truncates
    bgs8 = new c.Mat(sh, sw, c.CV_8UC3, new c.Scalar(med[0], med[1], med[2]));
  } else {
    bgs8 = new c.Mat();
    c.inpaint(ws8, hole, bgs8, 25, c.INPAINT_TELEA);
  }
  ws8.delete(); hole.delete();
  const bgsF = new c.Mat();
  bgs8.convertTo(bgsF, c.CV_32FC3);
  bgs8.delete();
  c.GaussianBlur(bgsF, bgsF, new c.Size(0, 0), 5);
  const bg = new c.Mat();
  c.resize(bgsF, bg, new c.Size(domW, domH), 0, 0, c.INTER_CUBIC);
  bgsF.delete();

  // two-sided illumination-normalized score on the domain
  const scoreDom = new c.Mat(domH, domW, c.CV_32FC1);
  {
    const wv = wDomF.data32F, bv = bg.data32F, sv = scoreDom.data32F;
    for (let p = 0; p < domW * domH; p++) {
      const i = 3 * p;
      const r0 = wv[i] / Math.max(bv[i], 1);
      const r1 = wv[i + 1] / Math.max(bv[i + 1], 1);
      const r2 = wv[i + 2] / Math.max(bv[i + 2], 1);
      const mn = Math.min(r0, r1, r2), mx = Math.max(r0, r1, r2);
      sv[p] = Math.max(1 - mn, 2.0 * (mx - 1));
    }
  }
  wDomF.delete(); bg.delete();
  c.GaussianBlur(scoreDom, scoreDom, new c.Size(0, 0), 1.0);

  // full-canvas score (marker band stays 0 by construction)
  const score = new Float32Array(Wc * Hc);
  {
    const sv = scoreDom.data32F;
    for (let y = 0; y < domH; y++) {
      score.set(sv.subarray(y * domW, (y + 1) * domW), (y0 + y) * Wc + x0);
    }
  }
  scoreDom.delete();

  // threshold -> components (scipy label == 4-connectivity)
  const bArr = new Uint8Array(Wc * Hc);
  for (let p = 0; p < Wc * Hc; p++) bArr[p] = score[p] > SCORE_TH ? 1 : 0;
  const bMat = new c.Mat(Hc, Wc, c.CV_8UC1);
  bMat.data.set(bArr);
  const labels = new c.Mat(), stats = new c.Mat(), cents = new c.Mat();
  const nLbl = c.connectedComponentsWithStats(bMat, labels, stats, cents, 4, c.CV_32S);
  bMat.delete(); cents.delete();
  if (nLbl <= 1) {
    labels.delete(); stats.delete();
    throw new Error("no tool found above score threshold");
  }
  const area = (i) => stats.data32S[i * 5 + 4]; // CC_STAT_AREA
  let mainI = 1;
  for (let i = 2; i < nLbl; i++) if (area(i) > area(mainI)) mainI = i;

  const lv = labels.data32S;
  const main8 = new c.Mat(Hc, Wc, c.CV_8UC1);
  {
    const md = main8.data;
    for (let p = 0; p < Wc * Hc; p++) md[p] = lv[p] === mainI ? 1 : 0;
  }
  // re-attach substantial satellites within ~2 mm of the main component
  const kSize = (Math.trunc(4 * pxmm) | 1);
  const ker4 = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(kSize, kSize));
  const near = new c.Mat();
  c.dilate(main8, near, ker4);
  const touched = new Uint8Array(nLbl);
  {
    const nd = near.data;
    for (let p = 0; p < Wc * Hc; p++) if (nd[p] && lv[p] > 0) touched[lv[p]] = 1;
  }
  near.delete();
  const sats = [];
  for (let i = 1; i < nLbl; i++) {
    if (i !== mainI && area(i) / (pxmm * pxmm) >= 100 && touched[i]) sats.push(i);
  }
  if (sats.length) {
    log(`re-attached ${sats.length} satellite part(s) ` +
        `(${sats.map((i) => (area(i) / (pxmm * pxmm)).toFixed(0) + " mm^2").join(", ")})`);
    const satSet = new Uint8Array(nLbl);
    for (const i of sats) satSet[i] = 1;
    const md = main8.data;
    for (let p = 0; p < Wc * Hc; p++) if (satSet[lv[p]]) md[p] = 1;
    c.morphologyEx(main8, main8, c.MORPH_CLOSE, ker4);
  }
  ker4.delete(); labels.delete(); stats.delete();

  const filled = fillHoles(main8.data, Wc, Hc);
  let areaPx = 0;
  for (let p = 0; p < Wc * Hc; p++) areaPx += filled[p];

  // fill enclosed voids/seams in the score; zero far outside
  const filledMat = main8; // reuse the Mat allocation for `filled`
  filledMat.data.set(filled);
  const keepMat = new c.Mat();
  const ker21 = c.Mat.ones(21, 21, c.CV_8U);
  c.dilate(filledMat, keepMat, ker21);
  ker21.delete();
  {
    const kd = keepMat.data;
    for (let p = 0; p < Wc * Hc; p++) {
      if (filled[p] && !bArr[p]) score[p] = 1.0;
      else if (!kd[p]) score[p] = 0.0;
    }
  }
  keepMat.delete();

  const contours = findContours(score, Hc, Wc, SCORE_TH);
  if (!contours.length) { filledMat.delete(); throw new Error("no contour traced"); }
  let best = contours[0];
  for (const cc of contours) if (cc.length > best.length) best = cc;
  const contourPx = best.map(([r, col]) => [col, r]); // -> (x, y) sub-pixel

  const areaMm2 = areaPx / (pxmm * pxmm);
  log(`tool area ${areaMm2.toFixed(0)} mm^2, contour ${contourPx.length} sub-pixel points`);
  return { contourPx, mask: filledMat, areaMm2 };
}
