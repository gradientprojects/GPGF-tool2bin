// Revision deboss: the rev string ("R01"…) cut 0.4 mm into the
// underside, centered in the foot of the cell that reads bottom-left
// when the bin is flipped over (tipped toward you, about X). The text
// is mirrored so it reads correctly from below.
//
// Font: Inter Bold, subset to R + digits and renamed "T2B Rev" per the
// OFL reserved-name rule (src/assets/t2b-rev-bold.ttf).
//
// Printability: at 9 mm cap height Inter Bold stems are ~1.8 mm —
// comfortable from 0.25 to 0.8 mm nozzles — and 0.4 mm depth is two
// standard layers against a floor that is never thinner than 7 mm.
// Geometry: 9 mm-tall text centered in a cell cannot reach the magnet
// pockets (rims at |x|,|y| = 13 ± 4) or the foot chamfer (the flat is
// 35.6 mm wide); width is clamped to the flat regardless.
import { loadFont, textBlueprints } from "replicad";
import { GRID, FOOT_BOT } from "./bin3d.js";

export const DEBOSS_DEPTH = 0.4;
export const DEBOSS_HEIGHT = 9.0;
const EDGE_MARGIN = 1.5;
const FAMILY = "T2B Rev";

let fontLoaded = null;
/** load the deboss font once; `buf` is (a promise of) an ArrayBuffer */
export function ensureDebossFont(buf) {
  if (!fontLoaded) {
    fontLoaded = Promise.resolve(buf).then((b) => loadFont(b, FAMILY));
  }
  return fontLoaded;
}

/** Cutter solid for `text` on an nx×ny bin at `center`: a replicad
 *  shape spanning z = -0.5 … DEBOSS_DEPTH (its .wrapped is the raw
 *  TopoDS shape for bin3d's booleans). Requires ensureDebossFont. */
export function debossCutter(text, nx, ny, center = [0, 0]) {
  // probe at an arbitrary size, then scale to the target cap height
  // (clamped so the text always stays on the foot's flat bottom)
  const probe = textBlueprints(text, { fontSize: 100, fontFamily: FAMILY });
  const pb = probe.boundingBox;
  let size = (100 * DEBOSS_HEIGHT) / pb.height;
  const maxW = FOOT_BOT - 2 * EDGE_MARGIN;
  if ((pb.width * size) / 100 > maxW) size = (100 * maxW) / pb.width;
  let bp = textBlueprints(text, { fontSize: size, fontFamily: FAMILY });
  const [cx, cy] = bp.boundingBox.center;
  // the flipped underside's bottom-left cell is min-x/max-y in model
  // space; mirroring across the text's horizontal axis makes it read
  // correctly from below
  const tx = center[0] - ((nx - 1) / 2) * GRID;
  const ty = center[1] + ((ny - 1) / 2) * GRID;
  bp = bp.mirror([1, 0], [cx, cy], "plane").translate(tx - cx, ty - cy);
  return bp.sketchOnPlane("XY", -0.5).extrude(0.5 + DEBOSS_DEPTH);
}
