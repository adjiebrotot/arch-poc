/**
 * PlanSpec → 3D model (walls with real openings, floor slabs, glazing, doors).
 * Engine-agnostic: output is ModelData, rendered by the Babylon viewer and
 * also used to bake the sample GLB.
 */
import type { PlanSpec, Wall, RoomType } from '@shared/planspec/schema';
import { ROOM_LABELS } from '@shared/planspec/schema';
import type { ModelData, ModelElement, MaterialKey } from '@shared/model/types';
import { computeBBox } from '@shared/model/types';
import { polygonArea } from '@shared/util/geometry';

const SLAB = 0.25;

class Builder {
  p: number[] = []; n: number[] = []; i: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[], nrm: number[]) {
    const base = this.p.length / 3;
    this.p.push(...a, ...b, ...c, ...d);
    for (let k = 0; k < 4; k++) this.n.push(...nrm);
    // counter-clockwise when viewed from the normal side (right-handed)
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Oriented box: origin o (bottom centre), unit axis u (length), v (thickness), height h */
  box(o: number[], u: number[], v: number[], len: number, thick: number, y0: number, y1: number) {
    const P = (s: number, t: number, y: number) => [o[0] + u[0] * s + v[0] * t, y, o[2] + u[2] * s + v[2] * t];
    const L = len / 2, T = thick / 2;
    const c = [P(-L, -T, 0), P(L, -T, 0), P(L, T, 0), P(-L, T, 0)];
    const at = (q: number[], y: number) => [q[0], y, q[2]];
    const neg = (x: number[]) => x.map((k) => -k);
    this.quad(at(c[0], y1), at(c[1], y1), at(c[2], y1), at(c[3], y1), cross3(u, v)[1] > 0 ? [0, 1, 0] : [0, 1, 0]);
    this.quad(at(c[3], y0), at(c[2], y0), at(c[1], y0), at(c[0], y0), [0, -1, 0]);
    this.quad(at(c[0], y0), at(c[1], y0), at(c[1], y1), at(c[0], y1), neg(v));
    this.quad(at(c[2], y0), at(c[3], y0), at(c[3], y1), at(c[2], y1), v);
    this.quad(at(c[1], y0), at(c[2], y0), at(c[2], y1), at(c[1], y1), u);
    this.quad(at(c[3], y0), at(c[0], y0), at(c[0], y1), at(c[3], y1), neg(u));
  }
  element(id: string, name: string, type: string, storey: string, material: MaterialKey, color: [number, number, number, number], props?: ModelElement['props']): ModelElement | null {
    if (!this.i.length) return null;
    fixWinding(this.p, this.n, this.i);
    return { id, name, type, storey, material, color, positions: new Float32Array(this.p), normals: new Float32Array(this.n), indices: new Uint32Array(this.i), props };
  }
}
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Make each triangle's winding agree with its vertex normals (CCW = front, right-handed). */
function fixWinding(p: number[], n: number[], idx: number[]) {
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const fn = cross3(e1, e2);
    if (fn[0] * n[a * 3] + fn[1] * n[a * 3 + 1] + fn[2] * n[a * 3 + 2] < 0) { idx[t + 1] = c; idx[t + 2] = b; }
  }
}

