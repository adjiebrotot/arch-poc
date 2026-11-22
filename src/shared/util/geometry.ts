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
