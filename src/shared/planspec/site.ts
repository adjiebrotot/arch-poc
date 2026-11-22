/**
 * Lot (site) geometry: the lot polygon, which sides face a road, the main
 * entrance, and compass bearings. Pure functions, shared by the workspace
 * editor, SVG export and the 3D preview.
 *
 * Plan coordinates are metres with x → right and y → down (screen). North is
 * `site.northAngle` degrees clockwise from screen-up.
 */
import type { PlanSpec, Site, Road, Floor } from './schema';
import { signedArea, projectOnSegment, dist, polygonArea, type Vec2 } from '@shared/util/geometry';

export const DEFAULT_ROAD_WIDTH = 6;
export const VERGE = 1.5;
export type RoadPreset = 'single' | 'corner' | 'double';
export type Side = 'left' | 'right';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function rectBoundary(x: number, y: number, w: number, d: number): Vec2[] {
  return [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
}

/** Bounding box of a point list. */
export function bounds(pts: Vec2[]) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/**
 * Fill in the polygon, roads and entrance for plans saved before lots were
 * polygons (they only had width × depth, drawn at (-4, -6)).
 */
export function normalizeSite(site: Site | undefined, floors: Floor[] = []): Site {
  let s: Site;
  if (!site) {
    const pts = floors.flatMap((f) => f.walls.flatMap((w) => [w.a, w.b]));
    const b = pts.length ? bounds(pts) : { x: 0, y: 0, w: 12, h: 18 };
    s = { width: b.w + 8, depth: b.h + 12, northAngle: 0, boundary: rectBoundary(b.x - 4, b.y - 6, b.w + 8, b.h + 12) };
  } else {
    s = structuredClone(site);
  }
  if (!s.boundary || s.boundary.length < 3) s.boundary = rectBoundary(-4, -6, s.width, s.depth);
  const n = s.boundary.length;
  s.roads = (s.roads ?? [{ edge: Math.min(2, n - 1) }]).filter((r) => r.edge < n);
  if (s.entrance && s.entrance.edge >= n) s.entrance = undefined;
  if (s.roads.length && (!s.entrance || !s.roads.some((r) => r.edge === s.entrance!.edge))) {
    s.entrance = { edge: s.roads[0].edge, t: 0.5 };
    const door = frontDoor(floors[0], s.boundary, s.roads[0].edge);
    if (door) s.entrance.t = r3(projectOnSegment(door, ...edgeOf(s.boundary, s.roads[0].edge)).t);
  }
  if (!s.roads.length) s.entrance = undefined;
  syncSize(s);
  return s;
}

/** Make sure a plan has a full site (mutates and returns the plan). */
export function ensureSite(plan: PlanSpec): PlanSpec {
  plan.site = normalizeSite(plan.site, plan.floors);
  return plan;
}

export function syncSize(s: Site) {
  if (!s.boundary?.length) return;
  const b = bounds(s.boundary);
  s.width = Math.round(b.w * 10) / 10;
  s.depth = Math.round(b.h * 10) / 10;
}

/** The exterior door closest to a lot edge (best guess for the front door). */
function frontDoor(f: Floor | undefined, boundary: Vec2[], edge: number): Vec2 | null {
  if (!f) return null;
  const walls = new Map(f.walls.map((w) => [w.id, w]));
  const [a, b] = edgeOf(boundary, edge);
  let best: Vec2 | null = null, bd = Infinity;
  for (const o of f.openings) {
    const w = walls.get(o.wallId);
    if (o.type !== 'door' || !w?.exterior) continue;
    const len = dist(w.a, w.b) || 1;
    const p: Vec2 = [w.a[0] + ((w.b[0] - w.a[0]) * o.offset) / len, w.a[1] + ((w.b[1] - w.a[1]) * o.offset) / len];
    const d = projectOnSegment(p, a, b).d;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---- edges ---------------------------------------------------------------------------------

export function edgeOf(poly: Vec2[], i: number): [Vec2, Vec2] {
  return [poly[mod(i, poly.length)], poly[mod(i + 1, poly.length)]];
}

export function edgeLength(poly: Vec2[], i: number): number {
  return dist(...edgeOf(poly, i));
}

/** Unit normal of edge i pointing out of the lot. */
export function outwardNormal(poly: Vec2[], i: number): Vec2 {
  const [a, b] = edgeOf(poly, i);
  const len = dist(a, b) || 1;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  // y-down screen: a clockwise-on-screen polygon (signedArea > 0) has its outside on the left of travel
  return signedArea(poly) > 0 ? [uy, -ux] : [-uy, ux];
}

export function edgeMid(poly: Vec2[], i: number): Vec2 {
  const [a, b] = edgeOf(poly, i);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** The road edge holding the entrance (or the first road). */
export function frontEdge(s: Site): number | null {
  if (s.entrance && s.roads?.some((r) => r.edge === s.entrance!.edge)) return s.entrance.edge;
  return s.roads?.[0]?.edge ?? null;
}

const score = (poly: Vec2[], i: number, dir: Vec2) => {
  const n = outwardNormal(poly, i);
  return (n[0] * dir[0] + n[1] * dir[1]) * Math.min(1, edgeLength(poly, i) / 4);
};

/** The side most opposite the front (the "back" of the lot). */
export function backEdge(poly: Vec2[], front: number): number {
  const nf = outwardNormal(poly, front);
  let best = -1, bs = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    if (i === front) continue;
    const s = score(poly, i, [-nf[0], -nf[1]]);
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/** The side on the left or right, as seen standing on the front road looking into the lot. */
export function sideEdge(poly: Vec2[], front: number, side: Side): number {
  const nf = outwardNormal(poly, front);
  const look: Vec2 = [-nf[0], -nf[1]];
  // rotate the view direction 90° clockwise on screen (y down) for "right"
  const right: Vec2 = [-look[1], look[0]];
  const dir: Vec2 = side === 'right' ? right : [-right[0], -right[1]];
  let best = -1, bs = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    if (i === front) continue;
    const s = score(poly, i, dir);
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/** Which preset (if any) the current roads match. */
export function detectPreset(s: Site): { preset: RoadPreset | 'custom'; side?: Side } {
  const poly = s.boundary!, roads = s.roads ?? [];
  const f = frontEdge(s);
  if (f === null) return { preset: 'custom' };
  const set = new Set(roads.map((r) => r.edge));
  if (set.size === 1) return { preset: 'single' };
  if (set.size === 2) {
    if (set.has(backEdge(poly, f))) return { preset: 'double' };
    for (const side of ['left', 'right'] as const) if (set.has(sideEdge(poly, f, side))) return { preset: 'corner', side };
  }
  return { preset: 'custom' };
}

/** Roads for a preset, keeping the current front road (and names/widths where the edge stays a road). */
export function applyPreset(s: Site, preset: RoadPreset, side: Side = 'right', front = frontEdge(s) ?? 0): Site {
  const poly = s.boundary!;
  const edges = [front];
  if (preset === 'corner') edges.push(sideEdge(poly, front, side));
  if (preset === 'double') edges.push(backEdge(poly, front));
  const old = new Map((s.roads ?? []).map((r) => [r.edge, r]));
  const roads: Road[] = [...new Set(edges.filter((e) => e >= 0))].map((e) => old.get(e) ?? { edge: e });
  const entrance = s.entrance?.edge === front ? s.entrance : { edge: front, t: 0.5 };
  return { ...s, roads, entrance };
}

export function toggleRoad(s: Site, edge: number): Site {
  const roads = s.roads ?? [];
  const has = roads.some((r) => r.edge === edge);
  const next = has ? roads.filter((r) => r.edge !== edge) : [...roads, { edge }].sort((a, b) => a.edge - b.edge);
  let entrance = s.entrance;
  if (has && entrance?.edge === edge) entrance = next[0] ? { edge: next[0].edge, t: 0.5 } : undefined;
  if (!has && !entrance) entrance = { edge, t: 0.5 };
  return { ...s, roads: next, entrance };
}

/** Place the entrance at the road-side point nearest p. */
export function entranceNear(s: Site, p: Vec2): Site['entrance'] {
  const poly = s.boundary!;
  let best: Site['entrance'] = s.entrance, bd = Infinity;
  for (const r of s.roads ?? []) {
    const [a, b] = edgeOf(poly, r.edge);
    const pr = projectOnSegment(p, a, b);
    if (pr.d < bd) { bd = pr.d; best = { edge: r.edge, t: r3(Math.min(0.97, Math.max(0.03, pr.t))) }; }
  }
  return best;
}

export function entrancePoint(s: Site): { p: Vec2; n: Vec2 } | null {
  if (!s.entrance || !s.boundary) return null;
  const [a, b] = edgeOf(s.boundary, s.entrance.edge);
  const t = s.entrance.t;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n: outwardNormal(s.boundary, s.entrance.edge) };
}

// ---- editing the polygon (keeps road / entrance edge indices valid) --------------------------

/** Insert a vertex on edge i (it becomes index i + 1). Both halves of a road stay road. */
export function insertVertex(s: Site, i: number, p: Vec2): Site {
  const poly = s.boundary!;
  const [a, b] = edgeOf(poly, i);
  const split = projectOnSegment(p, a, b).t;
  const boundary = [...poly.slice(0, i + 1), [r3(p[0]), r3(p[1])] as Vec2, ...poly.slice(i + 1)];
  const roads: Road[] = [];
  for (const r of s.roads ?? []) {
    if (r.edge < i) roads.push(r);
    else if (r.edge === i) roads.push(r, { ...r, edge: i + 1 });
    else roads.push({ ...r, edge: r.edge + 1 });
  }
  let entrance = s.entrance;
  if (entrance) {
    if (entrance.edge > i) entrance = { ...entrance, edge: entrance.edge + 1 };
    else if (entrance.edge === i) {
      entrance = entrance.t < split
        ? { edge: i, t: r3(entrance.t / (split || 1)) }
        : { edge: i + 1, t: r3((entrance.t - split) / (1 - split || 1)) };
    }
  }
  const out = { ...s, boundary, roads, entrance };
  syncSize(out);
  return out;
}

/** Remove vertex k (≥ 4 points needed). The two sides meeting there merge; the result is a road if either was. */
export function removeVertex(s: Site, k: number): Site {
  const poly = s.boundary!;
  const n = poly.length;
  if (n <= 3) return s;
  const ent = entrancePoint(s)?.p;
  const boundary = poly.filter((_, i) => i !== k);
  // new edge j starts at old vertex src[j]
  const src = poly.map((_, i) => i).filter((i) => i !== k);
  const wasRoad = new Map((s.roads ?? []).map((r) => [r.edge, r]));
  const roads: Road[] = [];
  src.forEach((start, j) => {
    const end = src[(j + 1) % src.length];
    const covered = start < end ? Array.from({ length: end - start }, (_, q) => start + q) : [...Array.from({ length: n - start }, (_, q) => start + q), ...Array.from({ length: end }, (_, q) => q)];
    const r = covered.map((e) => wasRoad.get(e)).find(Boolean);
    if (r) roads.push({ ...r, edge: j });
  });
  const out: Site = { ...s, boundary, roads, entrance: undefined };
  if (ent && roads.length) out.entrance = entranceNear(out, ent);
  syncSize(out);
  return out;
}

/** Replace the whole outline; one road on the side nearest the old entrance. */
export function replaceBoundary(s: Site, boundary: Vec2[]): Site {
  const ent = entrancePoint(s)?.p ?? edgeMid(boundary, 0);
  let edge = 0, bd = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const d = projectOnSegment(ent, ...edgeOf(boundary, i)).d;
    if (d < bd) { bd = d; edge = i; }
  }
  const out: Site = { ...s, boundary: boundary.map((p) => [r3(p[0]), r3(p[1])] as Vec2), roads: [{ ...(s.roads?.[0] ?? {}), edge }], entrance: { edge, t: 0.5 } };
  syncSize(out);
  return out;
}

export function lotArea(s: Site): number {
  return s.boundary ? polygonArea(s.boundary) : s.width * s.depth;
}

// ---- roads as drawable geometry -------------------------------------------------------------

export interface RoadShape {
  edge: number;
  name: string;
  width: number;
  /** footpath / verge strip right along the lot side */
  verge: Vec2[];
  /** carriageway, extended past the lot corners so corner roads meet */
  asphalt: Vec2[];
  centre: [Vec2, Vec2];
  label: Vec2;
  /** text rotation in degrees, kept upright */
  labelAngle: number;
  main: boolean;
}

export function roadShapes(s: Site): RoadShape[] {
  const poly = s.boundary;
  if (!poly) return [];
  const main = frontEdge(s);
  return (s.roads ?? []).filter((r) => r.edge < poly.length).map((r, k) => {
    const [a, b] = edgeOf(poly, r.edge);
    const n = outwardNormal(poly, r.edge);
    const len = dist(a, b) || 1;
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const W = r.width ?? DEFAULT_ROAD_WIDTH;
    const ext = W + VERGE;
    const at = (s0: number, off: number): Vec2 => [a[0] + u[0] * s0 + n[0] * off, a[1] + u[1] * s0 + n[1] * off];
    let ang = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return {
      edge: r.edge,
      name: r.name || (r.edge === main ? 'Main road' : `Road ${k + 1}`),
      width: W,
      verge: [at(0, 0), at(len, 0), at(len, VERGE), at(0, VERGE)],
      asphalt: [at(-ext, VERGE), at(len + ext, VERGE), at(len + ext, VERGE + W), at(-ext, VERGE + W)],
      centre: [at(-ext, VERGE + W / 2), at(len + ext, VERGE + W / 2)],
      label: at(len / 2, VERGE + W / 2),
      labelAngle: ang,
      main: r.edge === main,
    };
  });
}

// ---- compass ----------------------------------------------------------------------------------

const POINTS = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
const SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass bearing (0 = north, clockwise) of a plan direction, given the plan's north angle. */
export function bearingOf(dir: Vec2, northAngle: number): number {
  const screen = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI;
  return mod(screen - northAngle, 360);
}

export function bearingName(b: number, short = false): string {
  const i = mod(Math.round(b / 45), 8);
  return short ? SHORT[i] : POINTS[i];
}

/** North angle that makes a plan direction face a given compass bearing. */
export function northForFacing(dir: Vec2, bearing: number): number {
  const screen = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI;
  return mod(Math.round(screen - bearing), 360);
}

/** "faces South" label for lot edge i. */
export function edgeFacing(s: Site, i: number, short = false): string {
  return bearingName(bearingOf(outwardNormal(s.boundary!, i), s.northAngle), short);
}

export const COMPASS_POINTS = SHORT.map((label, i) => ({ label, name: POINTS[i], bearing: i * 45 }));

/** +1 when the polygon runs clockwise on screen, else -1. */
export const signedAreaSign = (poly: Vec2[]) => (signedArea(poly) >= 0 ? 1 : -1);