/** Ear-clipping triangulation for simple polygons. */
export function triangulate(poly: [number, number][]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n]; area += x1 * y2 - x2 * y1; }
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
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
    if (!clipped) { // degenerate (collinear points): drop a vertex
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

const FLOOR_MAT: Partial<Record<RoomType, MaterialKey>> = {
  bathroom: 'tile', ensuite: 'tile', laundry: 'tile', wc: 'tile', garage: 'concrete', kitchen: 'tile', entry: 'tile',
};

export function planToModel(plan: PlanSpec, opts: { roof?: boolean; ground?: boolean } = {}): ModelData {
  const elements: ModelElement[] = [];
  const storeys = [] as ModelData['storeys'];
  let elev = 0;
  plan.floors.forEach((f, fi) => {
    const storey = f.level === 0 ? 'Ground floor' : `Level ${f.level + 1}`;
    storeys.push({ name: storey, elevation: elev });
    const H = f.height;
    const byWall = new Map<string, typeof f.openings>();
    for (const o of f.openings) { if (!byWall.has(o.wallId)) byWall.set(o.wallId, []); byWall.get(o.wallId)!.push(o); }

    for (const w of f.walls) elements.push(...wallElements(w, byWall.get(w.id) ?? [], elev, H, storey));

    // floor slabs per room
    for (const r of f.rooms) {
      if (r.polygon.length < 3 || polygonArea(r.polygon) < 0.2) continue;
      const b = new Builder();
      const tris = triangulate(r.polygon);
      const top = elev, bot = elev - (fi === 0 ? 0.15 : SLAB);
      const base = 0;
      for (const [x, z] of r.polygon) { b.p.push(x, top, z); b.n.push(0, 1, 0); }
      b.i.push(...tris.map((t) => t + base));
      const nb = r.polygon.length;
      for (const [x, z] of r.polygon) { b.p.push(x, bot, z); b.n.push(0, -1, 0); }
      for (let t = 0; t < tris.length; t += 3) b.i.push(tris[t] + nb, tris[t + 2] + nb, tris[t + 1] + nb);
      const el = b.element(`floor-${f.level}-${r.id}`, `${r.name} floor`, 'IfcSlab', storey, FLOOR_MAT[r.type] ?? 'timber-floor', [0.8, 0.7, 0.55, 1], { room: r.name, roomType: ROOM_LABELS[r.type], area: r.area });
      if (el) elements.push(el);
    }
    elev += H + SLAB;
    if (opts.roof && fi === plan.floors.length - 1) {
      // flat roof over the whole footprint, plus a plaster ceiling below it
      const xs = f.walls.flatMap((w) => [w.a[0], w.b[0]]), zs = f.walls.flatMap((w) => [w.a[1], w.b[1]]);
      if (xs.length) {
        const [x0, x1, z0, z1] = [Math.min(...xs) - 0.4, Math.max(...xs) + 0.4, Math.min(...zs) - 0.4, Math.max(...zs) + 0.4];
        const b = new Builder();
        b.box([(x0 + x1) / 2, 0, (z0 + z1) / 2], [1, 0, 0], [0, 0, 1], x1 - x0, z1 - z0, elev - SLAB, elev - SLAB + 0.3);
        const e = b.element(`roof`, 'Roof', 'IfcRoof', storey, 'roof', [0.3, 0.3, 0.3, 1]);
        if (e) elements.push(e);
        const cb = new Builder();
        cb.box([(x0 + x1) / 2, 0, (z0 + z1) / 2], [1, 0, 0], [0, 0, 1], x1 - x0 - 0.8, z1 - z0 - 0.8, elev - SLAB - 0.02, elev - SLAB);
        const ce = cb.element('ceiling', 'Ceiling', 'IfcCovering', storey, 'plaster', [0.95, 0.95, 0.94, 1]);
        if (ce) elements.push(ce);
      }
    }
  });
  if (opts.ground) {
    const bb = computeBBox(elements);
    const b = new Builder();
    const cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
    b.box([cx, 0, cz], [1, 0, 0], [0, 0, 1], 60, 60, -0.3, -0.02);
    const e = b.element('site', 'Garden', 'IfcSite', 'Site', 'grass', [0.4, 0.55, 0.3, 1]);
    if (e) elements.push(e);
  }
  return { id: plan.meta.id ?? 'plan', name: plan.meta.title, source: 'plan', storeys, elements, bbox: computeBBox(elements) };
}

function wallElements(w: Wall, openings: PlanSpec['floors'][number]['openings'], elev: number, H: number, storey: string): ModelElement[] {
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  if (len < 0.01) return [];
  const u = [(w.b[0] - w.a[0]) / len, 0, (w.b[1] - w.a[1]) / len];
  const v = [-u[2], 0, u[0]];
  const ext = w.thickness / 2;
  const at = (s: number) => [w.a[0] + u[0] * s, 0, w.a[1] + u[2] * s];
  const ops = [...openings].sort((a, b) => a.offset - b.offset).map((o) => ({ ...o, s0: Math.max(0, o.offset - o.width / 2), s1: Math.min(len, o.offset + o.width / 2) }));
  const wall = new Builder();
  const glass = new Builder();
  const frame = new Builder();
  const door = new Builder();
  let s = -ext;
  const piece = (a: number, b: number, y0: number, y1: number) => {
    if (b - a < 0.005 || y1 - y0 < 0.005) return;
    wall.box(at((a + b) / 2), u, v, b - a, w.thickness, elev + y0, elev + y1);
  };
  for (const o of ops) {
    piece(s, o.s0, 0, H);
    const sill = o.type === 'window' ? o.sill ?? 0.9 : 0;
    const head = Math.min(H, sill + o.height);
    piece(o.s0, o.s1, 0, sill);
    piece(o.s0, o.s1, head, H);
    const mid = at((o.s0 + o.s1) / 2);
    if (o.type === 'window') {
      glass.box(mid, u, v, o.s1 - o.s0, 0.02, elev + sill, elev + head);
      frame.box(mid, u, v, o.s1 - o.s0, w.thickness * 0.9, elev + sill - 0.03, elev + sill);
      frame.box(at(o.s0 + 0.025), u, v, 0.05, 0.08, elev + sill, elev + head);
      frame.box(at(o.s1 - 0.025), u, v, 0.05, 0.08, elev + sill, elev + head);
      frame.box(mid, u, v, o.s1 - o.s0, 0.08, elev + head - 0.05, elev + head);
    } else if (o.width < 1.3) {
      // door leaf, opened ~70° into the room on the +v side
      const ang = (70 * Math.PI) / 180;
      const du = [u[0] * Math.cos(ang) + v[0] * Math.sin(ang), 0, u[2] * Math.cos(ang) + v[2] * Math.sin(ang)];
      const dv = [-du[2], 0, du[0]];
      const hinge = at(o.s0);
      const lw = o.s1 - o.s0 - 0.02;
      door.box([hinge[0] + du[0] * lw / 2 + v[0] * ext, 0, hinge[2] + du[2] * lw / 2 + v[2] * ext], du, dv, lw, 0.04, elev, elev + head - 0.01);
    }
    s = o.s1;
  }
  piece(s, len + ext, 0, H);
  const props = { length: Math.round(len * 100) / 100, thickness: w.thickness, exterior: w.exterior };
  return [
    wall.element(`wall-${w.id}`, w.exterior ? 'Exterior wall' : 'Interior wall', 'IfcWall', storey, w.exterior ? 'exterior' : 'plaster', [0.95, 0.94, 0.92, 1], props),
    glass.element(`glass-${w.id}`, 'Window glazing', 'IfcWindow', storey, 'glass', [0.6, 0.75, 0.85, 0.25]),
    frame.element(`frame-${w.id}`, 'Window frame', 'IfcWindow', storey, 'metal', [0.2, 0.2, 0.2, 1]),
    door.element(`door-${w.id}`, 'Door', 'IfcDoor', storey, 'timber', [0.6, 0.45, 0.3, 1]),
  ].filter((e): e is ModelElement => !!e);
}
