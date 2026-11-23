/**
 * The building envelope: the hierarchy  Lot ⊇ Ground floor ⊇ Level 2 ⊇ Level 3 …
 *
 * User-defined geometry is the lot, the number of floors and each floor's footprint (the outer
 * face of its outside walls). Rooms always sit inside their floor's footprint: the outside walls
 * run along the footprint with their outer face on it, so their centre line (the "wall line") is
 * the footprint pulled in by half a wall. Everything here is pure and shared by the setup flow,
 * the workspace editor and the generator.
 */
import type { PlanSpec, Floor, Wall, Opening } from './schema';
import { floorLabel } from './schema';
import {
  dist, isSimplePolygon, polygonArea, polygonInPolygon, segmentInPolygon, offsetPolygon, simplifyPolygon,
  projectOnSegment, distToBoundary, nearestOnBoundary, lineIntersection, type Vec2,
} from '@shared/util/geometry';
import { uid } from '@shared/util/id';

/** Thickness of the outside walls that follow a footprint. Their outer face sits on the footprint. */
export const ENVELOPE_T = 0.25;
/** Lot, footprint and room corners snap to this grid (metres). */
export const GRID = 1;
export const MIN_FOOTPRINT_AREA = 9;
export const MIN_LOT_AREA = 20;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r3p = (p: Vec2): Vec2 => [r3(p[0]), r3(p[1])];
const EPS = 2e-3;

/** Snap a point to the 1 m grid. */
export const snapToGrid = (p: Vec2, step = GRID): Vec2 => [r3(Math.round(p[0] / step) * step), r3(Math.round(p[1] / step) * step)];

/** Drop repeated corners (and a closing point equal to the first). */
export function cleanOutline(points: Vec2[]): Vec2[] {
  return simplifyPolygon(points.map(r3p), 1e-4);
}

/** Centre line of the outside walls: the footprint pulled in by half a wall. Rooms live inside it. */
export function wallLine(footprint: Vec2[]): Vec2[] {
  return offsetPolygon(footprint, ENVELOPE_T / 2).map(r3p);
}

export const footprintArea = (fp: Vec2[] | undefined) => (fp && fp.length >= 3 ? polygonArea(fp) : 0);

/** Floors that have a footprint, in level order. */
export const footprints = (plan: PlanSpec) => plan.floors.map((f) => f.footprint ?? null);

/** True once the lot and every floor's footprint exist (the whole envelope is defined). */
export function envelopeComplete(plan: PlanSpec): boolean {
  return !!plan.site?.boundary && plan.site.boundary.length >= 3 && plan.floors.every((f) => (f.footprint?.length ?? 0) >= 3);
}

/** What floor `idx` has to stay inside: the lot for the ground floor, the floor below otherwise. */
export function containerFor(plan: PlanSpec, idx: number): { poly: Vec2[] | null; label: string } {
  if (idx <= 0) return { poly: plan.site?.boundary ?? null, label: 'the lot' };
  const below = plan.floors[idx - 1];
  return { poly: below?.footprint ?? null, label: `the ${floorLabel(below.level).toLowerCase()}` };
}

/** Problems with a proposed footprint for floor `idx`, or null when it fits the hierarchy. */
export function checkFootprint(plan: PlanSpec, idx: number, poly: Vec2[]): string | null {
  const pts = cleanOutline(poly);
  if (pts.length < 3) return 'A footprint needs at least 3 corners';
  if (!isSimplePolygon(pts)) return 'The outline crosses itself, try again';
  if (polygonArea(pts) < MIN_FOOTPRINT_AREA) return `A floor needs at least ${MIN_FOOTPRINT_AREA} m²`;
  const here = floorLabel(plan.floors[idx]?.level ?? idx);
  const c = containerFor(plan, idx);
  if (c.poly && !polygonInPolygon(pts, c.poly)) return idx === 0 ? 'The footprint has to stay inside the lot' : `${here} has to stay inside the footprint of ${c.label}`;
  const above = plan.floors[idx + 1]?.footprint;
  if (above && !polygonInPolygon(above, pts)) return `${floorLabel(plan.floors[idx + 1].level)} sits on this floor: it has to stay inside it. Make ${floorLabel(plan.floors[idx + 1].level)} smaller first.`;
  return null;
}

