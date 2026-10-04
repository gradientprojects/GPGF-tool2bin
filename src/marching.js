// Exact port of skimage.measure.find_contours (marching squares with
// linear interpolation + segment assembly). The reference pipeline's
// sub-pixel contours come from this algorithm, so vertex values, segment
// orientation and assembly order must match skimage bit-for-bit — the
// port is gated by tests/fixtures/marching.json (golden dumps from the
// reference environment's skimage).

function frac(from, to, level) {
  if (to === from) return 0;
  return (level - from) / (to - from);
}

// array: row-major number array / TypedArray read as doubles.
function getContourSegments(data, rows, cols, level, vertexConnectHigh) {
  const segments = [];
  for (let r0 = 0; r0 < rows - 1; r0++) {
    const base = r0 * cols;
    for (let c0 = 0; c0 < cols - 1; c0++) {
      const ul = data[base + c0];
      const ur = data[base + c0 + 1];
      const ll = data[base + cols + c0];
      const lr = data[base + cols + c0 + 1];
      let sq = 0;
      if (ul > level) sq += 1;
      if (ur > level) sq += 2;
      if (ll > level) sq += 4;
      if (lr > level) sq += 8;
      if (sq === 0 || sq === 15) continue;
      const r1 = r0 + 1, c1 = c0 + 1;
      const top = [r0, c0 + frac(ul, ur, level)];
      const bottom = [r1, c0 + frac(ll, lr, level)];
      const left = [r0 + frac(ul, ll, level), c0];
      const right = [r0 + frac(ur, lr, level), c1];
      switch (sq) {
        case 1: segments.push([top, left]); break;
        case 2: segments.push([right, top]); break;
        case 3: segments.push([right, left]); break;
        case 4: segments.push([left, bottom]); break;
        case 5: segments.push([top, bottom]); break;
        case 6:
          if (vertexConnectHigh) { segments.push([left, top], [right, bottom]); }
          else { segments.push([right, top], [left, bottom]); }
          break;
        case 7: segments.push([right, bottom]); break;
        case 8: segments.push([bottom, right]); break;
        case 9:
          if (vertexConnectHigh) { segments.push([top, right], [bottom, left]); }
          else { segments.push([top, left], [bottom, right]); }
          break;
        case 10: segments.push([bottom, top]); break;
        case 11: segments.push([bottom, left]); break;
        case 12: segments.push([left, right]); break;
        case 13: segments.push([top, right]); break;
        case 14: segments.push([left, top]); break;
      }
    }
  }
  return segments;
}

// deque with O(1) ends: items = front (reversed) + back
class Deque {
  constructor(a, b) { this.front = []; this.back = [a, b]; }
  append(x) { this.back.push(x); }
  appendleft(x) { this.front.push(x); }
  first() { return this.front.length ? this.front[this.front.length - 1] : this.back[0]; }
  last() { return this.back.length ? this.back[this.back.length - 1] : this.front[0]; }
  toArray() {
    const out = [];
    for (let i = this.front.length - 1; i >= 0; i--) out.push(this.front[i]);
    for (let i = 0; i < this.back.length; i++) out.push(this.back[i]);
    return out;
  }
  extend(other) { for (const x of other.toArray()) this.back.push(x); }
  // Python tail.extendleft(reversed(head)): head items, order kept, go in front
  prependAll(items) { for (let i = items.length - 1; i >= 0; i--) this.front.push(items[i]); }
}

const key = (p) => p[0] + "," + p[1];

function assembleContours(segments) {
  let currentIndex = 0;
  const contours = new Map(); // num -> deque
  const starts = new Map();   // point key -> [deque, num]
  const ends = new Map();
  for (const [fromPt, toPt] of segments) {
    const fromK = key(fromPt), toK = key(toPt);
    // degenerate segment: one square vertex sits exactly at the level
    if (fromK === toK) continue;

    const tailEntry = starts.get(toK); starts.delete(toK);
    const headEntry = ends.get(fromK); ends.delete(fromK);
    const [tail, tailNum] = tailEntry || [null, null];
    const [head, headNum] = headEntry || [null, null];

    if (tail !== null && head !== null) {
      if (tail === head) {
        head.append(toPt); // close the contour
      } else if (tailNum > headNum) {
        head.extend(tail);
        contours.delete(tailNum);
        starts.set(key(head.first()), [head, headNum]);
        ends.set(key(head.last()), [head, headNum]);
      } else {
        const headItems = head.toArray();
        tail.prependAll(headItems);
        starts.delete(key(headItems[0]));
        contours.delete(headNum);
        starts.set(key(tail.first()), [tail, tailNum]);
        ends.set(key(tail.last()), [tail, tailNum]);
      }
    } else if (tail === null && head === null) {
      const d = new Deque(fromPt, toPt);
      contours.set(currentIndex, d);
      starts.set(fromK, [d, currentIndex]);
      ends.set(toK, [d, currentIndex]);
      currentIndex++;
    } else if (head === null) {
      tail.appendleft(fromPt);
      starts.set(fromK, [tail, tailNum]);
    } else {
      head.append(toPt);
      ends.set(toK, [head, headNum]);
    }
  }
  return [...contours.keys()].sort((a, b) => a - b)
    .map((n) => contours.get(n).toArray());
}

/** skimage find_contours(image, level): list of (row, col) point arrays. */
export function findContours(data, rows, cols, level,
  fullyConnected = "low", positiveOrientation = "low") {
  const contours = assembleContours(
    getContourSegments(data, rows, cols, level, fullyConnected === "high"));
  if (positiveOrientation === "high") return contours.map((c) => c.reverse());
  return contours;
}
