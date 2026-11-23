/**
 * The generator works on a fine grid of cells laid over each floor's footprint.
 *
 * A local frame turns the plan so that the footprint's main wall direction lines up with the
 * grid axes and the street (the lot's main road) is towards +y ("front"). For footprints drawn on
 * the 1 m grid this is a quarter turn, so cell edges land on whole quarter metres in the plan.
 * Each cell records how much of it lies inside the floor's wall line (0–1), which lets diagonal
 * and irregular outlines be handled exactly: walls are later clipped to the real polygon.
 */
import { rotatePoint, clipPolygonToBox, polygonArea, polygonCentroid, dist, type Vec2 } from '@shared/util/geometry';

export const CELL = 0.25;

export interface Frame { angle: number; origin: Vec2 }
export interface Grid { x0: number; y0: number; nx: number; ny: number }

const clean = (v: number) => Math.round(v * 1e9) / 1e9;
export const toLocal = (f: Frame, p: Vec2): Vec2 => {
  const q = rotatePoint([p[0] - f.origin[0], p[1] - f.origin[1]], f.angle);
  return [clean(q[0]), clean(q[1])];
};
export const toPlan = (f: Frame, q: Vec2): Vec2 => {
  const p = rotatePoint(q, -f.angle);
  return [clean(p[0] + f.origin[0]), clean(p[1] + f.origin[1])];
};
/** Rotate a direction (no translation). */
export const dirToLocal = (f: Frame, v: Vec2): Vec2 => rotatePoint(v, f.angle);

/** Main wall direction of a polygon, in degrees within (-45, 45]: the length-weighted mean of edge angles modulo 90°. */
export function dominantAngle(poly: Vec2[]): number {
  let s = 0, c = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const L = dist(p, q);
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]) * 4;
    s += L * Math.sin(a); c += L * Math.cos(a);
  }
  if (Math.abs(s) < 1e-9 && Math.abs(c) < 1e-9) return 0;
  let deg = (Math.atan2(s, c) * 180) / Math.PI / 4;
  if (Math.abs(deg) < 1e-6) deg = 0;
  return deg <= -45 ? deg + 90 : deg;
}

/**
 * Local frame for a footprint: grid-aligned with its walls, street (`front`, a plan direction
 * pointing from the building towards the road) mapped to +y.
 */
export function chooseFrame(poly: Vec2[], front?: Vec2 | null): Frame {
  const phi = dominantAngle(poly);
  let best = -phi, bs = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = -phi + k * 90;
    const score = front ? rotatePoint(front, a)[1] : k === 0 ? 1 : 0;
    if (score > bs + 1e-9) { bs = score; best = a; }
  }
  const angle = ((best % 360) + 540) % 360 - 180;
  const origin: Vec2 = Math.abs(phi) < 1e-6 ? [0, 0] : (polygonCentroid(poly).map((v) => Math.round(v)) as Vec2);
  return { angle, origin };
}

/** A grid covering a local polygon, with lines on whole multiples of the cell size. */
export function gridFor(polyLocal: Vec2[]): Grid {
  const xs = polyLocal.map((p) => p[0]), ys = polyLocal.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) / CELL - 1e-6) * CELL, y0 = Math.floor(Math.min(...ys) / CELL - 1e-6) * CELL;
  return { x0, y0, nx: Math.ceil((Math.max(...xs) - x0) / CELL - 1e-6), ny: Math.ceil((Math.max(...ys) - y0) / CELL - 1e-6) };
}

/** Share (0–1) of every cell inside the polygon. */
export function coverage(polyLocal: Vec2[], g: Grid): Float64Array {
  const out = new Float64Array(g.nx * g.ny);
  const xs = polyLocal.map((p) => p[0]), ys = polyLocal.map((p) => p[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const full = CELL * CELL;
  for (let j = 0; j < g.ny; j++) {
    const y0 = g.y0 + j * CELL, y1 = y0 + CELL;
    if (y1 <= by0 || y0 >= by1) continue;
    for (let i = 0; i < g.nx; i++) {
      const x0 = g.x0 + i * CELL, x1 = x0 + CELL;
      if (x1 <= bx0 || x0 >= bx1) continue;
      const piece = clipPolygonToBox(polyLocal, x0, y0, x1, y1);
      if (piece.length >= 3) out[j * g.nx + i] = Math.min(1, polygonArea(piece) / full);
    }
  }
  return out;
}

export const cellX = (g: Grid, i: number) => g.x0 + i * CELL;
export const cellY = (g: Grid, j: number) => g.y0 + j * CELL;
export const cellCentre = (g: Grid, k: number): Vec2 => [g.x0 + ((k % g.nx) + 0.5) * CELL, g.y0 + (Math.floor(k / g.nx) + 0.5) * CELL];