/** Problems with a proposed lot outline, or null. The lot must contain the ground floor. */
export function checkLot(plan: PlanSpec, boundary: Vec2[]): string | null {
  const pts = cleanOutline(boundary);
  if (pts.length < 3) return 'A lot needs at least 3 corners';
  if (!isSimplePolygon(pts)) return 'The outline crosses itself, try again';
  if (polygonArea(pts) < MIN_LOT_AREA) return `A lot needs at least ${MIN_LOT_AREA} m²`;
  const g = plan.floors[0]?.footprint;
  if (g && !polygonInPolygon(g, pts)) return 'The ground floor has to stay inside the lot. Make the footprint smaller first.';
  return null;
}

/** Every rule of the hierarchy, for a whole plan. Empty when everything nests. */
export function hierarchyProblems(plan: PlanSpec): string[] {
  const out: string[] = [];
  plan.floors.forEach((f, i) => {
    if (!f.footprint) return;
    const c = containerFor(plan, i);
    if (c.poly && !polygonInPolygon(f.footprint, c.poly)) out.push(`${floorLabel(f.level)} is outside ${c.label}`);
    const line = wallLine(f.footprint);
    for (const w of f.walls) if (!segmentInPolygon(w.a, w.b, line, 0.01)) { out.push(`${floorLabel(f.level)} has walls outside its footprint`); break; }
  });
  return out;
}

// ---- outside walls that follow the footprint -------------------------------------------------

/** One outside wall per side of the wall line. */
export function envelopeWalls(footprint: Vec2[]): Wall[] {
  const line = wallLine(footprint);
  return line.map((p, i) => ({ id: uid('w'), a: p, b: line[(i + 1) % line.length], thickness: ENVELOPE_T, exterior: true }));
}

/** Index of the wall-line side a wall runs along, or -1. */
export function lineEdgeOf(w: Pick<Wall, 'a' | 'b'>, line: Vec2[]): number {
  for (let i = 0; i < line.length; i++) {
    const p = line[i], q = line[(i + 1) % line.length];
    if (projectOnSegment(w.a, p, q).d < EPS && projectOnSegment(w.b, p, q).d < EPS && dist(w.a, w.b) > EPS) return i;
  }
  return -1;
}

/** An outside wall that belongs to the floor's footprint (it can only change with the footprint). */
export function isEnvelopeWall(floor: Floor, w: Wall): boolean {
  return !!floor.footprint && lineEdgeOf(w, wallLine(floor.footprint)) >= 0;
}

const openingPoint = (w: Wall, o: Opening): Vec2 => {
  const len = dist(w.a, w.b) || 1;
  return [w.a[0] + ((w.b[0] - w.a[0]) * o.offset) / len, w.a[1] + ((w.b[1] - w.a[1]) * o.offset) / len];
};

/**
 * Give a floor a new footprint. Floors without walls just take it. Otherwise the outside walls are
 * rebuilt along the new wall line, inside walls that met them slide to meet them again, doors and
 * windows in the outside walls stay roughly where they were — and if any room would end up
 * outside, the change is refused. Rooms are not recomputed here (the caller does that).
 */
