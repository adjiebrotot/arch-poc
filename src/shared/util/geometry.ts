export type Vec2 = [number, number];

export const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point parameter t∈[0,1] on segment ab to p, plus distance. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; d: number; point: Vec2 } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return { t, d: dist(p, point), point };
}

export const snap = (v: number, step: number) => Math.round(v / step) * step;
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Shoelace sum: > 0 when the polygon runs clockwise on screen (y down). */
export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

const orient = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Proper crossing of segments ab and cd (shared end points don't count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const e = 1e-9;
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e));
}

/** True when no two non-adjacent edges cross and no edge is (near) zero length. */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) if (dist(poly[i], poly[(i + 1) % n]) < 1e-3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return Math.abs(signedArea(poly)) > 1e-6;
}

/** Intersection of the infinite lines a1a2 and b1b2 (null when parallel). */
export function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
  return [a1[0] + (a2[0] - a1[0]) * t, a1[1] + (a2[1] - a1[1]) * t];
}

/** Ear-clipping triangulation for simple polygons (indices into `poly`). */
export function triangulate(poly: Vec2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (signedArea(poly) < 0) idx.reverse();
  const out: number[] = [];
  const isEar = (i0: number, i1: number, i2: number, rest: number[]) => {
    const [ax, ay] = poly[i0], [bx, by] = poly[i1], [cx, cy] = poly[i2];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-12) return false;
    for (const j of rest) {
      if (j === i0 || j === i1 || j === i2) continue;
      const [px, py] = poly[j];
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12) return false;
    }
    return true;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      if (isEar(i0, i1, i2, idx)) { out.push(i0, i1, i2); idx.splice(k, 1); clipped = true; break; }
    }
    if (!clipped) idx.splice(0, 1); // degenerate (collinear points): drop a vertex
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** A point guaranteed to be inside a simple polygon (centroid when it is, else the biggest ear's centre). */
export function interiorPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const tris = triangulate(poly);
  let best = c, ba = -1;
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [poly[tris[t]], poly[tris[t + 1]], poly[tris[t + 2]]];
    const a = polygonArea(tri);
    if (a > ba) { ba = a; best = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3]; }
  }
  return best;
}

// ---- containment, clipping and offsets (lot ⊇ footprint ⊇ rooms) ---------------------------

/** Shortest distance from p to the polygon's outline. */
export function distToBoundary(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, projectOnSegment(p, poly[i], poly[(i + 1) % poly.length]).d);
  return d;
}

/** Nearest point on the polygon's outline. */
export function nearestOnBoundary(p: Vec2, poly: Vec2[]): Vec2 {
  let best: Vec2 = poly[0], bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const pr = projectOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (pr.d < bd) { bd = pr.d; best = pr.point; }
  }
  return best;
}

/** Inside the polygon or on its outline (within eps). */
export function pointInOrOn(p: Vec2, poly: Vec2[], eps = 1e-3): boolean {
  return pointInPolygon(p, poly) || distToBoundary(p, poly) <= eps;
}

/** Strictly inside: inside and at least eps away from the outline. */
export function pointStrictlyIn(p: Vec2, poly: Vec2[], eps = 1e-6): boolean {
  return pointInPolygon(p, poly) && distToBoundary(p, poly) > eps;
}

/** Parameters t∈(0,1) where segment ab meets the polygon outline (crossings, touches, vertices). */
function boundaryParams(a: Vec2, b: Vec2, poly: Vec2[], eps: number): number[] {
  const ts: number[] = [];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return ts;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    const pr = projectOnSegment(c, a, b);
    if (pr.d <= eps) ts.push(pr.t);
    const ex = d[0] - c[0], ey = d[1] - c[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
    const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
  }
  return ts.filter((t) => t > 1e-9 && t < 1 - 1e-9);
}