export function applyFootprint(floor: Floor, footprint: Vec2[]): { floor: Floor } | { error: string } {
  const fp = cleanOutline(footprint);
  const next = structuredClone(floor) as Floor;
  next.footprint = fp;
  if (!floor.walls.length) return { floor: next };
  const oldLine = floor.footprint ? wallLine(floor.footprint) : null;
  const newLine = wallLine(fp);
  const edgeOfOld = new Map<string, number>();
  if (oldLine) for (const w of floor.walls) { const e = lineEdgeOf(w, oldLine); if (e >= 0) edgeOfOld.set(w.id, e); }
  const inner = next.walls.filter((w) => !edgeOfOld.has(w.id));

  // inside walls that met an outside wall keep meeting it
  if (oldLine) {
    for (const w of inner) {
      for (const k of ['a', 'b'] as const) {
        if (distToBoundary(w[k], oldLine) > EPS) continue;
        const other = k === 'a' ? w.b : w.a;
        let best: Vec2 | null = null, bd = Infinity;
        for (let i = 0; i < newLine.length; i++) {
          const p = newLine[i], q = newLine[(i + 1) % newLine.length];
          const hit = lineIntersection(other, w[k], p, q);
          if (!hit || projectOnSegment(hit, p, q).d > 1e-6) continue;
          // only along the wall's own direction, beyond its other end
          const dir = (w[k][0] - other[0]) * (hit[0] - other[0]) + (w[k][1] - other[1]) * (hit[1] - other[1]);
          if (dir <= 0) continue;
          const d = dist(hit, w[k]);
          if (d < bd) { bd = d; best = hit; }
        }
        w[k] = r3p(best && bd < 25 ? best : nearestOnBoundary(w[k], newLine));
      }
    }
  }
  for (const w of inner) {
    if (dist(w.a, w.b) < 0.05 || !segmentInPolygon(w.a, w.b, newLine, EPS)) return { error: 'Some rooms would end up outside the footprint. Move or remove them first.' };
  }

  // rebuild the outside walls (keep ids side by side when the corner count is unchanged)
  const sameShape = oldLine && oldLine.length === newLine.length;
  const oldIdByEdge = new Map<number, string>();
  if (sameShape) for (const [id, e] of edgeOfOld) if (!oldIdByEdge.has(e)) oldIdByEdge.set(e, id);
  const env: Wall[] = newLine.map((p, i) => ({ id: oldIdByEdge.get(i) ?? uid('w'), a: p, b: newLine[(i + 1) % newLine.length], thickness: ENVELOPE_T, exterior: true }));

  // doors and windows in old outside walls move to the matching new wall
  const oldById = new Map(floor.walls.map((w) => [w.id, w]));
  const openings: Opening[] = [];
  for (const o of next.openings) {
    const e = edgeOfOld.get(o.wallId);
    if (e === undefined) { openings.push(o); continue; }
    const ow = oldById.get(o.wallId)!;
    const c = openingPoint(ow, o);
    let target = sameShape ? env[e] : null;
    if (!target) {
      let bd = Infinity;
      for (const w of env) { const d = projectOnSegment(c, w.a, w.b).d; if (d < bd) { bd = d; target = w; } }
    }
    if (!target) continue;
    const len = dist(target.a, target.b);
    if (len < o.width + 0.1) continue;
    const at = sameShape ? dist(ow.a, c) * (len / (dist(ow.a, ow.b) || 1)) : projectOnSegment(c, target.a, target.b).t * len;
    openings.push({ ...o, wallId: target.id, offset: r3(Math.min(len - o.width / 2 - 0.05, Math.max(o.width / 2 + 0.05, at))) });
  }
  next.walls = [...env, ...inner];
  next.openings = openings;
  return { floor: next };
}

/** A new storey on top of `below`: exactly the same footprint (the client can shrink it after). */
export function floorAbove(below: Floor, withWalls: boolean): Floor {
  const fp = below.footprint ? below.footprint.map((p) => [...p] as Vec2) : undefined;
  return { level: below.level + 1, height: below.height, walls: withWalls && fp ? envelopeWalls(fp) : [], rooms: [], openings: [], ...(fp ? { footprint: fp } : {}) };
}

/** Floors that need their outside walls (sketch mode, entering the workspace). */
export function withEnvelopeWalls(floor: Floor): Floor {
  if (!floor.footprint || floor.walls.length) return floor;
  return { ...floor, walls: envelopeWalls(floor.footprint) };
}