/** Segment ab lies inside the closed polygon (running along or touching the outline is fine). */
export function segmentInPolygon(a: Vec2, b: Vec2, poly: Vec2[], eps = 1e-3): boolean {
  if (!pointInOrOn(a, poly, eps) || !pointInOrOn(b, poly, eps)) return false;
  const ts = [0, ...boundaryParams(a, b, poly, eps), 1].sort((x, y) => x - y);
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-9) continue;
    const t = (ts[i] + ts[i + 1]) / 2;
    if (!pointInOrOn([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], poly, eps)) return false;
  }
  return true;
}

/** Every part of `inner` lies inside the closed polygon `outer` (shared edges and corners are fine). */
export function polygonInPolygon(inner: Vec2[], outer: Vec2[], eps = 1e-3): boolean {
  return inner.every((p, i) => segmentInPolygon(p, inner[(i + 1) % inner.length], outer, eps));
}

/** The parts of segment ab strictly inside the polygon (parts on the outline are dropped). */
export function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: Vec2[], eps = 1e-6): [Vec2, Vec2][] {
  const ts = [0, ...boundaryParams(a, b, poly, eps), 1].sort((x, y) => x - y);
  const at = (t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-9) continue;
    if (!pointStrictlyIn(at((ts[i] + ts[i + 1]) / 2), poly, eps * 10)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - ts[i]) < 1e-9) last[1] = ts[i + 1];
    else out.push([ts[i], ts[i + 1]]);
  }
  return out.map(([t0, t1]) => [at(t0), at(t1)]);
}

/** Sutherland–Hodgman: the part of `poly` inside the axis-aligned box (area-correct for any simple polygon). */
export function clipPolygonToBox(poly: Vec2[], x0: number, y0: number, x1: number, y1: number): Vec2[] {
  let out = poly;
  const edges: [(p: Vec2) => boolean, (p: Vec2, q: Vec2) => Vec2][] = [
    [(p) => p[0] >= x0, (p, q) => [x0, p[1] + ((q[1] - p[1]) * (x0 - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= x1, (p, q) => [x1, p[1] + ((q[1] - p[1]) * (x1 - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= y0, (p, q) => [p[0] + ((q[0] - p[0]) * (y0 - p[1])) / (q[1] - p[1]), y0]],
    [(p) => p[1] <= y1, (p, q) => [p[0] + ((q[0] - p[0]) * (y1 - p[1])) / (q[1] - p[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    if (!out.length) break;
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i], q = src[(i + 1) % src.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cut(p, q));
    }
  }
  return out;
}

/** Drop repeated points and points in the middle of a straight side. */
export function simplifyPolygon(poly: Vec2[], eps = 1e-6): Vec2[] {
  let pts = poly.filter((p, i) => dist(p, poly[(i + 1) % poly.length]) > eps);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.abs(orient(a, b, c)) < eps * Math.max(1, dist(a, c))) { pts = pts.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return pts;
}

/**
 * Offset a simple polygon: d > 0 moves every side inwards by d, d < 0 outwards.
 * Corners are mitred (adjacent offset sides meet), which keeps right angles square.
 */
export function offsetPolygon(poly: Vec2[], d: number): Vec2[] {
  const pts = simplifyPolygon(poly);
  const n = pts.length;
  if (n < 3) return pts;
  const s = signedArea(pts) > 0 ? 1 : -1; // y-down: > 0 runs clockwise on screen
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const len = dist(p, q) || 1;
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    const nx = -uy * s * d, ny = ux * s * d; // inward normal × d
    return [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny]] as [Vec2, Vec2];
  });
  return pts.map((p, i) => {
    const l0 = lines[(i + n - 1) % n], l1 = lines[i];
    return lineIntersection(l0[0], l0[1], l1[0], l1[1]) ?? l1[0];
  });
}

/** Rotate p by `deg` degrees clockwise on screen (y down) around `o`. */
export function rotatePoint(p: Vec2, deg: number, o: Vec2 = [0, 0]): Vec2 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const x = p[0] - o[0], y = p[1] - o[1];
  return [o[0] + x * c - y * s, o[1] + x * s + y * c];
}
