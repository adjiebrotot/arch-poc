/**
 * Procedural floor plans inside the client's own envelope ("Start from a template" and
 * "Just tell us").
 *
 * The client defines the lot, the number of floors and every floor's footprint. Those are hard
 * boundaries: this generator only solves the inside. It never resizes or squares off a footprint;
 * it adapts the programme and the arrangement to whatever polygon it is given (L, T, U, notched,
 * diagonal sides…).
 *
 * How, per floor (see raster.ts for the grid):
 *  1. A hallway spine runs through the footprint, chosen so every part of the floor is within
 *     reach of it, the street side gets the public rooms and the quiet side the private ones.
 *     Wings that are still out of reach get a branch hallway.
 *  2. On multi-storey homes the stairs sit beside the spine, inside the smallest (top) footprint,
 *     in the same place on every floor; upper-floor landings stack over the ground hallway.
 *  3. Every cell is given to the hallway side it is closest to; each side becomes a strip of rooms
 *     sliced along the hallway by target area, so every room has a door onto the hallway and most
 *     reach an outside wall for a window. The main bedroom gets an ensuite and walk-in robe; small
 *     wet rooms keep only the depth they need and their neighbour wraps round them.
 *  4. Walls are the boundaries between rooms, clipped to the exact wall line of the footprint, so
 *     rooms meet diagonal or irregular outside walls exactly. Rooms are then detected from the
 *     walls by the same openPlan3D engine the editor uses, doors go on shared walls and windows on
 *     outside walls; the front door faces the lot's entrance.
 * Several seeded candidates are scored (access, daylight, proportions, sizes, hallway share) and
 * the best distinct ones are offered. Same envelope + brief + seed ⇒ identical PlanSpec.
 */
import type { PlanSpec, Floor, Room, Wall, RoomType, Site } from '@shared/planspec/schema';
import { mulberry32 } from '@shared/util/rng';
import { dist, pointInPolygon, polygonArea, projectOnSegment, clipSegmentToPolygon, type Vec2 } from '@shared/util/geometry';
import { wallLine, ENVELOPE_T, footprintArea } from '@shared/planspec/envelope';
import { normalizeSite, frontEdge, outwardNormal, entrancePoint } from '@shared/planspec/site';
import { recomputeRooms } from '../engine/openplan3dAdapter';
import { CELL, chooseFrame, coverage, gridFor, toLocal, toPlan, cellCentre, type Frame, type Grid } from './raster';
import { buildProgram, nameRooms, SUITE, type Brief, type RoomSpec, type FloorProgram } from './program';
import { ROOM_RULES, kindOf, checkPlan, type Report } from './rules';
import { checkFeasibility, describe, EXTRAS } from './feasibility';

export type { Brief } from './program';

export interface EnvelopeFloor { level: number; height: number; footprint: Vec2[] }
export interface Envelope { site?: Site; floors: EnvelopeFloor[] }

export interface GeneratorInput extends Brief {
  envelope: Envelope;
  seed: number;
  title?: string;
  mode?: PlanSpec['meta']['mode'];
}

const INT_T = 0.1;
const DMAX = 6; // m: deepest a room should reach from its hallway
const STAIR_L = 12, STAIR_W = 9; // cells: 3.0 × 2.25 m dog-leg stair
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const STAIRS_ERR = 'There is no room for stairs that reach every floor: the top floor needs a strip about 4.5 × 3.5 m that sits over the floors below. Make the upper floors a little bigger.';

// ---------------------------------------------------------------------------------------------
// context: frame, grid and per-floor coverage (cached per envelope)
// ---------------------------------------------------------------------------------------------

interface FloorCtx {
  level: number; height: number; footprint: Vec2[];
  line: Vec2[];     // wall line (plan)
  local: Vec2[];    // wall line (local frame)
  cov: Float64Array;
  core: Uint8Array; // ≥ half a cell inside
  inner: number;    // m² inside the wall line
}
interface Ctx {
  frame: Frame; grid: Grid; floors: FloorCtx[];
  entrance: Vec2 | null; // lot entrance (plan)
  front: Vec2 | null;    // plan direction towards the main road
  site?: Site;
  cache: Map<string, unknown>;
}

const contexts = new Map<string, Ctx>();
function context(env: Envelope): Ctx {
  const key = JSON.stringify([env.floors.map((f) => f.footprint), env.site?.boundary, env.site?.roads, env.site?.entrance]);
  const hit = contexts.get(key);
  if (hit) return hit;
  const site = env.site?.boundary ? normalizeSite(env.site) : undefined;
  let front: Vec2 | null = null, entrance: Vec2 | null = null;
  const lines = env.floors.map((f) => wallLine(f.footprint));
  if (site?.boundary) {
    const fe = frontEdge(site);
    if (fe !== null) front = outwardNormal(site.boundary, fe);
    entrance = entrancePoint(site)?.p ?? null;
    if (!front && entrance) {
      const c = lines[0].reduce((s, p) => [s[0] + p[0] / lines[0].length, s[1] + p[1] / lines[0].length] as Vec2, [0, 0] as Vec2);
      const d = dist(c, entrance) || 1;
      front = [(entrance[0] - c[0]) / d, (entrance[1] - c[1]) / d];
    }
  }
  const frame = chooseFrame(lines[0], front);
  const locals = lines.map((l) => l.map((p) => toLocal(frame, p)));
  const grid = gridFor(locals.flat());
  const floors: FloorCtx[] = env.floors.map((f, i) => {
    const cov = coverage(locals[i], grid);
    const core = new Uint8Array(cov.length);
    for (let k = 0; k < cov.length; k++) core[k] = cov[k] >= 0.5 ? 1 : 0;
    return { level: f.level, height: f.height, footprint: f.footprint, line: lines[i], local: locals[i], cov, core, inner: polygonArea(lines[i]) };
  });
  const ctx: Ctx = { frame, grid, floors, entrance, front, site, cache: new Map() };
  if (contexts.size > 6) contexts.delete(contexts.keys().next().value!);
  contexts.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// bands (hallway strips) on the grid
// ---------------------------------------------------------------------------------------------

/** A straight strip of cells. axis 'x': runs along i (columns a0..a1), across rows b0..b1. */
interface Band { axis: 'x' | 'y'; a0: number; a1: number; b0: number; b1: number }
interface Rect { i0: number; i1: number; j0: number; j1: number }

const along = (g: Grid, axis: Band['axis'], k: number) => (axis === 'x' ? k % g.nx : Math.floor(k / g.nx));
const across = (g: Grid, axis: Band['axis'], k: number) => (axis === 'x' ? Math.floor(k / g.nx) : k % g.nx);
const cellAt = (g: Grid, axis: Band['axis'], a: number, c: number) => (axis === 'x' ? c * g.nx + a : a * g.nx + c);
const alongN = (g: Grid, axis: Band['axis']) => (axis === 'x' ? g.nx : g.ny);
const acrossN = (g: Grid, axis: Band['axis']) => (axis === 'x' ? g.ny : g.nx);

function bandCells(g: Grid, b: Band): number[] {
  const out: number[] = [];
  for (let a = b.a0; a <= b.a1; a++) for (let c = b.b0; c <= b.b1; c++) out.push(cellAt(g, b.axis, a, c));
  return out;
}
function rectCells(g: Grid, r: Rect): number[] {
  const out: number[] = [];
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) out.push(j * g.nx + i);
  return out;
}
const inRect = (r: Rect | null, i: number, j: number) => !!r && i >= r.i0 && i <= r.i1 && j >= r.j0 && j <= r.j1;

/** Runs of `along` positions where every cell of rows b0..b1 passes `ok`. */
function runs(g: Grid, axis: Band['axis'], b0: number, b1: number, ok: (k: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  const n = alongN(g, axis);
  for (let a = 0; a <= n; a++) {
    let good = a < n;
    for (let c = b0; good && c <= b1; c++) good = ok(cellAt(g, axis, a, c));
    if (good && start < 0) start = a;
    if (!good && start >= 0) { out.push([start, a - 1]); start = -1; }
  }
  return out;
}

function bfs(g: Grid, sources: number[], pass: (k: number) => boolean): Int32Array {
  const d = new Int32Array(g.nx * g.ny).fill(-1);
  const q = new Int32Array(g.nx * g.ny);
  let h = 0, t = 0;
  for (const s of sources) if (d[s] < 0) { d[s] = 0; q[t++] = s; }
  while (h < t) {
    const k = q[h++], i = k % g.nx, j = (k - i) / g.nx;
    const nb = [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, j > 0 ? k - g.nx : -1, j < g.ny - 1 ? k + g.nx : -1];
    for (const n of nb) if (n >= 0 && d[n] < 0 && pass(n)) { d[n] = d[k] + 1; q[t++] = n; }
  }
  return d;
}

// ---------------------------------------------------------------------------------------------
// spine, stairs and branches
// ---------------------------------------------------------------------------------------------

interface SpineCand { band: Band; score: number }

function spineCandidates(ctx: Ctx, h: number, tf: number | null, multi: boolean, garage: Rect | null = null): SpineCand[] {
  const key = `spines:${h}:${tf}:${multi}:${JSON.stringify(garage)}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as SpineCand[];
  const g = ctx.grid, F = ctx.floors[0], top = ctx.floors[ctx.floors.length - 1];
  const all: SpineCand[] = [];
  const minLen = Math.round(2.5 / CELL);
  for (const axis of ['x', 'y'] as const) {
    for (let b0 = 0; b0 + h - 1 < acrossN(g, axis); b0++) {
      const b1 = b0 + h - 1;
      const rs = runs(g, axis, b0, b1, (k) => !!F.core[k] && !inRect(garage, k % g.nx, Math.floor(k / g.nx)));
      if (!rs.length) continue;
      const [a0, a1] = rs.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
      if (a1 - a0 + 1 < minLen) continue;
      if (multi) {
        // the same strip must also run (at least a stair's length) through the top floor
        const tr = runs(g, axis, b0, b1, (k) => !!top.core[k]).map(([x, y]) => Math.min(y, a1) - Math.max(x, a0) + 1);
        if (!tr.length || Math.max(...tr) < STAIR_L + 2) continue;
      }
      const band: Band = { axis, a0, a1, b0, b1 };
      all.push({ band, score: scoreSpine(ctx, F, band, tf, garage) });
    }
  }
  all.sort((a, b) => b.score - a.score);
  // keep the best of each cluster of near-identical strips
  const out: SpineCand[] = [];
  for (const c of all) {
    // near-identical strips collapse to the best one, except strips that meet the garage
    const linked = garage && garageLink(g, c.band, garage);
    if (linked) c.score += 4;
    if (linked || !out.some((o) => o.band.axis === c.band.axis && Math.abs(o.band.b0 - c.band.b0) < 4)) out.push(c);
  }
  // a spine that leaves a wing out of reach is fine if a short branch serves it: rescore the
  // best few including their branches and what is still out of reach after them
  const cell2 = CELL * CELL;
  out.sort((a, b) => b.score - a.score);
  for (const c of out.slice(0, 10)) {
    const br = branchesFor(ctx, 0, c.band, null, h, garage);
    const cor = new Uint8Array(F.core.length);
    for (const b of [c.band, ...br]) for (const k of bandCells(g, b)) cor[k] = 1;
    const src: number[] = [];
    for (let k = 0; k < cor.length; k++) if (cor[k]) src.push(k);
    const free0 = (k: number) => !!F.core[k] && !inRect(garage, k % g.nx, Math.floor(k / g.nx));
    const d = bfs(g, src, free0);
    let before = 0, after = 0;
    for (let k = 0; k < cor.length; k++) if (free0(k) && !cor[k] && (d[k] < 0 || d[k] > DMAX / CELL)) after++;
    for (let k = 0; k < F.core.length; k++) {
      if (!free0(k)) continue;
      const a = along(g, c.band.axis, k), cc = across(g, c.band.axis, k);
      const dc = cc < c.band.b0 ? c.band.b0 - cc : cc > c.band.b1 ? cc - c.band.b1 : 0;
      const da = a < c.band.a0 ? c.band.a0 - a : a > c.band.a1 ? a - c.band.a1 : 0;
      if (dc + da > DMAX / CELL) before++;
    }
    const brArea = br.reduce((s2, b) => s2 + (b.a1 - b.a0 + 1) * (b.b1 - b.b0 + 1), 0) * cell2;
    c.score += (before - after) * cell2 - brArea * 0.6 - br.length * 6;
  }
  out.sort((a, b) => b.score - a.score);
  ctx.cache.set(key, out);
  return out;
}

/**
 * What reaches straight out from a hallway must be room-deep or nothing: a 0.25–2.4 m sliver
 * between the hallway and a wall is useless (it only widens the hallway or makes slivers). Its area.
 */
function sliverArea(g: Grid, b: Band, ok: (k: number) => boolean): number {
  let sliver = 0;
  const lim = acrossN(g, b.axis);
  for (let a = b.a0; a <= b.a1; a++) {
    for (const [start, step] of [[b.b0 - 1, -1], [b.b1 + 1, 1]] as const) {
      let n = 0;
      for (let c = start; c >= 0 && c < lim && ok(cellAt(g, b.axis, a, c)); c += step) n++;
      if (n > 0 && n * CELL < 2.4) sliver += n * CELL * CELL;
    }
  }
  return sliver;
}

function scoreSpine(ctx: Ctx, F: FloorCtx, b: Band, tf: number | null, garage: Rect | null = null): number {
  const g = ctx.grid;
  const D = DMAX / CELL;
  let unserved = 0, A = 0, B = 0, total = 0;
  for (let k = 0; k < F.core.length; k++) {
    if (!F.core[k] || inRect(garage, k % g.nx, Math.floor(k / g.nx))) continue;
    total++;
    const a = along(g, b.axis, k), c = across(g, b.axis, k);
    const dc = c < b.b0 ? b.b0 - c : c > b.b1 ? c - b.b1 : 0;
    const da = a < b.a0 ? b.a0 - a : a > b.a1 ? a - b.a1 : 0;
    if (dc === 0 && da === 0) continue;
    if (dc + da > D) unserved++;
    if (c < b.b0) A++; else if (c > b.b1) B++;
  }
  const cell2 = CELL * CELL, len = (b.a1 - b.a0 + 1) * CELL;
  const depthA = (A * cell2) / len, depthB = (B * cell2) / len;
  // a strip shallower than a bedroom is useless; shallower than a living room only half useful
  const thinOf = (n: number, d: number) => (n <= 0 ? 0 : d < 2.75 ? n * cell2 * 0.8 : d < 3.3 ? n * cell2 * 0.3 : 0);
  const thin = thinOf(A, depthA) + thinOf(B, depthB);
  const zone = tf === null || b.axis === 'y' || A + B === 0 ? 0 : Math.abs(B / (A + B) - tf) * (A + B) * cell2 * 0.45;
  // a strip across the short way of a wide house cuts it in two: prefer running with the frontage
  const wide = b.axis === 'y' ? Math.max(0, alongN(ctx.grid, 'x') - alongN(ctx.grid, 'y')) * CELL * 0.4 : 0;
  const hallArea = (b.a1 - b.a0 + 1) * (b.b1 - b.b0 + 1) * cell2;
  const sliver = sliverArea(g, b, (k) => !!F.core[k] && !inRect(garage, k % g.nx, Math.floor(k / g.nx)));
  return -(unserved * cell2 + thin + zone + wide + hallArea * 0.15 + sliver * 1.5) + total * 0;
}

// ---------------------------------------------------------------------------------------------
// garage: placed first, as an exact rectangle a car fits in, its door on the street side
// ---------------------------------------------------------------------------------------------

/** Garage sizes in cells: 3.25 × 6 m single, 5.75 × 6 m double (to wall centres). */
const GARAGE_CELLS = { single: [13, 24], double: [23, 24] } as const;
const GARAGE_ERR = 'There is no room for a garage: it needs a rectangle of at least 3.25 × 6 m against the street side of the ground floor. Make the ground floor wider or deeper at the front, or leave the garage out.';
interface GarageCand { rect: Rect; score: number }

/** Every place a garage fits fully inside the ground floor with its front on a street-facing outside wall. */
function garageCandidates(ctx: Ctx, size: keyof typeof GARAGE_CELLS): GarageCand[] {
  const key = `garages:${size}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as GarageCand[];
  const g = ctx.grid, F = ctx.floors[0];
  const [W, D] = GARAGE_CELLS[size];
  const full = (i: number, j: number) => i >= 0 && j >= 0 && i < g.nx && j < g.ny && F.cov[j * g.nx + i] >= 0.999;
  const outside = (i: number, j: number) => i < 0 || j < 0 || i >= g.nx || j >= g.ny || F.cov[j * g.nx + i] < 0.02;
  const P = new Int32Array((g.nx + 1) * (g.ny + 1));
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) P[(j + 1) * (g.nx + 1) + i + 1] = (full(i, j) ? 1 : 0) + P[j * (g.nx + 1) + i + 1] + P[(j + 1) * (g.nx + 1) + i] - P[j * (g.nx + 1) + i];
  const sum = (i0: number, j0: number, i1: number, j1: number) => P[(j1 + 1) * (g.nx + 1) + i1 + 1] - P[j0 * (g.nx + 1) + i1 + 1] - P[(j1 + 1) * (g.nx + 1) + i0] + P[j0 * (g.nx + 1) + i0];
  const ent = ctx.entrance ? toLocal(ctx.frame, ctx.entrance) : null;
  const out: GarageCand[] = [];
  for (let j0 = 0; j0 + D <= g.ny; j0++) {
    const j1 = j0 + D - 1;
    for (let i0 = 0; i0 + W <= g.nx; i0++) {
      const i1 = i0 + W - 1;
      if (sum(i0, j0, i1, j1) !== W * D) continue;
      let front = true;
      for (let i = i0; front && i <= i1; i++) front = outside(i, j1 + 1);
      if (!front) continue;
      let clean = true;
      const ok = (i: number, j: number) => full(i, j) || outside(i, j);
      for (let j = j0; clean && j <= j1; j++) clean = ok(i0 - 1, j) && ok(i1 + 1, j);
      for (let i = i0; clean && i <= i1; i++) clean = ok(i, j0 - 1);
      if (!clean) continue;
      // at a front corner of the house, away from where people walk in
      const corner = (outside(i0 - 1, j1) ? 3 : 0) + (outside(i1 + 1, j1) ? 3 : 0);
      const cx = g.x0 + ((i0 + i1 + 1) / 2) * CELL;
      const away = ent ? Math.min(6, Math.abs(cx - ent[0])) * 0.4 : 0;
      out.push({ rect: { i0, i1, j0, j1 }, score: corner + away });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const distinct: GarageCand[] = [];
  for (const c of out) if (!distinct.some((d) => Math.abs(d.rect.i0 - c.rect.i0) < 6)) distinct.push(c);
  ctx.cache.set(key, distinct);
  return distinct;
}

/**
 * How the garage reaches the hallway: directly (it touches the spine), by growing deeper to meet it
 * (still a rectangle, up to 7.5 m), or through a short lobby of hallway. Null when it can't.
 */
function garageLink(g: Grid, band: Band, r: Rect): { grow: number; lobby: Rect | null } | null {
  if (band.axis === 'x') {
    const overlap = Math.min(band.a1, r.i1) - Math.max(band.a0, r.i0) + 1;
    if (overlap >= 4 && band.b1 < r.j0) {
      const gap = r.j0 - band.b1 - 1;
      if (gap === 0) return { grow: 0, lobby: null };
      if (r.j1 - r.j0 + 1 + gap <= 30) return { grow: gap, lobby: null };
      if (gap <= 8) { const i0 = Math.max(band.a0, r.i0); return { grow: 0, lobby: { i0, i1: Math.min(i0 + 3, band.a1, r.i1), j0: band.b1 + 1, j1: r.j0 - 1 } }; }
      return null;
    }
    // the spine runs alongside the garage and stops at its side
    const rowsOverlap = Math.min(band.b1, r.j1) - Math.max(band.b0, r.j0) + 1;
    if (rowsOverlap >= 5 && (band.a1 + 1 === r.i0 || band.a0 - 1 === r.i1)) return { grow: 0, lobby: null };
    return null;
  }
  const rowsOverlap = Math.min(band.a1, r.j1) - Math.max(band.a0, r.j0) + 1;
  if (rowsOverlap >= 5 && (band.b1 + 1 === r.i0 || band.b0 - 1 === r.i1)) return { grow: 0, lobby: null };
  void g;
  return null;
}

interface StairsCand { rect: Rect; score: number }

/** Stairs beside the spine, inside every floor, with hallway beside them on every floor. */
function stairsFor(ctx: Ctx, band: Band, rng: () => number, livingBack: boolean, garage: Rect | null = null): Rect | null {
  const g = ctx.grid;
  const cands: StairsCand[] = [];
  const allCore = (k: number) => ctx.floors.every((f) => f.core[k]) && !inRect(garage, k % g.nx, Math.floor(k / g.nx));
  const mid = (band.a0 + band.a1) / 2;
  for (const [la, lc] of [[STAIR_L, STAIR_W], [STAIR_W, STAIR_L]]) {
    for (const side of [-1, 1]) {
      const c0 = side < 0 ? band.b0 - lc : band.b1 + 1, c1 = c0 + lc - 1;
      if (c0 < 0 || c1 >= acrossN(g, band.axis)) continue;
      for (let a = band.a0; a + la - 1 <= band.a1; a++) {
        let ok = true;
        for (let x = a; ok && x < a + la; x++) {
          for (let c = c0; ok && c <= c1; c++) ok = allCore(cellAt(g, band.axis, x, c));
          for (let c = band.b0; ok && c <= band.b1; c++) ok = allCore(cellAt(g, band.axis, x, c));
        }
        if (!ok) continue;
        const rect: Rect = band.axis === 'x' ? { i0: a, i1: a + la - 1, j0: c0, j1: c1 } : { i0: c0, i1: c1, j0: a, j1: a + la - 1 };
        // back (quiet) side on the ground floor, long side along the hallway, its far side against
        // an outside wall on every floor (so no room has to wrap round it), or at the hallway's end
        const back = band.axis === 'x' ? (side < 0) !== livingBack : false;
        const beyond = side < 0 ? c0 - 1 : c1 + 1;
        let walled = 0;
        for (let x = a; x < a + la; x++) {
          const k = beyond >= 0 && beyond < acrossN(g, band.axis) ? cellAt(g, band.axis, x, beyond) : -1;
          if (k < 0 || ctx.floors.every((f) => !f.core[k])) walled++;
          else if (ctx.floors.some((f) => !f.core[k])) walled += 0.3;
        }
        const endWall = (x: number) => { let n = 0; for (let c = c0; c <= c1; c++) { const k = x >= 0 && x < alongN(g, band.axis) ? cellAt(g, band.axis, x, c) : -1; if (k < 0 || ctx.floors.every((f) => !f.core[k])) n++; } return n === lc; };
        const atEnd = (a === band.a0 || a + la - 1 === band.a1) ? 1 + (endWall(a - 1) || endWall(a + la) ? 6 : 0) : 0;
        const score = (back ? 2 : 0) + (la === STAIR_L ? 1 : 0) + (walled / la) * 4 + atEnd - Math.abs(a + la / 2 - mid) * CELL * 0.2;
        cands.push({ rect, score });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((x, y) => y.score - x.score);
  const pool = cands.filter((c) => c.score >= cands[0].score - 2.5);
  // spread choices: pick from distinct positions
  const distinct: StairsCand[] = [];
  for (const c of pool) if (!distinct.some((d) => Math.abs(d.rect.i0 - c.rect.i0) + Math.abs(d.rect.j0 - c.rect.j0) < 8)) distinct.push(c);
  return distinct[Math.floor(rng() * Math.min(3, distinct.length))].rect;
}

/** The spine strip on another floor: the stretch of the same rows that passes the stairs. */
function bandOnFloor(ctx: Ctx, fi: number, band: Band, stairs: Rect | null): Band {
  const g = ctx.grid, F = ctx.floors[fi];
  const rs = runs(g, band.axis, band.b0, band.b1, (k) => !!F.core[k]);
  const sa0 = stairs ? (band.axis === 'x' ? stairs.i0 : stairs.j0) : band.a0;
  const sa1 = stairs ? (band.axis === 'x' ? stairs.i1 : stairs.j1) : band.a1;
  const hit = rs.find(([x, y]) => x <= sa1 && y >= sa0) ?? rs.reduce<[number, number] | null>((m, r) => (!m || r[1] - r[0] > m[1] - m[0] ? r : m), null);
  return hit ? { ...band, a0: hit[0], a1: hit[1] } : { ...band, a0: sa0, a1: sa1 };
}

/**
 * The landing on an upper floor: by default the ground floor's hallway strip carried up past the
 * stairs; on an upper floor of a different shape, another strip that opens onto the stairs (which
 * are in the same place on every floor) when it serves that floor clearly better. Never a corridor
 * along an outside wall: rooms on both sides.
 */
function upperBand(ctx: Ctx, fi: number, spine: Band, stairs: Rect, h: number, nRooms: number): Band {
  const g = ctx.grid, F = ctx.floors[fi];
  const base = bandOnFloor(ctx, fi, spine, stairs);
  const okCell = (k: number) => !!F.core[k] && !inRect(stairs, k % g.nx, Math.floor(k / g.nx));
  // bedrooms come out of a side as slices along the landing: too deep for their width, or too
  // shallow for a bed, is what makes a landing wrong for this floor
  const score = (b: Band) => {
    const lim = acrossN(g, b.axis);
    const sides = [[b.b0 - 1, -1], [b.b1 + 1, 1]].map(([start, step]) => {
      const lens: number[] = [];
      for (let a = b.a0; a <= b.a1; a++) {
        let n = 0;
        for (let c = start; c >= 0 && c < lim && okCell(cellAt(g, b.axis, a, c)); c += step) n++;
        if (n) lens.push(n);
      }
      lens.sort((x, y) => x - y);
      return { area: lens.reduce((x, y) => x + y, 0) * CELL * CELL, d: lens.length ? lens[lens.length >> 1] * CELL : 0, L: lens.length * CELL };
    });
    const total = sides[0].area + sides[1].area || 1;
    let pen = (b.a1 - b.a0 + 1) * (b.b1 - b.b0 + 1) * CELL * CELL * 0.15;
    for (const sd of sides) {
      if (!sd.area) continue;
      const rooms = Math.max(1, Math.round((nRooms * sd.area) / total));
      const w = sd.L / rooms;
      pen += Math.max(0, sd.d / Math.max(w, 0.5) - 1.8) * sd.area * 0.4 + (sd.d < 2.7 ? sd.area * 0.8 : 0) + Math.max(0, sd.d - DMAX) * sd.L;
    }
    return -pen;
  };
  const twoSided = (b: Band) => {
    let both = 0;
    for (let a = b.a0; a <= b.a1; a++) {
      const lo = b.b0 - 1, hi = b.b1 + 1;
      const l = lo >= 0 && F.core[cellAt(g, b.axis, a, lo)], r = hi < acrossN(g, b.axis) && F.core[cellAt(g, b.axis, a, hi)];
      if (l && r) both++;
    }
    return both >= (b.a1 - b.a0 + 1) * 0.7;
  };
  let best = base, bs = score(base) + 3;
  for (const axis of ['x', 'y'] as const) {
    if (axis === base.axis) continue;
    const sa0 = axis === 'x' ? stairs.i0 : stairs.j0, sa1 = axis === 'x' ? stairs.i1 : stairs.j1;
    const sc0 = axis === 'x' ? stairs.j0 : stairs.i0, sc1 = axis === 'x' ? stairs.j1 : stairs.i1;
    for (const b0 of [sc0 - h, sc1 + 1]) {
      const b1 = b0 + h - 1;
      if (b0 < 0 || b1 >= acrossN(g, axis)) continue;
      for (const [a0, a1] of runs(g, axis, b0, b1, okCell)) {
        if (a1 - a0 + 1 < Math.round(4 / CELL) || Math.min(a1, sa1) - Math.max(a0, sa0) + 1 < 4) continue;
        const band: Band = { axis, a0, a1, b0, b1 };
        if (!twoSided(band)) continue;
        const sc = score(band);
        if (sc > bs) { bs = sc; best = band; }
      }
    }
  }
  return best;
}

/** Extra hallways into wings the spine can't reach (at most two). */
function branchesFor(ctx: Ctx, fi: number, spine: Band, stairs: Rect | null, h: number, garage: Rect | null = null): Band[] {
  const key = `branches:${fi}:${JSON.stringify(spine)}:${JSON.stringify(stairs)}:${h}:${fi === 0 ? JSON.stringify(garage) : ''}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) as Band[];
  const g = ctx.grid, F = ctx.floors[fi];
  const blocked = (k: number) => inRect(stairs, k % g.nx, Math.floor(k / g.nx)) || (fi === 0 && inRect(garage, k % g.nx, Math.floor(k / g.nx)));
  const out: Band[] = [];
  const corridor = new Uint8Array(F.core.length);
  for (const k of bandCells(g, spine)) corridor[k] = 1;
  const D = DMAX / CELL;
  const unservedOf = (cor: Uint8Array) => {
    const src: number[] = [];
    for (let k = 0; k < cor.length; k++) if (cor[k]) src.push(k);
    const d = bfs(g, src, (k) => !!F.core[k] && !blocked(k));
    const un: number[] = [];
    for (let k = 0; k < cor.length; k++) if (F.core[k] && !blocked(k) && !cor[k] && (d[k] < 0 || d[k] > D)) un.push(k);
    return un;
  };
  const skip = new Set<number>();
  for (let round = 0; round < 3 && out.length < 2; round++) {
    const un = unservedOf(corridor).filter((k) => !skip.has(k));
    if (un.length * CELL * CELL < 6) break;
    // the largest connected wing
    const set = new Set(un);
    const seen = new Set<number>();
    let comp: number[] = [];
    for (const s of un) {
      if (seen.has(s)) continue;
      const c: number[] = [];
      const st = [s];
      seen.add(s);
      while (st.length) {
        const k = st.pop()!;
        c.push(k);
        const i = k % g.nx;
        for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) if (n >= 0 && n < F.core.length && set.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
      }
      if (c.length > comp.length) comp = c;
    }
    if (comp.length * CELL * CELL < 6) break;
    // a long strip beside the spine is just a deep side (its rooms get deeper), not a wing
    const ext = (axis: Band['axis'], f: typeof along) => { const v = comp.map((k) => f(g, axis, k)); return Math.max(...v) - Math.min(...v) + 1; };
    if (ext(spine.axis, along) > 1.3 * ext(spine.axis, across)) { for (const k of comp) skip.add(k); continue; }
    let best: { band: Band; score: number } | null = null;
    for (const axis of ['x', 'y'] as const) {
      const cs = comp.map((k) => across(g, axis, k));
      const lo = Math.min(...cs), hi = Math.max(...cs);
      const as = comp.map((k) => along(g, axis, k));
      const alo = Math.min(...as), ahi = Math.max(...as);
      for (let c0 = lo - h + 1; c0 <= hi; c0++) {
        const c1 = c0 + h - 1;
        if (c0 < 0 || c1 >= acrossN(g, axis)) continue;
        for (const [r0, r1] of runs(g, axis, c0, c1, (k) => !!F.core[k] && !blocked(k) && !corridor[k])) {
          if (r1 < alo || r0 > ahi) continue;
          const touches = (a: number) => {
            if (a < 0 || a >= alongN(g, axis)) return false;
            let n = 0;
            for (let c = c0; c <= c1; c++) n += corridor[cellAt(g, axis, a, c)];
            return n >= Math.min(2, h);
          };
          const endRoom = Math.round(3 / CELL);
          let band: Band | null = null;
          if (touches(r0 - 1)) band = { axis, b0: c0, b1: c1, a0: r0, a1: Math.min(r1, Math.max(r0 + 3, ahi - endRoom)) };
          else if (touches(r1 + 1)) band = { axis, b0: c0, b1: c1, a0: Math.max(r0, Math.min(r1 - 3, alo + endRoom)), a1: r1 };
          if (!band || band.a1 - band.a0 < 3) continue;
          const test = corridor.slice();
          for (const k of bandCells(g, band)) test[k] = 1;
          const left = unservedOf(test).length;
          // sides of the wing beside the branch should be either empty or room-deep
          const wl = (c0 - lo) * CELL, wr = (hi - c1) * CELL;
          const thin = (wl > 0 && wl < 2.6 ? 6 : 0) + (wr > 0 && wr < 2.6 ? 6 : 0);
          const sliver = sliverArea(g, band, (k) => !!F.core[k] && !blocked(k) && !corridor[k]);
          const score = left * CELL * CELL + thin + sliver * 1.5 + (band.a1 - band.a0) * CELL * h * CELL * 0.3;
          if (!best || score < best.score) best = { band, score };
        }
      }
    }
    if (!best || best.score >= un.length * CELL * CELL * 0.85) break;
    out.push(best.band);
    for (const k of bandCells(g, best.band)) corridor[k] = 1;
  }
  ctx.cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// rooms on one floor
// ---------------------------------------------------------------------------------------------

/** A room being laid out: owner index into FloorLayout.rooms. 0 = hallway, 1 = stairs. */
interface Laid { name: string; type: RoomType; target: number; minW: number; spec?: RoomSpec }
interface FloorLayout { owner: Int16Array; rooms: Laid[]; expected: number[] }

interface Region { cells: number[]; s: Map<number, number>; depth: Map<number, number>; axis: Band['axis']; front: number; area: number }

const HALL = 0, STAIRS = 1, NONE = -1, FREE = -2;

/**
 * Narrowest a room may be along its hallway, in cells: its clear rectangle has to fit, lying
 * whichever way the strip's depth allows, and the main bedroom also needs its ensuite strip.
 */
function minAlongCells(r: Pick<RoomSpec, 'type' | 'name' | 'minW' | 'suite'>, regDepth: number): number {
  const rule = ROOM_RULES[kindOf(r)];
  const across = rule ? (regDepth >= Math.max(...rule.clear) - 0.01 ? Math.min(...rule.clear) : Math.max(...rule.clear)) : 0;
  // wide enough for its clear rectangle, and for its minimum area in this depth
  const forArea = rule && regDepth > 0 ? rule.min / regDepth : 0;
  return Math.max(1, Math.ceil((Math.max(r.minW, across, forArea) + (r.suite ? 1.75 : 0)) / CELL - 1e-6));
}

interface FixedGarage { rect: Rect; lobby: Rect | null; spec: RoomSpec }

function layoutFloor(ctx: Ctx, fi: number, program: FloorProgram, segs: Band[], stairs: Rect | null, rng: () => number, prefs: { livingBack: boolean }, garage: FixedGarage | null = null): FloorLayout {
  const g = ctx.grid, F = ctx.floors[fi], N = g.nx * g.ny;
  const owner = new Int16Array(N).fill(NONE);
  for (let k = 0; k < N; k++) if (F.cov[k] > 0.02) owner[k] = FREE;
  if (stairs) for (const k of rectCells(g, stairs)) owner[k] = STAIRS;
  const segOf = new Int16Array(N).fill(-1);
  segs.forEach((b, si) => { for (const k of bandCells(g, b)) if (F.core[k] && owner[k] === FREE) { owner[k] = HALL; if (segOf[k] < 0) segOf[k] = si; } });
  const rooms: Laid[] = [
    { name: fi === 0 ? 'Hallway' : 'Landing', type: 'hallway', target: 0, minW: 1 },
    { name: 'Stairs', type: 'stairs', target: STAIR_L * STAIR_W * CELL * CELL, minW: 2 },
  ];
  const expected: number[] = [0, 0];
  if (garage) {
    const area = (garage.rect.i1 - garage.rect.i0 + 1) * (garage.rect.j1 - garage.rect.j0 + 1) * CELL * CELL;
    const id = rooms.push({ name: 'Garage', type: 'garage', target: area, minW: 3.25, spec: garage.spec }) - 1;
    expected[id] = area;
    for (const k of rectCells(g, garage.rect)) owner[k] = id;
    if (garage.lobby) for (const k of rectCells(g, garage.lobby)) if (owner[k] === FREE && F.core[k]) owner[k] = HALL;
  }

  // ---- regions: rooms reach straight out from a hallway side, so their walls stay straight ----
  // The spine claims everything in line of sight; where a branch serves a wing, the spine stops at
  // the depth of its other rooms so the wing's rooms belong to the branch. Leftovers (past the end
  // of a hallway, round the stairs) join the nearest strip.
  const free = (k: number) => !!F.core[k] && owner[k] === FREE;
  const segAt = new Int16Array(N).fill(-1), sideAt = new Int8Array(N), sAt = new Int32Array(N), depAt = new Int32Array(N);
  /** cells no hallway side reaches directly (past a hallway's end, behind the stairs…) */
  const pocket = new Uint8Array(N);
  /** pockets cut off the deep part of a strip: they may become rooms of their own */
  const deepPocket = new Uint8Array(N);
  const claim = (k: number, si: number, side: number, sv: number, d: number) => { segAt[k] = si; sideAt[k] = side; sAt[k] = sv; depAt[k] = d; };
  segs.forEach((b, si) => {
    for (const side of [0, 1]) {
      const step = side === 0 ? -1 : 1;
      const lim = acrossN(g, b.axis);
      const lens: number[] = [];
      for (let a = b.a0; a <= b.a1; a++) {
        let n = 0;
        for (let c = side === 0 ? b.b0 - 1 : b.b1 + 1; c >= 0 && c < lim && free(cellAt(g, b.axis, a, c)) && segAt[cellAt(g, b.axis, a, c)] < 0; c += step) n++;
        lens.push(n);
      }
      // a hallway running away on this side (a branch into a wing): this one only keeps a normal
      // room depth there, the wing's rooms belong to the branch
      const branchHere = segs.some((br, j) => j !== si && br.axis !== b.axis && (side === 0 ? br.a1 < b.b0 : br.a0 > b.b1) && br.b1 >= b.a0 && br.b0 <= b.a1);
      const D = Math.round(DMAX / CELL);
      const normal = lens.filter((x) => x > 0 && x <= D).sort((x, y) => x - y);
      const cut = Math.min(Math.round(4.5 / CELL), Math.max(Math.round(2.75 / CELL), normal.length ? normal[Math.floor(normal.length / 2)] : Math.round(3.5 / CELL)));
      for (let a = b.a0; a <= b.a1; a++) {
        let n = lens[a - b.a0];
        if (branchHere && n > D) n = cut;
        for (let d = 1; d <= n; d++) claim(cellAt(g, b.axis, a, side === 0 ? b.b0 - d : b.b1 + d), si, side, a, d);
      }
    }
  });
  {
    // Leftovers (past the end of a hallway, behind the stairs, deep in a wing) are claimed in
    // straight lines too: first by continuing strips along their hallway, then outwards; only
    // what is still left joins its nearest neighbour.
    const step = (k: number, ax: Band['axis'], alongDir: boolean, d: number) => {
      const i = k % g.nx, j = (k - i) / g.nx;
      const horiz = (ax === 'x') === alongDir;
      if (horiz) return i + d >= 0 && i + d < g.nx ? k + d : -1;
      return j + d >= 0 && j + d < g.ny ? k + d * g.nx : -1;
    };
    const snapshot = () => { const out: number[] = []; for (let k = 0; k < N; k++) if (segAt[k] >= 0) out.push(k); return out.sort((a, b) => segAt[a] - segAt[b] || sideAt[a] - sideAt[b]); };
    for (const alongDir of [true, false]) {
      for (const k of snapshot()) {
        const ax = segs[segAt[k]].axis;
        for (const d of alongDir ? [-1, 1] : [sideAt[k] === 0 ? -1 : 1]) {
          let n = step(k, ax, alongDir, d), m = 1;
          while (n >= 0 && free(n) && segAt[n] < 0) { claim(n, segAt[k], sideAt[k], sAt[k], depAt[k] + (alongDir ? 0 : m++)); pocket[n] = 1; n = step(n, ax, alongDir, d); }
        }
      }
    }
    const q = snapshot();
    for (let h = 0; h < q.length; h++) {
      const k = q[h], i = k % g.nx;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
        if (n < 0 || n >= N || segAt[n] >= 0 || !free(n)) continue;
        claim(n, segAt[k], sideAt[k], sAt[k], depAt[k] + 1);
        pocket[n] = 1;
        q.push(n);
      }
    }
  }
  const labelOf = new Int32Array(N).fill(-1);
  for (let k = 0; k < N; k++) if (segAt[k] >= 0) labelOf[k] = segAt[k] * 2 + sideAt[k];
  const regions: Region[] = [];
  const done = new Uint8Array(N);
  for (let k0 = 0; k0 < N; k0++) {
    if (labelOf[k0] < 0 || done[k0]) continue;
    const lab = labelOf[k0], b = segs[Math.floor(lab / 2)];
    const cells: number[] = [];
    const st = [k0];
    done[k0] = 1;
    while (st.length) {
      const k = st.pop()!;
      cells.push(k);
      const i = k % g.nx;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) if (n >= 0 && n < N && !done[n] && labelOf[n] === lab) { done[n] = 1; st.push(n); }
    }
    const s = new Map<number, number>(), dmap = new Map<number, number>();
    let fy = 0;
    for (const k of cells) { s.set(k, sAt[k]); dmap.set(k, depAt[k]); fy += cellCentre(g, k)[1]; }
    regions.push({ cells, s, depth: dmap, axis: b.axis, front: fy / cells.length, area: cells.length * CELL * CELL });
  }

  // ---- which rooms go in which region (street side first, quiet side last) ----
  // strips too shallow for a room just widen the hallway
  for (const r of regions) {
    const span = new Set(r.s.values()).size * CELL;
    if (r.area / Math.max(span, CELL) < 1.6 && r.cells.some((k) => { const i = k % g.nx; return [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].some((n) => n >= 0 && n < N && owner[n] === HALL); })) {
      for (const k of r.cells) owner[k] = HALL;
      r.area = 0;
    }
  }
  // a region too narrow along its hallway for any room (a column beside a slanted wall…) joins a
  // neighbour as a pocket
  for (const r of regions) if (r.area > 0 && new Set(r.s.values()).size * CELL < 1.5) { for (const k of r.cells) pocket[k] = 1; r.area = 0; }
  // a strip with a much deeper part (the leg of an L): rooms take the strip's normal depth, and
  // the deep remainder becomes a room of its own behind them, not 12 m deep slices
  for (const r of regions) {
    if (r.area <= 0) continue;
    const per = new Map<number, number>();
    for (const k of r.cells) per.set(r.s.get(k)!, Math.max(per.get(r.s.get(k)!) ?? 0, r.depth.get(k)!));
    const ds = [...per.values()].sort((x, y) => x - y);
    // the strip's normal room depth: its shallower quarter, at least a bedroom's depth
    const med = Math.min(Math.round(DMAX / CELL), Math.max(Math.round(3 / CELL), ds[ds.length >> 2]));
    if (ds[ds.length - 1] - med < Math.round(3 / CELL)) continue;
    const deep = r.cells.filter((k) => r.depth.get(k)! > med && per.get(r.s.get(k)!)! - med >= Math.round(3 / CELL));
    if (deep.length * CELL * CELL < 9) continue;
    const deepSet = new Set(deep);
    for (const k of deep) { pocket[k] = 1; deepPocket[k] = 1; }
    r.cells = r.cells.filter((k) => !deepSet.has(k));
    r.area = r.cells.length * CELL * CELL;
  }
  const usable = regions.filter((r) => r.area >= 5).sort((a, b) => (prefs.livingBack && fi === 0 ? a.front - b.front : b.front - a.front));
  let seq = sequence(program.rooms, rng, prefs.livingBack && fi === 0);
  const total = usable.reduce((s, r) => s + r.area, 0);
  const span = usable.map((u) => new Set(u.s.values()).size);
  const depth = usable.map((u) => {
    const per = new Map<number, number>();
    for (const kk of u.cells) per.set(u.s.get(kk)!, (per.get(u.s.get(kk)!) ?? 0) + 1);
    const v = [...per.values()].sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)] * CELL;
  });
  const fits = (r: RoomSpec, ri: number) => { const rule = ROOM_RULES[kindOf(r)]; return !rule || depth[ri] >= Math.min(...rule.clear) - 0.01; };
  let assign: RoomSpec[][] = usable.map(() => []);
  for (let attempt = 0; ; attempt++) {
  assign = usable.map(() => []);
  const T = seq.reduce((s, r) => s + r.target, 0) || 1;
  if (segs[0].axis === 'y' && usable.length > 1 && usable.every((r) => r.axis === 'y')) {
    // strips side by side, both running front to back: fill them together so both start with
    // street-side rooms and end with the quiet ones
    // (living, kitchen and dining stay together, so the kitchen always opens onto them)
    const filled = usable.map(() => 0);
    const groups: RoomSpec[][] = [];
    for (const r of seq) {
      const last = groups[groups.length - 1];
      const living = (x: RoomSpec) => ['living', 'kitchen', 'dining'].includes(x.type) && x.name !== 'Family room';
      if (last && living(r) && living(last[last.length - 1])) last.push(r); else groups.push([r]);
    }
    for (const grp of groups) {
      const w = (grp.reduce((s2, r) => s2 + r.target, 0) / T) * total;
      let best = 0, bv = Infinity;
      usable.forEach((u, ri) => { const v = (filled[ri] + w / 2) / u.area; if (v < bv - 1e-9) { bv = v; best = ri; } });
      assign[best].push(...grp);
      filled[best] += w;
    }
  } else {
    // contiguous groups of the room sequence, one per strip (street side first), chosen so every
    // strip scales its rooms by about the same factor. Living, kitchen and dining stay in one strip;
    // a strip only gets rooms whose clear size fits its depth and whose widths fit its length.
    const R = usable.length, k = total / T;
    const blocks: RoomSpec[][] = [];
    for (const r of seq) {
      const last = blocks[blocks.length - 1];
      const living = (x: RoomSpec) => ['living', 'kitchen', 'dining'].includes(x.type) && x.name !== 'Family room';
      if (last && living(r) && living(last[last.length - 1])) last.push(r); else blocks.push([r]);
    }
    const m = blocks.length;
    const pre = [0];
    for (const b of blocks) pre.push(pre[pre.length - 1] + b.reduce((s2, r) => s2 + r.target, 0) * k);
    const cost = (ri: number, i: number, j: number) => {
      const A = usable[ri].area, got = pre[j] - pre[i];
      if (i === j) return A >= 8 ? 1e6 + A : A * 2;
      let c = ((got - A) * (got - A)) / A;
      let widths = 0;
      for (let b = i; b < j; b++) for (const r of blocks[b]) widths += minAlongCells(r, depth[ri]);
      if (widths > span[ri]) c += 1e5;
      for (let b = i; b < j; b++) for (const r of blocks[b]) {
        const rule = ROOM_RULES[kindOf(r)];
        if (rule && depth[ri] < Math.min(...rule.clear) - 0.01) c += 1e5;
      }
      return c;
    };
    const dp = Array.from({ length: R + 1 }, () => new Array(m + 1).fill(Infinity));
    const back = Array.from({ length: R + 1 }, () => new Array(m + 1).fill(0));
    dp[0][0] = 0;
    for (let ri = 1; ri <= R; ri++) {
      for (let j = 0; j <= m; j++) {
        for (let i = 0; i <= j; i++) {
          const v = dp[ri - 1][i] + cost(ri - 1, i, j);
          if (v < dp[ri][j]) { dp[ri][j] = v; back[ri][j] = i; }
        }
      }
    }
    let j = m;
    for (let ri = R; ri >= 1; ri--) {
      const i = back[ri][j];
      assign[ri - 1] = blocks.slice(i, j).flat();
      j = i;
    }
  }

  {
    const R = usable.length;
    // Repair: a room whose clear rectangle can't fit its strip's depth, or a strip whose rooms
    // can't all be wide enough, sends rooms to a strip where they fit (nearest in street order).
    const order = new Map(seq.map((r, i) => [r, i]));
    const used = (ri: number) => assign[ri].reduce((s2, r) => s2 + minAlongCells(r, depth[ri]), 0);
    for (let guard = 0; guard < 24; guard++) {
      let moved = false;
      for (let ri = 0; ri < R && !moved; ri++) {
        const bad = assign[ri].filter((r) => !fits(r, ri));
        const over = used(ri) > span[ri];
        if (!bad.length && !over) continue;
        const cands = bad.length ? bad : [...assign[ri]].sort((x, y) => minAlongCells(y, depth[ri]) - minAlongCells(x, depth[ri]));
        for (const r of cands) {
          // keep living + kitchen + dining together: move them as a group
          const group = ['living', 'kitchen', 'dining'].includes(r.type) && r.name !== 'Family room' ? assign[ri].filter((x) => ['living', 'kitchen', 'dining'].includes(x.type) && x.name !== 'Family room') : [r];
          const targets = usable.map((_, t) => t).filter((t) => t !== ri && group.every((x) => fits(x, t)) && used(t) + group.reduce((s2, x) => s2 + minAlongCells(x, depth[t]), 0) <= span[t])
            .sort((x, y) => Math.abs(x - ri) - Math.abs(y - ri));
          if (targets.length) {
            assign[ri] = assign[ri].filter((x) => !group.includes(x));
            assign[targets[0]] = [...assign[targets[0]], ...group].sort((x, y) => order.get(x)! - order.get(y)!);
            moved = true;
            break;
          }
          // no strip has room for it: swap it with a room of a strip where it fits, one that fits
          // here (the main bedroom to the deep front strip, a kitchen or bathroom to the shallow one)
          if (group.length !== 1 || !bad.includes(r)) continue;
          const LIVG = (x: RoomSpec) => ['living', 'kitchen', 'dining'].includes(x.type) && x.name !== 'Family room';
          let swap: { t: number; x: RoomSpec } | null = null;
          for (const t of usable.map((_, t2) => t2).filter((t2) => t2 !== ri && fits(r, t2)).sort((x, y) => Math.abs(x - ri) - Math.abs(y - ri))) {
            for (const x of assign[t]) {
              if (LIVG(x) || !fits(x, ri)) continue;
              const tAfter = used(t) - minAlongCells(x, depth[t]) + minAlongCells(r, depth[t]);
              const rAfter = used(ri) - minAlongCells(r, depth[ri]) + minAlongCells(x, depth[ri]);
              if (tAfter <= span[t] && rAfter <= span[ri]) { swap = { t, x }; break; }
            }
            if (swap) break;
          }
          if (!swap) continue;
          assign[ri] = [...assign[ri].filter((y) => y !== r), swap.x].sort((x, y) => order.get(x)! - order.get(y)!);
          assign[swap.t] = [...assign[swap.t].filter((y) => y !== swap!.x), r].sort((x, y) => order.get(x)! - order.get(y)!);
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }
  }
  // living, kitchen and dining that can't each be wide enough side by side become one open-plan
  // room (a narrow townhouse), rather than three squeezed slivers
  const LIV = (r: RoomSpec) => ['living', 'kitchen', 'dining'].includes(r.type) && r.name !== 'Family room' && kindOf(r) !== 'livingKitchen';
  const overflow = usable.some((_, ri) => assign[ri].some(LIV) && (assign[ri].some((r) => !fits(r, ri)) || assign[ri].reduce((s2, r) => s2 + minAlongCells(r, depth[ri]), 0) > span[ri]));
  const liv = seq.filter(LIV);
  if (!overflow || attempt || liv.length < 2 || !liv.some((r) => r.type === 'kitchen')) break;
  const dining = liv.some((r) => r.type === 'dining');
  const open: RoomSpec = { key: 'open-plan', type: 'living', name: dining ? 'Living, kitchen & dining' : 'Living & kitchen', target: liv.reduce((s2, r) => s2 + r.target, 0) * 0.9, minW: 3.6, zone: 0 };
  seq = seq.flatMap((r) => (r === liv[0] ? [open] : LIV(r) ? [] : [r]));
  }

  // ---- slice each strip along its hallway ----
  const sliced: { reg: Region; idxOfS: Map<number, number>; ids: number[]; list: RoomSpec[] }[] = [];
  usable.forEach((reg, ri) => {
    let list = assign[ri];
    if (!list.length && reg.area < 8) return; // left for the neighbours
    const sum = list.reduce((s, r) => s + r.target, 0) || 1;
    // hallways that run front to back: public rooms at the street end; otherwise either way round
    const descending = reg.axis === 'y' ? !(prefs.livingBack && fi === 0) : rng() < 0.5;
    const sVals = [...new Set(reg.s.values())].sort((a, b) => (descending ? b - a : a - b));
    const count = new Map<number, number>();
    for (const v of reg.s.values()) count.set(v, (count.get(v) ?? 0) + 1);
    const C: number[] = [0];
    for (const v of sVals) C.push(C[C.length - 1] + count.get(v)!);
    // the strip's depth decides which way a room's clear rectangle has to lie
    const perS = new Map<number, number>();
    for (const kk of reg.cells) perS.set(reg.s.get(kk)!, (perS.get(reg.s.get(kk)!) ?? 0) + 1);
    const depthCells = [...perS.values()].sort((x, y) => x - y)[Math.floor(perS.size / 2)];
    const regDepth = depthCells * CELL;
    // rooms with a natural size stay near it (bedrooms, bathrooms…); living spaces grow up to their
    // largest sensible size; what is still left becomes rooms of its own, never a bloated room
    const FLEX = new Set<RoomType>(['living', 'dining', 'kitchen']);
    const maxOf = (r: RoomSpec) => (ROOM_RULES[kindOf(r)]?.max ?? 99) + (r.suite ? SUITE.ensuite + SUITE.robe : 0);
    const capOf = (r: RoomSpec) => {
      if (FLEX.has(r.type)) return Math.min(maxOf(r), r.target * 2.2);
      return Math.min(maxOf(r), r.target * (r.compact ? 1.15 : r.type === 'master' ? 1.45 : 1.3));
    };
    const scale = reg.area / sum;
    const S0 = new Set(reg.s.values()).size;
    let wantM = list.map((r) => Math.max(Math.min(capOf(r), r.target * scale), Math.min(minAlongCells(r, regDepth) * depthCells, S0 * depthCells) * CELL * CELL));
    let left = reg.area - wantM.reduce((a2, b2) => a2 + b2, 0);
    const flexIdx = list.map((r, i) => (FLEX.has(r.type) ? i : -1)).filter((i) => i >= 0);
    if (left > 0.5 && flexIdx.length) {
      const ft = flexIdx.reduce((s2, i) => s2 + list[i].target, 0);
      const share = flexIdx.map((i) => (left * list[i].target) / ft);
      flexIdx.forEach((i, n) => { const give = Math.max(0, Math.min(share[n], maxOf(list[i]) - wantM[i])); wantM[i] += give; left -= give; });
    }
    // spare space: rooms of their own, each a sensible size and wide enough
    let spareCells = S0 - list.reduce((s2, r) => s2 + minAlongCells(r, regDepth), 0);
    const publicStrip = !list.length || list.some((r) => r.zone === 0);
    const hasFamily = () => [...program.rooms, ...rooms, ...list].some((r) => r.name === 'Family room');
    for (let guard = 0; guard < 8 && left >= 2; guard++) {
      const opts: RoomSpec[] = [];
      if (fi === 0 && publicStrip && !hasFamily() && left >= 14) opts.push({ key: `extra-${ri}-${guard}`, type: 'living', name: 'Family room', target: Math.min(left, 26), minW: 3.0, zone: 0 });
      if (fi > 0 && left >= 9) opts.push({ key: `extra-${ri}-${guard}`, type: 'other', name: 'Retreat', target: Math.min(left, 20), minW: 2.7, zone: 2 });
      if (left >= 7) opts.push({ key: `extra-${ri}-${guard}`, type: 'study', name: 'Study nook', target: Math.min(left, 14), minW: 2.4, zone: 2 });
      if (left >= 5) opts.push({ key: `extra-${ri}-${guard}`, type: 'other', name: 'Storage', target: Math.min(left, 6), minW: 1.2, zone: 2, compact: true });
      const pick = opts.find((o) => minAlongCells(o, regDepth) <= spareCells && regDepth >= Math.min(...(ROOM_RULES[kindOf(o)]?.clear ?? [0])) - 0.01);
      if (!pick) break;
      // the last one takes the rest if that keeps it within its size
      if (left - pick.target < 5 && left <= maxOf(pick) * 1.15) pick.target = left;
      spareCells -= minAlongCells(pick, regDepth);
      list = [...list, pick];
      wantM = [...wantM, pick.target];
      left -= pick.target;
    }
    if (!list.length) {
      list = [{ key: 'filler', type: fi === 0 ? 'study' : 'other', name: reg.area < 9 ? 'Storage' : fi === 0 ? 'Study nook' : 'Retreat', target: reg.area, minW: 2.4, zone: 2 }];
      wantM = [reg.area];
      left = 0;
    }
    if (left > 0.01) {
      // spare space too narrow for its own room: rooms grow up to their largest sensible size (the
      // main bedroom first, bedrooms never past it), then everything a little, never one room a lot
      const rank = (r: RoomSpec) => (r.type === 'master' ? 0 : FLEX.has(r.type) ? 1 : r.type === 'study' || r.type === 'other' ? 2 : r.type === 'bedroom' ? 3 : 4);
      const growers = list.map((r, i) => i).sort((x, y) => rank(list[x]) - rank(list[y]));
      const masterIdx = list.findIndex((r) => r.type === 'master');
      for (const i of growers) {
        if (left <= 0.01) break;
        const r = list[i];
        if (ROOM_RULES[kindOf(r)]?.shape === 'rect') continue;
        let room = maxOf(r) - wantM[i];
        if (r.type === 'bedroom' && masterIdx >= 0) room = Math.min(room, wantM[masterIdx] - SUITE.ensuite - SUITE.robe - 0.5 - wantM[i]);
        if (room <= 0) continue;
        const give = Math.min(left, room);
        wantM[i] += give;
        left -= give;
      }
      if (left > 0.01) {
        const tot = wantM.reduce((a2, b2) => a2 + b2, 0) || 1;
        wantM = wantM.map((w) => w + (left * w) / tot);
        left = 0;
      }
    }
    const S = sVals.length, m = list.length;
    const want = wantM.map((w) => w / (CELL * CELL));
    const mins = list.map((r) => minAlongCells(r, regDepth));
    const minSum = mins.reduce((a, b) => a + b, 0);
    if (minSum > S) for (let i = 0; i < m; i++) mins[i] = Math.max(1, Math.floor((mins[i] * S) / minSum));
    const cuts = [0];
    let acc = 0;
    for (let i = 0; i < m - 1; i++) {
      acc += want[i];
      let best = 0, bd = Infinity;
      for (let k = 0; k <= S; k++) { const d = Math.abs(C[k] - acc); if (d < bd) { bd = d; best = k; } }
      cuts.push(best);
    }
    cuts.push(S);
    for (let i = 1; i < m; i++) cuts[i] = Math.max(cuts[i], cuts[i - 1] + mins[i - 1]);
    for (let i = m - 1; i >= 1; i--) cuts[i] = Math.min(cuts[i], cuts[i + 1] - mins[i]);
    for (let i = 1; i < m; i++) cuts[i] = Math.max(cuts[i], cuts[i - 1]);
    const idxOfS = new Map(sVals.map((v, i) => [v, i]));
    const ids = list.map((r) => {
      rooms.push({ name: r.name, type: r.type, target: r.target, minW: r.minW, spec: r });
      return rooms.length - 1;
    });
    ids.forEach((id, i) => (expected[id] = ((C[cuts[i + 1]] - C[cuts[i]]) || want[i]) * CELL * CELL));
    for (const k of reg.cells) {
      if (pocket[k]) continue;
      const si = idxOfS.get(reg.s.get(k)!)!;
      let r = 0;
      while (r + 1 < m && cuts[r + 1] <= si) r++;
      owner[k] = ids[r];
    }
    sliced.push({ reg, idxOfS, ids, list });
    // small wet rooms keep the depth they need; the neighbour wraps round behind them
    list.forEach((spec, i) => {
      if (!spec.compact || m < 2) return;
      const id = ids[i];
      const own = reg.cells.filter((k) => owner[k] === id);
      const width = new Set(own.map((k) => reg.s.get(k))).size;
      const need = Math.max(Math.round(1.8 / CELL), Math.ceil(spec.target / (width * CELL) / CELL) + 1);
      const far = own.filter((k) => reg.depth.get(k)! > need);
      if (!far.length) return;
      const pref = (x: RoomSpec) => (x.type === 'master' ? 3 : FLEX.has(x.type) ? 2 : x.type === 'bedroom' ? 0 : 1);
      // the nearest room along the strip that isn't a small wet room (past a laundry beside a
      // bathroom, say): the far parts of everything in between go to it, so they stay connected
      const direct = [i - 1, i + 1].filter((x) => x >= 0 && x < m && !list[x].compact).sort((a, b) => pref(list[b]) - pref(list[a]) || list[b].target - list[a].target);
      const nbs = direct.length ? direct : [-1, 1].map((dir) => { let x = i + dir; while (x >= 0 && x < m && list[x].compact) x += dir; return x >= 0 && x < m ? x : -1; })
        .filter((x) => x >= 0).sort((a, b) => Math.abs(a - i) - Math.abs(b - i) || pref(list[b]) - pref(list[a]) || list[b].target - list[a].target);
      if (!nbs.length) return;
      const to = nbs[0];
      const moved: [number, number][] = [];
      for (let x = Math.min(i, to) + 1; x < Math.max(i, to); x++) {
        if (x === i) continue;
        for (const k of reg.cells) if (owner[k] === ids[x] && reg.depth.get(k)! > need) moved.push([k, ids[x]]);
      }
      for (const k of far) moved.push([k, id]);
      for (const [k] of moved) owner[k] = ids[to];
      // past other small rooms only if the room taking it all stays a sensible size and shape
      if (!direct.length) {
        let n = 0;
        for (const k of reg.cells) if (owner[k] === ids[to]) n++;
        if (n * CELL * CELL > maxOf(list[to]) || gridCorners(g, owner, ids[to]) > 6) { for (const [k, o] of moved) owner[k] = o; return; }
      }
      for (const [, o] of moved) { expected[ids[to]] += CELL * CELL; expected[o] -= CELL * CELL; }
    });
  });

  // ---- the main bedroom is the biggest bedroom: it takes the largest bedroom-sized slice, then
  // gets its walk-in robe and ensuite strip ----
  {
    const cellsOf = (id: number) => { let c = 0; for (let k = 0; k < N; k++) if (owner[k] === id) c++; return c; };
    const masterId = rooms.findIndex((r) => r.type === 'master');
    if (masterId >= 0) {
      // a slice the suite strip and a 3 m bed space both fit across
      const across = (id: number) => { const sd2 = sliced.find((x) => x.ids.includes(id)); return sd2 ? new Set(sd2.reg.cells.filter((k) => owner[k] === id).map((k) => sd2.reg.s.get(k))).size : 0; };
      const beds = rooms.map((r, id) => ({ r, id })).filter((x) => x.r.type === 'bedroom' && across(x.id) >= 12);
      const big = beds.map((x) => ({ ...x, n: cellsOf(x.id) })).sort((p, q) => q.n - p.n)[0];
      const strip = rooms[masterId].spec?.suite ? 7 * 10 : 0;
      if (big && big.n - strip > cellsOf(masterId) + 2) {
        for (let k = 0; k < N; k++) if (owner[k] === masterId) owner[k] = big.id; else if (owner[k] === big.id) owner[k] = masterId;
        [expected[masterId], expected[big.id]] = [expected[big.id], expected[masterId]];
        for (const sd of sliced) sd.ids = sd.ids.map((x) => (x === masterId ? big.id : x === big.id ? masterId : x));
      }
      const sd = sliced.find((x) => x.ids.includes(masterId));
      if (sd && rooms[masterId].spec?.suite) {
        // a strip beside the bed holds the walk-in robe (by the hallway) and the ensuite (against
        // the far wall, sized to its brief); whatever is between stays with the bedroom
        const { reg, idxOfS, ids } = sd;
        const m = ids.length, i = ids.indexOf(masterId), id = masterId;
        const own = reg.cells.filter((k) => owner[k] === id);
        if (own.length) {
          // only columns the bedroom owns from the hallway to its far wall (not a neighbour's offcut)
          const maxD = Math.max(...own.map((k) => reg.depth.get(k)!));
          const byCol = new Map<number, number[]>();
          for (const k of own) { const c = idxOfS.get(reg.s.get(k)!)!; byCol.set(c, [...(byCol.get(c) ?? []), reg.depth.get(k)!]); }
          const mine = [...byCol.entries()].filter(([, ds]) => ds.includes(1) && ds.length >= maxD - 1).map(([c]) => c).sort((x, y) => x - y);
          const w = mine.length;
          const bedMin = Math.ceil((maxD * CELL >= 3.4 ? 3.0 : 3.4) / CELL - 1e-6);
          // the strip goes at the end of the room, not between the bed and a part of the room that
          // wraps behind a small neighbour (that would leave a bedroom with a dozen corners)
          const allCols = own.map((k) => idxOfS.get(reg.s.get(k)!)!);
          const wrapStart = Math.min(...allCols) < mine[0], wrapEnd = Math.max(...allCols) > mine[mine.length - 1];
          const atStart = wrapStart !== wrapEnd ? wrapEnd : i > 0 ? true : i < m - 1 ? false : rng() < 0.5;
          const mineSet = new Set(mine);
          const colOf = (k: number) => idxOfS.get(reg.s.get(k)!)!;
          const wrapCells = own.filter((k) => !mineSet.has(colOf(k)));
          const wrapArea = wrapCells.length * CELL * CELL;
          // every sensible way to carve the suite; the first that leaves a sound bedroom wins
          const plans: { ens: number[]; robe: number[] }[] = [];
          if (wrapStart !== wrapEnd && wrapArea >= 3.5 && components(g, wrapCells).length === 1) {
            // the bedroom wraps behind a bathroom: that nook is the ensuite (back to back with the
            // bathroom), the walk-in robe goes in the corner beside it by the hallway
            let ens = wrapCells;
            if (wrapArea > 8.5) {
              const byDepth = [...wrapCells].sort((a2, b2) => reg.depth.get(b2)! - reg.depth.get(a2)!);
              const lim = reg.depth.get(byDepth[Math.min(byDepth.length - 1, Math.ceil(SUITE.ensuite / (CELL * CELL)))])!;
              ens = wrapCells.filter((k) => reg.depth.get(k)! > lim);
            }
            const ensSet = new Set(ens);
            const restWrap = wrapCells.filter((k) => !ensSet.has(k));
            let robe: number[] = [];
            if (restWrap.length * CELL * CELL >= 1.8 && restWrap.length * CELL * CELL <= 7) robe = restWrap;
            else if (w - 5 >= bedMin && maxD >= 6 + 8) {
              const rc = new Set(wrapEnd ? mine.slice(w - 5) : mine.slice(0, 5));
              robe = own.filter((k) => rc.has(colOf(k)) && reg.depth.get(k)! <= 6);
            }
            plans.push({ ens, robe }, { ens, robe: [] });
          }
          // best: a full-depth strip at one end of the room, the robe by the hallway and the ensuite
          // behind it, no gap: the bedroom stays a clean rectangle (next to a wet room if possible)
          for (const start of [atStart, !atStart]) {
            for (const sw of [6, 7, 8]) {
              if (w - sw < bedMin) continue;
              const cols = new Set(start ? mine.slice(0, sw) : mine.slice(w - sw));
              const maxEns = Math.floor(ROOM_RULES.ensuite!.max / (sw * CELL * CELL));
              for (const withRobe of [true, false]) {
                const robeD = withRobe ? Math.max(6, maxD - maxEns) : 0;
                if (!withRobe && maxD > maxEns) continue;
                if (withRobe && (robeD * sw * CELL * CELL > ROOM_RULES.robe!.max || maxD - robeD < 8)) continue;
                plans.push({
                  ens: own.filter((k) => cols.has(colOf(k)) && reg.depth.get(k)! > robeD),
                  robe: robeD ? own.filter((k) => cols.has(colOf(k)) && reg.depth.get(k)! <= robeD) : [],
                });
              }
            }
          }
          // a strip at one end of the room: the robe by the hallway, the ensuite against the far wall
          for (const start of [atStart, !atStart]) {
            for (const withRobe of [true, false]) {
              const side = w - 7 >= bedMin;
              const sw = side ? Math.max(7, Math.min(9, w - bedMin)) : Math.min(w, 9);
              const cols = new Set(start ? mine.slice(0, sw) : mine.slice(w - sw));
              const ensD = Math.max(8, Math.ceil(SUITE.ensuite / (sw * CELL) / CELL - 1e-6));
              const robeD = withRobe && side && maxD - ensD >= 7 ? 6 : 0;
              plans.push({
                ens: own.filter((k) => cols.has(colOf(k)) && reg.depth.get(k)! > maxD - ensD),
                robe: robeD ? own.filter((k) => cols.has(colOf(k)) && reg.depth.get(k)! <= robeD) : [],
              });
            }
            // or the ensuite by the hallway, at that end (when the far wall is slanted or short)
            const sw2 = Math.min(w, 9);
            const cols2 = new Set(start ? mine.slice(0, sw2) : mine.slice(w - sw2));
            const ensD2 = Math.max(8, Math.ceil(SUITE.ensuite / (sw2 * CELL) / CELL - 1e-6));
            plans.push({ ens: own.filter((k) => cols2.has(colOf(k)) && reg.depth.get(k)! <= ensD2), robe: [] });
          }
          const TE = rooms.length + 50, TR = rooms.length + 51;
          const judge = (pl: { ens: number[]; robe: number[] }, order: number) => {
            for (const k of pl.ens) owner[k] = TE;
            for (const k of pl.robe) owner[k] = TR;
            const ensA = pl.ens.length * CELL * CELL;
            let bad = gridCorners(g, owner, id, F.cov) > 8 ? 100 : 0;
            if (!hasClear(g, owner, id, 12, 14, F.cov)) bad += 60;
            if (ensA < ROOM_RULES.ensuite!.min || ensA > ROOM_RULES.ensuite!.max || !hasClear(g, owner, TE, 6, 8, F.cov) || gridCorners(g, owner, TE, F.cov) > 4) bad += 50;
            if (pl.robe.length && (!hasClear(g, owner, TR, 5, 6, F.cov) || gridCorners(g, owner, TR, F.cov) > 4)) bad += 20;
            // an ensuite or robe against a slanted wall gets an odd corner: rectangles only
            if ([...pl.ens, ...pl.robe].some((k) => F.cov[k] < 0.99)) bad += 30;
            // the bedroom keeps its own way into the hallway (a door's width)
            let touch = 0;
            for (let k = 0; k < N; k++) if (owner[k] === id) { const ii = k % g.nx; for (const n2 of [ii > 0 ? k - 1 : -1, ii < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) if (n2 >= 0 && n2 < N && owner[n2] === HALL) touch++; }
            if (touch < 5) bad += 100;
            // a cleaner bedroom is better: every corner past a rectangle costs; plumbing next to
            // another wet room is a plus
            const corners = gridCorners(g, owner, id, F.cov);
            bad += Math.max(0, corners - 4) * 4;
            const wetNext = pl.ens.some((k) => { const ii = k % g.nx; return [ii > 0 ? k - 1 : -1, ii < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].some((n2) => n2 >= 0 && n2 < N && owner[n2] >= 2 && owner[n2] !== id && owner[n2] < rooms.length && ['bathroom', 'laundry', 'wc', 'ensuite'].includes(rooms[owner[n2]].type)); });
            if (wetNext) bad -= 3;
            for (const k of [...pl.ens, ...pl.robe]) owner[k] = id;
            return bad + (pl.robe.length ? 0 : 3) + order * 0.01;
          };
          const best = plans.map((pl, n) => ({ pl, v: judge(pl, n) })).sort((a2, b2) => a2.v - b2.v)[0];
          if (best && best.pl.ens.length) {
            const ens = rooms.push({ name: 'Ensuite', type: 'ensuite', target: SUITE.ensuite, minW: 1.6 }) - 1;
            const robe = best.pl.robe.length ? rooms.push({ name: 'Walk-in robe', type: 'other', target: SUITE.robe, minW: 1.2 }) - 1 : -1;
            for (const k of best.pl.ens) owner[k] = ens;
            for (const k of best.pl.robe) owner[k] = robe;
            const ea = best.pl.ens.length, ra = best.pl.robe.length;
          expected[ens] = ea * CELL * CELL;
          if (robe >= 0) expected[robe] = ra * CELL * CELL;
          expected[id] -= (ea + ra) * CELL * CELL;
          }
        }
      }
    }
  }

  // ---- pockets join one neighbour each, whole: the main bedroom or a living space rather than a
  // bedroom, never a wet room, the garage or the stairs ----
  {
    const pref = (o: number) => {
      const r = rooms[o];
      if (!r || o === STAIRS || r.type === 'garage' || ROOM_RULES[kindOf(r)]?.shape === 'rect') return 0;
      return r.type === 'master' ? 6 : ['living', 'dining', 'kitchen', 'study'].includes(r.type) ? 5 : r.type === 'other' ? 4 : r.type === 'bedroom' ? 3 : o === HALL ? 1 : 2;
    };
    const cells: number[] = [];
    for (let k = 0; k < N; k++) if (pocket[k] && owner[k] === FREE) cells.push(k);
    const cellsOfOwner = (o: number) => { let c = 0; for (let k = 0; k < N; k++) if (owner[k] === o) c++; return c; };
    const mId = rooms.findIndex((x) => x.type === 'master');
    // the main bedroom's own share, without its ensuite and robe
    const masterCells = mId >= 0 ? cellsOfOwner(mId) - (rooms[mId].spec?.suite ? Math.round((SUITE.ensuite + SUITE.robe) / (CELL * CELL)) : 0) : -1;
    /** a rectangle-only room may take the pocket if the two together are still a rectangle */
    const staysRect = (o: number, comp: number[]) => {
      let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1, n = 0;
      const add = (k: number) => { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); n++; };
      for (let k = 0; k < N; k++) if (owner[k] === o) add(k);
      for (const k of comp) add(k);
      return n === (i1 - i0 + 1) * (j1 - j0 + 1);
    };
    for (const comp of components(g, cells)) {
      const votes = new Map<number, number>();
      for (const k of comp) {
        const i = k % g.nx;
        for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
          if (n < 0 || n >= N || owner[n] < 0) continue;
          let p2 = pref(owner[n]);
          const r = rooms[owner[n]];
          if (r?.type === 'bedroom' && masterCells >= 0 && cellsOfOwner(owner[n]) + comp.length > masterCells - 2) p2 = 0;
          if (!p2 && r && owner[n] !== STAIRS && r.type !== 'garage' && staysRect(owner[n], comp)) p2 = r.type === 'entry' ? 8 : 2;
          if (p2 > 0) votes.set(owner[n], (votes.get(owner[n]) ?? 0) + 1 + p2 * 4);
        }
      }
      // the best-voted neighbour that keeps a sound shape (at most 8 corners), else the best one
      const ranked = [...votes.entries()].sort((a2, b2) => b2[1] - a2[1]).map(([o]) => o);
      let best = ranked[0] ?? -1;
      for (const o of ranked.slice(0, 4)) {
        if (o === HALL) { best = o; break; }
        for (const k of comp) owner[k] = o;
        const okShape = gridCorners(g, owner, o, F.cov) <= 8;
        for (const k of comp) owner[k] = FREE;
        if (okShape) { best = o; break; }
      }
      // too big for the room it would join (an L's leg behind its front rooms): a room of its own,
      // reached through a living space or the hallway; split in two if it is very big
      const A = comp.length * CELL * CELL;
      const joinMax = best >= 2 ? (ROOM_RULES[kindOf(rooms[best])]?.max ?? 99) * 1.2 : 99;
      const curA = best >= 2 ? cellsOfOwner(best) * CELL * CELL : 0;
      const transit = ranked.filter((o) => o === HALL || ['living', 'kitchen', 'dining', 'entry'].includes(rooms[o]?.type));
      if (A >= 9 && comp.some((k) => deepPocket[k]) && (best < 2 || curA + A > joinMax) && transit.length) {
        const viaHall = transit.includes(HALL);
        // two rooms only if each one opens onto the hallway or a living space
        const opensOnto = (part: number[]) => part.some((k) => { const i = k % g.nx; return [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].some((n) => n >= 0 && n < N && (owner[n] === HALL || ['living', 'kitchen', 'dining', 'entry'].includes(rooms[owner[n]]?.type))); });
        let parts = A > 36 ? halves(g, comp) : [comp];
        if (parts.length > 1 && !parts.every(opensOnto)) parts = [comp];
        for (const part of parts) {
          const big = part.length * CELL * CELL >= 11;
          const spec: Laid = fi === 0
            ? (big && !rooms.some((x) => x.name === 'Family room') ? { name: 'Family room', type: 'living', target: part.length * CELL * CELL, minW: 3 } : viaHall || big ? { name: 'Study nook', type: 'study', target: part.length * CELL * CELL, minW: 2.4 } : { name: 'Storage', type: 'other', target: part.length * CELL * CELL, minW: 1.2 })
            : { name: big ? 'Retreat' : 'Storage', type: 'other', target: part.length * CELL * CELL, minW: 2.4 };
          const id = rooms.push(spec) - 1;
          for (const k of part) owner[k] = id;
          expected[id] = part.length * CELL * CELL;
        }
        continue;
      }
      if (best >= 0) { for (const k of comp) owner[k] = best; expected[best] = (expected[best] ?? 0) + comp.length * CELL * CELL; }
    }
  }

  // ---- tidy: one piece per room ----
  for (let id = 2; id < rooms.length; id++) {
    const cells: number[] = [];
    for (let k = 0; k < N; k++) if (owner[k] === id) cells.push(k);
    if (!cells.length) continue;
    const comps = components(g, cells);
    comps.sort((a, b) => b.length - a.length);
    for (const c of comps.slice(1)) for (const k of c) owner[k] = FREE;
  }
  // ---- rooms that must be rectangles keep their largest rectangle that still opens onto the room
  // they are entered from; offcuts go to their neighbours ----
  const strict = new Set<number>([STAIRS]);
  rooms.forEach((r, id) => { if (id >= 2 && ROOM_RULES[kindOf(r)]?.shape === 'rect') strict.add(id); if (r.type === 'garage') strict.add(id); });
  const masterId = rooms.findIndex((r) => r.type === 'master');
  for (const id of strict) {
    const r = rooms[id];
    if (id === STAIRS || r.type === 'garage') continue;
    const access = r.type === 'ensuite' || /robe/i.test(r.name) ? masterId : HALL;
    const rule = ROOM_RULES[kindOf(r)]!;
    const keep = bestRect(g, owner, id, access, Math.ceil(Math.min(...rule.clear) / CELL - 1e-6), Math.ceil(Math.max(...rule.clear) / CELL - 1e-6), F.cov, strict);
    if (!keep) continue;
    for (let k = 0; k < N; k++) if (owner[k] === id && F.cov[k] >= 0.5 && !inRect(keep, k % g.nx, Math.floor(k / g.nx))) owner[k] = FREE;
  }
  fillFree(g, owner, strict, F.cov);
  trimHall(g, F, owner, rooms, segs, garage?.lobby ?? null, strict);
  // a storeroom that had to take a leftover pocket (behind the stairs, in a corner) and grew past
  // a cupboard's size or shape is a room in its own right: a study nook downstairs, a retreat upstairs
  for (let id = 2; id < rooms.length; id++) {
    const r = rooms[id];
    if (kindOf(r) !== 'storage') continue;
    let n = 0, outside = false, i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1;
    for (let k = 0; k < N; k++) {
      if (owner[k] !== id) continue;
      const i = k % g.nx, j = (k - i) / g.nx;
      n++; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      if (!outside) outside = [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].some((m) => m < 0 || m >= N || owner[m] === NONE);
    }
    const rect = n === (i1 - i0 + 1) * (j1 - j0 + 1);
    // (a small one cut by a slanted wall stays a storeroom)
    void rect;
    if (!outside || n * CELL * CELL <= ROOM_RULES.storage!.max) continue;
    const taken = (nm: string) => rooms.some((x) => x.name === nm);
    Object.assign(r, fi === 0
      ? { type: 'study', name: taken('Study nook') ? 'Home office' : 'Study nook' }
      : (taken('Retreat') ? { type: 'other', name: 'Sitting room' } : { type: 'other', name: 'Retreat' }));
    strict.delete(id);
  }
  if (fi === 0) entryToStreet(ctx, F, owner, rooms, strict);
  optimiseLayout(g, F, owner, rooms, expected, strict);
  // a second or third filler of the same kind on one floor gets another name of that kind
  const ALT: Record<string, string[]> = { 'Study nook': ['Home office', 'Hobby room'], Retreat: ['Sitting room'], 'Sitting room': ['Lounge'] };
  const seen = new Map<string, number>();
  const names = new Set<string>();
  rooms.forEach((r, id) => {
    if (id < 2 || !owner.includes(id)) return;
    const n = (seen.get(r.name) ?? 0) + 1;
    seen.set(r.name, n);
    if (n > 1) {
      const alt = (ALT[r.name] ?? []).find((x) => !names.has(x) && !rooms.some((o) => o.name === x));
      r.name = alt ?? `${r.name} ${n}`;
    }
    names.add(r.name);
  });
  return { owner, rooms, expected };
}

// ---------------------------------------------------------------------------------------------
// optimisation: the layout as an objective, improved by moving walls
// ---------------------------------------------------------------------------------------------

/**
 * The layout of one floor as an optimisation problem. The objective adds up, per room:
 *  - constraints (heavy): under its minimum area, no clear rectangle, more than 8 corners, a
 *    corridor-like proportion, a rectangle-only room that isn't one, grossly oversized;
 *  - geometry: corners past a rectangle, proportions past its kind's limit;
 *  - size: distance from the size the programme wanted;
 * and across rooms (proportion constraints): the main bedroom is the largest bedroom, bathrooms
 * are smaller than bedrooms, a laundry or storeroom is never bigger than a bedroom.
 * A local search then moves walls between neighbouring rooms 25 cm at a time (a whole face of
 * cells from one room to the other), keeping every room in one piece, rectangles rectangular,
 * every room's way into the hallway and its outside wall, and accepts the best improving move
 * until none is left.
 */
function optimiseLayout(g: Grid, F: FloorCtx, owner: Int16Array, rooms: Laid[], expected: number[], strict: Set<number>) {
  const N = owner.length, C2 = CELL * CELL;
  const nb4 = (k: number): number[] => { const i = k % g.nx; return [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].filter((n) => n >= 0 && n < N); };
  const cells = new Map<number, Set<number>>();
  for (let k = 0; k < N; k++) if (owner[k] >= 2) { const o = owner[k]; if (!cells.has(o)) cells.set(o, new Set()); cells.get(o)!.add(k); }
  const movable = (o: number) => o >= 2 && rooms[o] && rooms[o].type !== 'garage' && rooms[o].type !== 'hallway';
  const kindAt = (o: number) => kindOf(rooms[o]);
  const box = (cs: Set<number>) => {
    let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1;
    for (const k of cs) { const i = k % g.nx, j = (k - i) / g.nx; if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    return { i0, i1, j0, j1 };
  };
  const clearIn = (cs: Set<number>, a: number, b: number) => {
    const { i0, i1, j0, j1 } = box(cs);
    const W = i1 - i0 + 1, H = j1 - j0 + 1;
    if (W < Math.min(a, b) || H < Math.min(a, b)) return false;
    const P = new Int32Array((W + 1) * (H + 1));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const k = (j0 + j) * g.nx + i0 + i; P[(j + 1) * (W + 1) + i + 1] = (cs.has(k) && F.cov[k] >= 0.99 ? 1 : 0) + P[j * (W + 1) + i + 1] + P[(j + 1) * (W + 1) + i] - P[j * (W + 1) + i]; }
    const fits = (w: number, h: number) => { for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) if (P[(y + h) * (W + 1) + x + w] - P[y * (W + 1) + x + w] - P[(y + h) * (W + 1) + x] + P[y * (W + 1) + x] === w * h) return true; return false; };
    return fits(a, b) || fits(b, a);
  };
  const corners = (cs: Set<number>) => {
    const { i0, i1, j0, j1 } = box(cs);
    let slanted = false;
    for (const k of cs) if (F.cov[k] < 0.99) { slanted = true; break; }
    const at = (i: number, j: number) => { if (i < i0 || j < j0 || i > i1 || j > j1) return 0; const k = j * g.nx + i; return cs.has(k) || (slanted && owner[k] === NONE) ? 1 : 0; };
    let c = 0;
    for (let j = j0; j <= j1 + 1; j++) for (let i = i0; i <= i1 + 1; i++) {
      const a = at(i - 1, j - 1), b = at(i, j - 1), d = at(i - 1, j), e = at(i, j), n = a + b + d + e;
      if (n === 1 || n === 3) c++; else if (n === 2 && a === e) c += 2;
    }
    return c + (slanted ? 1 : 0);
  };
  const suiteArea = (o: number) => (rooms[o].spec?.suite ? 0 : 0);
  const roomPen = (o: number): number => {
    const cs = cells.get(o);
    if (!cs || !cs.size) return 0;
    const rule = ROOM_RULES[kindAt(o)];
    const A = cs.size * C2;
    let pen = 0;
    if (rule) {
      if (A < rule.min) pen += 60 + (rule.min - A) * 20;
      if (A > rule.max * 1.5) pen += 60 + (A - rule.max * 1.5) * 5;
      else if (A > rule.max) pen += (A - rule.max) * 1.5;
      const ca = Math.ceil(Math.min(...rule.clear) / CELL - 1e-6), cb = Math.ceil(Math.max(...rule.clear) / CELL - 1e-6);
      if (!clearIn(cs, ca, cb)) pen += 60;
      const b2 = box(cs), w = (b2.i1 - b2.i0 + 1) * CELL, h = (b2.j1 - b2.j0 + 1) * CELL, ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio > rule.aspect * 1.5) pen += 60 + (ratio - rule.aspect * 1.5) * 20;
      else if (ratio > rule.aspect) pen += (ratio - rule.aspect) * 6;
    }
    const c = corners(cs);
    if (c > 8) pen += 60 + (c - 8) * 5;
    pen += Math.max(0, c - 4) * 1.5;
    if (strict.has(o)) { const b2 = box(cs); if (cs.size !== (b2.i1 - b2.i0 + 1) * (b2.j1 - b2.j0 + 1) && !cs.size) pen += 0; }
    const want = expected[o] || rooms[o].target;
    if (want > 0) pen += (Math.abs(A - want) / want) * 3;
    return pen + suiteArea(o);
  };
  const globalPen = (): number => {
    let pen = 0;
    const area = (o: number) => (cells.get(o)?.size ?? 0) * C2;
    const ids = [...cells.keys()].filter((o) => cells.get(o)!.size);
    const beds = ids.filter((o) => kindAt(o) === 'bedroom').map(area);
    const master = ids.find((o) => kindAt(o) === 'master');
    const smallest = beds.length ? Math.min(...beds) : master !== undefined ? area(master) : Infinity;
    if (master !== undefined) for (const b of beds) if (b > area(master) + 0.3) pen += 40 + (b - area(master)) * 5;
    for (const o of ids) {
      const k = kindAt(o);
      if (k === 'bathroom' && area(o) > smallest * 0.8) pen += 30 + (area(o) - smallest * 0.8) * 5;
      if ((k === 'laundry' || k === 'wc' || k === 'storage') && area(o) > smallest) pen += 30;
    }
    return pen;
  };
  // the cheap guards a move must keep
  const touches = (cs: Set<number>, pred: (n: number) => boolean) => { let t = 0; for (const k of cs) for (const n of nb4(k)) if (!cs.has(n) && pred(n)) t++; return t; };
  const hallTouch = (o: number) => touches(cells.get(o)!, (n) => owner[n] === HALL || owner[n] === STAIRS);
  const outside = (o: number) => touches(cells.get(o)!, (n) => owner[n] === NONE) + [...cells.get(o)!].filter((k) => { const i = k % g.nx, j = (k - i) / g.nx; return i === 0 || j === 0 || i === g.nx - 1 || j === g.ny - 1; }).length;
  const connected = (cs: Set<number>) => {
    if (!cs.size) return false;
    const start = cs.values().next().value as number;
    const seen = new Set([start]), st = [start];
    while (st.length) { const k = st.pop()!; for (const n of nb4(k)) if (cs.has(n) && !seen.has(n)) { seen.add(n); st.push(n); } }
    return seen.size === cs.size;
  };
  const isRect = (cs: Set<number>) => { const b2 = box(cs); return cs.size === (b2.i1 - b2.i0 + 1) * (b2.j1 - b2.j0 + 1); };
  const needsWindow = (o: number) => ['master', 'bedroom', 'living', 'livingKitchen', 'family', 'kitchen', 'dining', 'study', 'retreat'].includes(kindAt(o));
  const pens = new Map<number, number>();
  for (const o of cells.keys()) pens.set(o, roomPen(o));
  let gp = globalPen();
  const dirs = [1, -1, g.nx, -g.nx];
  for (let iter = 0; iter < 30; iter++) {
    // work on the rooms that break a constraint (and their neighbours), worst first
    const bad = [...pens.entries()].filter(([o, v]) => v >= 30 && movable(o)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o]) => o);
    if (!bad.length && gp < 30) break;
    const focus = new Set(bad);
    if (gp >= 30) for (const o of cells.keys()) if (['master', 'bedroom', 'bathroom', 'laundry', 'wc', 'storage'].includes(kindAt(o))) focus.add(o);
    let best: { from: number; to: number; slab: number[]; delta: number } | null = null;
    for (const r of focus) {
      const rc = cells.get(r);
      if (!rc || !movable(r)) continue;
      const nbs = new Set<number>();
      for (const k of rc) for (const n of nb4(k)) if (owner[n] !== r && movable(owner[n])) nbs.add(owner[n]);
      for (const b of nbs) {
        for (const [from, to] of [[r, b], [b, r]]) {
          const fc = cells.get(from)!, tc = cells.get(to)!;
          for (const d of dirs) {
            // the face of `from` towards `to` in direction d: those cells move over
            const slab: number[] = [];
            for (const k of fc) { const n = k + d; if (n < 0 || n >= N || (Math.abs(d) === 1 && Math.floor(n / g.nx) !== Math.floor(k / g.nx))) continue; if (owner[n] === to) slab.push(k); }
            if (!slab.length || slab.length >= fc.size) continue;
            for (const k of slab) { fc.delete(k); tc.add(k); owner[k] = to; }
            let ok = connected(fc) && connected(tc);
            if (ok && strict.has(from)) ok = isRect(fc);
            if (ok && strict.has(to)) ok = isRect(tc);
            if (ok) ok = hallTouch(from) >= 4 || ['ensuite', 'robe'].includes(kindAt(from));
            if (ok && needsWindow(from)) ok = outside(from) > 0;
            let delta = 0;
            if (ok) {
              const pf = roomPen(from), pt = roomPen(to), g2 = globalPen();
              delta = pf + pt + g2 - (pens.get(from)! + pens.get(to)! + gp);
              if (delta < -0.5 && (!best || delta < best.delta)) best = { from, to, slab: [...slab], delta };
            }
            for (const k of slab) { tc.delete(k); fc.add(k); owner[k] = from; }
          }
        }
      }
    }
    if (!best) break;
    const fc = cells.get(best.from)!, tc = cells.get(best.to)!;
    for (const k of best.slab) { fc.delete(k); tc.add(k); owner[k] = best.to; expected[best.to] = (expected[best.to] ?? 0) + C2; expected[best.from] = (expected[best.from] ?? 0) - C2; }
    pens.set(best.from, roomPen(best.from));
    pens.set(best.to, roomPen(best.to));
    gp = globalPen();
  }
}

/**
 * Hallways are corridors. Hallway cells beyond the hallway strips themselves (a widened shallow
 * strip, an offcut, a pocket nobody else could take) join the neighbouring room they fit best,
 * as long as every other room still opens onto the hallway and nothing grows past its size.
 */
function trimHall(g: Grid, F: FloorCtx, owner: Int16Array, rooms: Laid[], segs: Band[], lobby: Rect | null, strict: Set<number>) {
  const N = owner.length;
  const band = new Uint8Array(N);
  for (const b of segs) for (const k of bandCells(g, b)) band[k] = 1;
  if (lobby) for (const k of rectCells(g, lobby)) band[k] = 1;
  const extra: number[] = [];
  for (let k = 0; k < N; k++) if (owner[k] === HALL && !band[k]) extra.push(k);
  const nb = (k: number) => { const i = k % g.nx; return [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].filter((n) => n >= 0 && n < N); };
  const hallTouch = (o: number) => { let t = 0; for (let k = 0; k < N; k++) if (owner[k] === o) for (const n of nb(k)) if (owner[n] === HALL) t++; return t; };
  const boxOf = (o: number, add: number[]) => {
    let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1, n = 0;
    const put = (k: number) => { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); n++; };
    for (let k = 0; k < N; k++) if (owner[k] === o) put(k);
    for (const k of add) put(k);
    return { n, fill: n / ((i1 - i0 + 1) * (j1 - j0 + 1)) };
  };
  for (const comp of components(g, extra)) {
    if (comp.length * CELL * CELL < 1.5) continue;
    const shared = new Map<number, number>();
    for (const k of comp) for (const n of nb(k)) { const o = owner[n]; if (o >= 2 && rooms[o]?.type !== 'garage') shared.set(o, (shared.get(o) ?? 0) + 1); }
    let best = -1, bv = -Infinity;
    for (const [o, edge] of shared) {
      const box = boxOf(o, comp);
      if (strict.has(o) && box.fill < 0.999) continue;
      const rule = ROOM_RULES[kindOf(rooms[o])];
      if (rule && box.n * CELL * CELL > rule.max * 1.2 + (rooms[o].spec?.suite ? SUITE.ensuite + SUITE.robe : 0)) continue;
      const v = edge + box.fill * 40;
      if (v > bv) { bv = v; best = o; }
    }
    if (best < 0) continue;
    const before = [...shared.keys()].filter((o) => o !== best).map((o) => [o, hallTouch(o)] as const);
    for (const k of comp) owner[k] = best;
    // undo if a neighbour lost its way into the hallway
    if (before.some(([o, t]) => t >= 4 && hallTouch(o) < 4)) for (const k of comp) owner[k] = HALL;
  }
}

/**
 * The entry has to be on the street, where the front door is. When it ended up behind another
 * room (a pocket at the end of the hallway, a wing), it moves to a rectangle on the front facade
 * beside the hallway, taken from the hallway or a living space; its old place joins its neighbours.
 */
function entryToStreet(ctx: Ctx, F: FloorCtx, owner: Int16Array, rooms: Laid[], strict: Set<number>) {
  const g = ctx.grid, N = owner.length;
  const id = rooms.findIndex((r) => r.type === 'entry');
  if (id < 0) return;
  const atFront = (i: number, j: number) => !!F.core[j * g.nx + i] && (j === g.ny - 1 || !F.core[(j + 1) * g.nx + i]);
  const mine: number[] = [];
  for (let k = 0; k < N; k++) if (owner[k] === id) mine.push(k);
  if (!mine.length || mine.some((k) => atFront(k % g.nx, Math.floor(k / g.nx)))) return;
  const rule = ROOM_RULES.entry!;
  const lo = Math.ceil(Math.min(...rule.clear) / CELL - 1e-6), hi = Math.ceil(Math.max(...rule.clear) / CELL - 1e-6), top = Math.round(4.5 / CELL);
  const target = Math.max(rule.min, mine.length * CELL * CELL);
  const ent = ctx.entrance ? toLocal(ctx.frame, ctx.entrance) : null;
  const sizeOf = new Map<number, number>();
  for (let k = 0; k < N; k++) if (owner[k] >= 0) sizeOf.set(owner[k], (sizeOf.get(owner[k]) ?? 0) + 1);
  const cost = (o: number) => {
    if (o === HALL || o === id) return 0.2;
    const t = rooms[o]?.type;
    return t === 'living' || t === 'dining' || t === 'other' || t === 'study' ? 1 : t === 'kitchen' ? 2 : 4;
  };
  const cellsOf = new Map<number, number[]>();
  for (let k = 0; k < N; k++) if (owner[k] >= 0) { const l = cellsOf.get(owner[k]); if (l) l.push(k); else cellsOf.set(owner[k], [k]); }
  // cheap tests first (cells, hallway contact), scored; the costly one (what is left of each room it
  // takes from stays whole and big enough) only for the best few
  const cands: { r: Rect; score: number; taken: Map<number, number> }[] = [];
  for (let jb = 0; jb < g.ny; jb++) for (let i0 = 0; i0 < g.nx; i0++) {
    if (!atFront(i0, jb)) continue;
    for (let w = lo; w <= top; w++) {
      const i1 = i0 + w - 1;
      if (i1 >= g.nx || !atFront(i1, jb)) break;
      let flat = true;
      for (let i = i0; i <= i1 && flat; i++) flat = atFront(i, jb);
      if (!flat) break;
      for (let d = lo; d <= top; d++) {
        if ((w < hi && d < hi) || w * d * CELL * CELL > rule.max) continue;
        const r: Rect = { i0, i1, j0: jb - d + 1, j1: jb };
        if (r.j0 < 0) break;
        // it opens onto the hallway, at least 1 m of shared wall (checked first: cheap)
        let touch = 0;
        for (let i = r.i0; i <= r.i1; i++) if (r.j0 > 0 && owner[(r.j0 - 1) * g.nx + i] === HALL) touch++;
        for (let j = r.j0; j <= r.j1; j++) { if (r.i0 > 0 && owner[j * g.nx + r.i0 - 1] === HALL) touch++; if (r.i1 < g.nx - 1 && owner[j * g.nx + r.i1 + 1] === HALL) touch++; }
        let ok = true, c = 0;
        const taken = new Map<number, number>();
        for (let j = r.j0; j <= r.j1 && ok; j++) for (let i = r.i0; i <= r.i1; i++) {
          const k = j * g.nx + i, o = owner[k];
          if (!F.core[k] || o < 0 || o === STAIRS || (o !== id && strict.has(o))) { ok = false; break; }
          c += cost(o);
          taken.set(o, (taken.get(o) ?? 0) + 1);
        }
        if (!ok) break;
        if (touch < 4) continue;
        if ([...taken].some(([o, n]) => o !== id && o !== HALL && n > (sizeOf.get(o) ?? 0) * 0.4)) continue;
        const cc = cellCentre(g, r.j0 * g.nx + r.i0);
        const score = c * CELL * CELL + Math.abs(w * d * CELL * CELL - target) * 0.5 + (ent ? dist([cc[0] + (w * CELL) / 2, cc[1]], ent) * 2 : 0);
        cands.push({ r, score, taken });
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);
  let best: { r: Rect } | null = null;
  const stamp = new Int32Array(N);
  let gen = 0;
  /** cells of room `o` outside rectangle `r`, and whether they are still one piece */
  const restOf = (o: number, r: Rect) => {
    const cs = cellsOf.get(o) ?? [];
    let start = -1, total = 0;
    for (const k of cs) if (!inRect(r, k % g.nx, (k / g.nx) | 0)) { total++; if (start < 0) start = k; }
    if (start < 0) return { n: 0, whole: false };
    stamp[start] = ++gen;
    const st = [start];
    let seen = 1;
    while (st.length) {
      const k = st.pop()!, i = k % g.nx;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
        if (n < 0 || n >= N || stamp[n] === gen || owner[n] !== o || inRect(r, n % g.nx, (n / g.nx) | 0)) continue;
        stamp[n] = gen; seen++; st.push(n);
      }
    }
    return { n: total, whole: seen === total };
  };
  for (const cand of cands) {
    const ok = [...cand.taken.keys()].every((o) => {
      if (o === id) return true;
      const rest = restOf(o, cand.r);
      const rr = ROOM_RULES[kindOf(rooms[o])];
      return rest.n > 0 && rest.whole && (o === HALL || !rr || rest.n * CELL * CELL >= rr.min);
    });
    if (ok) { best = cand; break; }
  }
  if (!best) return;
  for (const k of rectCells(g, best.r)) owner[k] = id;
  // its old place joins one neighbour whole, so no wall steps round it
  const old = mine.filter((k) => !inRect(best!.r, k % g.nx, Math.floor(k / g.nx)));
  for (const comp of components(g, old)) {
    const votes = new Map<number, number>();
    for (const k of comp) {
      const i = k % g.nx;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
        if (n < 0 || n >= N) continue;
        const o = owner[n];
        if (o < 0 || o === id || o === STAIRS || strict.has(o)) continue;
        votes.set(o, (votes.get(o) ?? 0) + (o === HALL ? 0.5 : 1));
      }
    }
    let to = HALL, bv = 0;
    for (const [o, v] of votes) if (v > bv) { bv = v; to = o; }
    for (const k of comp) owner[k] = to;
  }
}

/**
 * The largest rectangle of a room's own cells that is at least `a` × `b` cells (either way round)
 * and shares at least 1 m of edge with `access` (the room it is entered from).
 */
function bestRect(g: Grid, owner: Int16Array, id: number, access: number, a: number, b: number, cov: Float64Array, fixed: Set<number>): Rect | null {
  let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1, n = 0;
  for (let k = 0; k < owner.length; k++) if (owner[k] === id) { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); n++; }
  if (i1 < 0) return null;
  const W = i1 - i0 + 1, H = j1 - j0 + 1;
  const mine = (i: number, j: number) => owner[j * g.nx + i] === id && cov[j * g.nx + i] >= 0.5;
  const P = new Int32Array((W + 1) * (H + 1));
  let coreCount = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const v = mine(i0 + i, j0 + j) ? 1 : 0; coreCount += v; P[(j + 1) * (W + 1) + i + 1] = v + P[j * (W + 1) + i + 1] + P[(j + 1) * (W + 1) + i] - P[j * (W + 1) + i]; }
  if (coreCount === W * H) return { i0, i1, j0, j1 };
  const cands: Rect[] = [];
  for (let y0 = 0; y0 < H; y0++) for (let y1 = y0; y1 < H; y1++) for (let x0 = 0; x0 < W; x0++) for (let x1 = x0; x1 < W; x1++) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (!((w >= a && h >= b) || (w >= b && h >= a)) || w * h < coreCount * 0.5) continue;
    const s = P[(y1 + 1) * (W + 1) + x1 + 1] - P[y0 * (W + 1) + x1 + 1] - P[(y1 + 1) * (W + 1) + x0] + P[y0 * (W + 1) + x0];
    if (s === w * h) cands.push({ i0: i0 + x0, i1: i0 + x1, j0: j0 + y0, j1: j0 + y1 });
  }
  cands.sort((p, q) => (q.i1 - q.i0 + 1) * (q.j1 - q.j0 + 1) - (p.i1 - p.i0 + 1) * (p.j1 - p.j0 + 1));
  for (const r of cands) {
    let touch = 0;
    for (let i = r.i0; i <= r.i1; i++) { if (r.j0 > 0 && owner[(r.j0 - 1) * g.nx + i] === access) touch++; if (r.j1 < g.ny - 1 && owner[(r.j1 + 1) * g.nx + i] === access) touch++; }
    for (let j = r.j0; j <= r.j1; j++) { if (r.i0 > 0 && owner[j * g.nx + r.i0 - 1] === access) touch++; if (r.i1 < g.nx - 1 && owner[j * g.nx + r.i1 + 1] === access) touch++; }
    if (touch < 4) continue;
    // every offcut must be able to join a room that may change shape (else it would come back)
    const off: number[] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (mine(i, j) && !inRect(r, i, j)) off.push(j * g.nx + i);
    const offSet = new Set(off), ok = new Set<number>();
    const q: number[] = [];
    for (const k of off) {
      const i = k % g.nx;
      if ([i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx].some((n) => n >= 0 && n < owner.length && owner[n] >= 0 && owner[n] !== id && !fixed.has(owner[n]))) { ok.add(k); q.push(k); }
    }
    while (q.length) {
      const k = q.pop()!, i = k % g.nx;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) if (offSet.has(n) && !ok.has(n)) { ok.add(n); q.push(n); }
    }
    if (ok.size === off.length) return r;
  }
  return null;
}

/** A patch of cells cut in two across its longer side. */
function halves(g: Grid, cells: number[]): number[][] {
  let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1;
  for (const k of cells) { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
  const wide = i1 - i0 >= j1 - j0;
  const mid = wide ? (i0 + i1 + 1) / 2 : (j0 + j1 + 1) / 2;
  const a: number[] = [], b: number[] = [];
  for (const k of cells) { const i = k % g.nx, j = (k - i) / g.nx; ((wide ? i : j) < mid ? a : b).push(k); }
  return [a, b].filter((x) => x.length);
}

/**
 * Corners of the outline of a room's cells (each concave or convex turn counts once). With `cov`,
 * a slanted outside wall counts as one side, not a staircase: cells outside the floor within the
 * room's extent count as the room's, and the slanted side adds one corner.
 */
function gridCorners(g: Grid, owner: Int16Array, id: number, cov?: Float64Array): number {
  let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1, slanted = false;
  for (let k = 0; k < owner.length; k++) if (owner[k] === id) { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); if (cov && cov[k] < 0.99) slanted = true; }
  if (i1 < 0) return 0;
  const outside = (k: number) => !!cov && slanted && (owner[k] === NONE || cov[k] < 0.5) && owner[k] !== id && (owner[k] < 0);
  const at = (i: number, j: number) => (i >= i0 && j >= j0 && i <= i1 && j <= j1 && (owner[j * g.nx + i] === id || outside(j * g.nx + i)) ? 1 : 0);
  let c = 0;
  for (let j = j0; j <= j1 + 1; j++) for (let i = i0; i <= i1 + 1; i++) {
    const a = at(i - 1, j - 1), b = at(i, j - 1), d = at(i - 1, j), e = at(i, j);
    const n = a + b + d + e;
    if (n === 1 || n === 3) c++;
    else if (n === 2 && a === e) c += 2;
  }
  return c + (slanted ? 1 : 0);
}

/** Does the room contain a clear rectangle of a × b cells, either way round? (With `cov`, only whole cells count.) */
function hasClear(g: Grid, owner: Int16Array, id: number, a: number, b: number, cov?: Float64Array): boolean {
  let i0 = g.nx, i1 = -1, j0 = g.ny, j1 = -1;
  for (let k = 0; k < owner.length; k++) if (owner[k] === id) { const i = k % g.nx, j = (k - i) / g.nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
  if (i1 < 0) return false;
  const W = i1 - i0 + 1, H = j1 - j0 + 1;
  const P = new Int32Array((W + 1) * (H + 1));
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const k = (j0 + j) * g.nx + i0 + i; P[(j + 1) * (W + 1) + i + 1] = (owner[k] === id && (!cov || cov[k] >= 0.99) ? 1 : 0) + P[j * (W + 1) + i + 1] + P[(j + 1) * (W + 1) + i] - P[j * (W + 1) + i]; }
  const fits = (w: number, h: number) => {
    for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) if (P[(y + h) * (W + 1) + x + w] - P[y * (W + 1) + x + w] - P[(y + h) * (W + 1) + x] + P[y * (W + 1) + x] === w * h) return true;
    return false;
  };
  return fits(a, b) || fits(b, a);
}

function components(g: Grid, cells: number[]): number[][] {
  const set = new Set(cells), seen = new Set<number>(), out: number[][] = [];
  for (const s of cells) {
    if (seen.has(s)) continue;
    const c: number[] = [], st = [s];
    seen.add(s);
    while (st.length) {
      const k = st.pop()!, i = k % g.nx;
      c.push(k);
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) if (set.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
    }
    out.push(c);
  }
  return out;
}

/**
 * Give every unassigned cell inside the floor to the neighbouring room it touches most. Rooms in
 * `fixed` (rectangles: wet rooms, garage, stairs) only take the slivers along a slanted outside
 * wall, so they stay rectangular.
 */
function fillFree(g: Grid, owner: Int16Array, fixed: Set<number> = new Set([STAIRS]), cov?: Float64Array) {
  for (let round = 0; round < 400; round++) {
    const changes: [number, number][] = [];
    for (let k = 0; k < owner.length; k++) {
      if (owner[k] !== FREE) continue;
      const i = k % g.nx;
      const votes = new Map<number, number>();
      const sliver = !!cov && cov[k] < 0.5;
      for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
        if (n < 0 || n >= owner.length) continue;
        const o = owner[n];
        if (o < 0 || o === STAIRS || (fixed.has(o) && !sliver)) continue;
        votes.set(o, (votes.get(o) ?? 0) + (o === HALL ? 0.9 : 1));
      }
      let best = -1, bv = 0;
      for (const [o, v] of votes) if (v > bv || (v === bv && o > best)) { bv = v; best = o; }
      if (best >= 0) changes.push([k, best]);
    }
    if (!changes.length) break;
    for (const [k, o] of changes) owner[k] = o;
  }
  // patches boxed in by rectangles join one neighbour whole (straight walls), preferring rooms that
  // may change shape: better a slightly larger rectangle than a missing wall
  if (fixed.size > 1) {
    const left: number[] = [];
    for (let k = 0; k < owner.length; k++) if (owner[k] === FREE) left.push(k);
    for (const comp of components(g, left)) {
      const votes = new Map<number, number>();
      for (const k of comp) {
        const i = k % g.nx;
        for (const n of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
          if (n < 0 || n >= owner.length) continue;
          const o = owner[n];
          if (o >= 0 && o !== STAIRS) votes.set(o, (votes.get(o) ?? 0) + (fixed.has(o) ? 1 : 100));
        }
      }
      let best = -1, bv = 0;
      for (const [o, v] of votes) if (v > bv) { bv = v; best = o; }
      if (best >= 0) for (const k of comp) owner[k] = best;
    }
  }
}

/**
 * Room order along the hallway: street-side rooms first, the main bedroom last. With the living
 * areas facing the back garden the order runs from the back, so the entry and garage go last and
 * still end up on the street.
 */
function sequence(rooms: RoomSpec[], rng: () => number, livingBack = false): RoomSpec[] {
  const pub = rooms.filter((r) => r.zone === 0);
  const order: RoomType[] = ['garage', 'entry', 'living', 'kitchen', 'dining'];
  // the family room comes after living, kitchen and dining, so it never splits them up
  const rank = (r: RoomSpec) => (r.name === 'Family room' ? 4.5 : order.indexOf(r.type) < 0 ? 9 : order.indexOf(r.type));
  pub.sort((a, b) => rank(a) - rank(b));
  const svc = rooms.filter((r) => r.zone === 1);
  const priv = rooms.filter((r) => r.zone === 2);
  const beds = priv.filter((r) => !r.compact && r.type !== 'master');
  const wet = priv.filter((r) => r.compact);
  const master = priv.filter((r) => r.type === 'master');
  const v = rng();
  const privOrder = v < 0.45 ? [...beds, ...wet, ...master] : v < 0.8 ? [...wet, ...beds, ...master] : [...beds.slice(0, 1), ...wet, ...beds.slice(1), ...master];
  if (livingBack) {
    const street = pub.filter((r) => r.type === 'garage' || r.type === 'entry').reverse();
    return [...pub.filter((r) => !street.includes(r)), ...svc, ...privOrder, ...street];
  }
  return [...pub, ...svc, ...privOrder];
}

// ---------------------------------------------------------------------------------------------
// walls, rooms, doors and windows
// ---------------------------------------------------------------------------------------------

interface Built { floor: Floor; layout: FloorLayout; ownerOfRoom: Map<string, number>; penalties: number }

function buildFloor(ctx: Ctx, fi: number, L: FloorLayout, rng: () => number): Built {
  const g = ctx.grid, F = ctx.floors[fi], f = ctx.frame;
  const { owner } = L;
  // ---- walls: maximal straight lines between different owners, clipped to the wall line ----
  const vLines = new Map<number, number[]>(), hLines = new Map<number, number[]>();
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i, o = owner[k];
      if (o < 0) continue;
      if (i + 1 < g.nx && owner[k + 1] >= 0 && owner[k + 1] !== o) { if (!vLines.has(i + 1)) vLines.set(i + 1, []); vLines.get(i + 1)!.push(j); }
      if (j + 1 < g.ny && owner[k + g.nx] >= 0 && owner[k + g.nx] !== o) { if (!hLines.has(j + 1)) hLines.set(j + 1, []); hLines.get(j + 1)!.push(i); }
    }
  }
  const walls: Wall[] = F.line.map((p, i) => ({ id: `w${F.level}-e${i}`, a: p, b: F.line[(i + 1) % F.line.length], thickness: ENVELOPE_T, exterior: true }));
  let wid = 0;
  const addLine = (a: Vec2, b: Vec2) => {
    for (const [p, q] of clipSegmentToPolygon(a, b, F.local)) {
      if (dist(p, q) < 0.05) continue;
      const pa = toPlan(f, p), pb = toPlan(f, q);
      walls.push({ id: `w${F.level}-${wid++}`, a: [r3(pa[0]), r3(pa[1])], b: [r3(pb[0]), r3(pb[1])], thickness: INT_T, exterior: false });
    }
  };
  const merge = (list: number[]) => {
    list.sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const v of list) {
      const last = out[out.length - 1];
      if (last && v === last[1] + 1) last[1] = v; else out.push([v, v]);
    }
    return out;
  };
  for (const [x, list] of [...vLines.entries()].sort((a, b) => a[0] - b[0])) for (const [j0, j1] of merge(list)) addLine([g.x0 + x * CELL, g.y0 + j0 * CELL], [g.x0 + x * CELL, g.y0 + (j1 + 1) * CELL]);
  for (const [y, list] of [...hLines.entries()].sort((a, b) => a[0] - b[0])) for (const [i0, i1] of merge(list)) addLine([g.x0 + i0 * CELL, g.y0 + y * CELL], [g.x0 + (i1 + 1) * CELL, g.y0 + y * CELL]);

  // ---- rooms from walls (openPlan3D), named after the cells they contain ----
  const detected = recomputeRooms({ level: F.level, height: F.height, walls, rooms: [], openings: [] });
  const ownerOfRoom = new Map<string, number>();
  const usedOwners = new Map<number, number>();
  const rooms: Room[] = detected.rooms.map((r, ri) => {
    const loc = r.polygon.map((p) => toLocal(f, p));
    const xs = loc.map((p) => p[0]), ys = loc.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.x0) / CELL)), i1 = Math.min(g.nx - 1, Math.ceil((Math.max(...xs) - g.x0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - g.y0) / CELL)), j1 = Math.min(g.ny - 1, Math.ceil((Math.max(...ys) - g.y0) / CELL));
    const votes = new Map<number, number>();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * g.nx + i;
      if (owner[k] < 0) continue;
      if (pointInPolygon(cellCentre(g, k), loc)) votes.set(owner[k], (votes.get(owner[k]) ?? 0) + F.cov[k]);
    }
    let o = -1, bv = 0;
    for (const [id, v] of votes) if (v > bv) { bv = v; o = id; }
    const laid = L.rooms[o] ?? { name: 'Room', type: 'other' as RoomType };
    const n = (usedOwners.get(o) ?? 0) + 1;
    usedOwners.set(o, n);
    const id = `r${F.level}-${ri}`;
    ownerOfRoom.set(id, o);
    return { id, name: n > 1 && o > STAIRS ? `${laid.name} (${n})` : laid.name, type: laid.type, polygon: r.polygon, area: r.area };
  });
  const floor: Floor = { level: F.level, height: F.height, walls: detected.walls, rooms, openings: [], footprint: F.footprint.map((p) => [...p] as Vec2) };
  const penalties = placeOpenings(ctx, fi, floor, L, ownerOfRoom, rng);
  return { floor, layout: L, ownerOfRoom, penalties };
}

const ACCESS: Partial<Record<RoomType, (RoomType | 'hall')[]>> = {
  master: ['hall'], bedroom: ['hall'], bathroom: ['hall'], ensuite: ['master'], study: ['hall', 'entry', 'living'],
  wc: ['hall', 'laundry', 'entry'], laundry: ['hall', 'kitchen', 'garage'], kitchen: ['living', 'dining', 'hall'],
  living: ['hall', 'entry'], dining: ['kitchen', 'living', 'hall'], garage: ['hall', 'laundry', 'entry', 'kitchen'],
  entry: ['hall'], stairs: ['hall'], other: ['hall', 'living'],
};
const WIDE = new Set(['living|kitchen', 'kitchen|living', 'living|dining', 'dining|living', 'kitchen|dining', 'dining|kitchen', 'entry|hall', 'stairs|hall']);
const HABITABLE = new Set<RoomType>(['bedroom', 'master', 'living', 'kitchen', 'dining', 'study']);
const WINDOW: Partial<Record<RoomType, { w: number; h: number; sill: number }>> = {
  master: { w: 1.8, h: 1.4, sill: 0.8 }, bedroom: { w: 1.5, h: 1.4, sill: 0.8 }, living: { w: 2.4, h: 2.1, sill: 0.1 },
  kitchen: { w: 1.4, h: 1.0, sill: 1.05 }, dining: { w: 1.8, h: 2.1, sill: 0.1 }, study: { w: 1.2, h: 1.4, sill: 0.8 },
  bathroom: { w: 0.8, h: 0.6, sill: 1.5 }, ensuite: { w: 0.8, h: 0.6, sill: 1.5 }, laundry: { w: 0.8, h: 1.0, sill: 1.1 },
  wc: { w: 0.6, h: 0.6, sill: 1.5 }, stairs: { w: 0.9, h: 1.2, sill: 1.0 }, other: { w: 1.2, h: 1.4, sill: 0.8 },
};

/** Straight runs of cell edges between two owners, in local coordinates (longest first). */
function contacts(g: Grid, owner: Int16Array, a: number, b: number): [Vec2, Vec2][] {
  const v = new Map<number, number[]>(), h = new Map<number, number[]>();
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    if (owner[k] !== a && owner[k] !== b) continue;
    const other = owner[k] === a ? b : a;
    if (i + 1 < g.nx && owner[k + 1] === other) { if (!v.has(i + 1)) v.set(i + 1, []); v.get(i + 1)!.push(j); }
    if (j + 1 < g.ny && owner[k + g.nx] === other) { if (!h.has(j + 1)) h.set(j + 1, []); h.get(j + 1)!.push(i); }
  }
  const out: [Vec2, Vec2][] = [];
  const merge = (list: number[]) => {
    list.sort((x, y) => x - y);
    const res: [number, number][] = [];
    for (const x of list) { const l = res[res.length - 1]; if (l && x === l[1] + 1) l[1] = x; else res.push([x, x]); }
    return res;
  };
  for (const [x, list] of v) for (const [j0, j1] of merge(list)) out.push([[g.x0 + x * CELL, g.y0 + j0 * CELL], [g.x0 + x * CELL, g.y0 + (j1 + 1) * CELL]]);
  for (const [y, list] of h) for (const [i0, i1] of merge(list)) out.push([[g.x0 + i0 * CELL, g.y0 + y * CELL], [g.x0 + (i1 + 1) * CELL, g.y0 + y * CELL]]);
  return out.sort((p, q) => dist(q[0], q[1]) - dist(p[0], p[1]));
}

function placeOpenings(ctx: Ctx, fi: number, floor: Floor, L: FloorLayout, ownerOfRoom: Map<string, number>, rng: () => number): number {
  const g = ctx.grid, F = ctx.floors[fi], f = ctx.frame;
  let oid = 0, penalty = 0;
  const inner = floor.walls.filter((w) => !w.exterior);
  const ext = floor.walls.filter((w) => w.exterior);
  const busy = new Map<string, [number, number][]>(); // exterior wall → occupied stretches
  const add = (w: Wall, offset: number, type: 'door' | 'window', width: number, height: number, sill?: number) => {
    floor.openings.push({ id: `o${floor.level}-${oid++}`, wallId: w.id, type, offset: r3(offset), width: r3(width), height, ...(sill !== undefined ? { sill } : {}) });
    if (w.exterior) { if (!busy.has(w.id)) busy.set(w.id, []); busy.get(w.id)!.push([offset - width / 2 - 0.3, offset + width / 2 + 0.3]); }
  };
  const wallAt = (p: Vec2, list: Wall[]) => {
    for (const w of list) { const pr = projectOnSegment(p, w.a, w.b); if (pr.d < 2e-3 && pr.t > 0 && pr.t < 1) return { w, offset: pr.t * dist(w.a, w.b) }; }
    return null;
  };
  const typeOf = (o: number): RoomType | 'hall' => (o === HALL ? 'hall' : L.rooms[o]?.type ?? 'other');
  const present = new Set<number>(ownerOfRoom.values());

  // ---- doors between rooms ----
  const linked = new Set<string>();
  /** A door at local point c on an axis-aligned run needs a clear 0.8 m square of each room's own cells on both sides. */
  const clearAt = (p1: Vec2, q1: Vec2, c: Vec2, a: number, b: number) => {
    const vertical = Math.abs(p1[0] - q1[0]) < 1e-6;
    if (!vertical && Math.abs(p1[1] - q1[1]) > 1e-6) return true;
    const line = vertical ? Math.round((p1[0] - g.x0) / CELL) : Math.round((p1[1] - g.y0) / CELL);
    const base = vertical ? g.y0 : g.x0, at = vertical ? c[1] : c[0];
    const t0 = Math.floor((at - 0.4 - base) / CELL + 1e-6), t1 = Math.ceil((at + 0.4 - base) / CELL - 1e-6) - 1;
    for (const side of [-1, 1]) {
      let own = -99;
      for (let d = 0; d < 4; d++) {
        const cc = side < 0 ? line - 1 - d : line + d;
        for (let t = t0; t <= t1; t++) {
          const i = vertical ? cc : t, j = vertical ? t : cc;
          if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return false;
          const o = L.owner[j * g.nx + i];
          if (own === -99) own = o;
          if (o !== own || (o !== a && o !== b)) return false;
        }
      }
    }
    return true;
  };
  const doorBetween = (a: number, b: number, wide: boolean) => {
    let fallback: { w: Wall; offset: number; dw: number } | null = null;
    for (const [p, q] of contacts(g, L.owner, a, b)) {
      for (const [p1, q1] of clipSegmentToPolygon(p, q, F.local)) {
        const len = dist(p1, q1);
        const dw = wide ? Math.min(typeOf(a) === 'stairs' || typeOf(b) === 'stairs' ? 1.0 : 1.8, len - 0.3) : 0.82;
        if (len < dw + 0.25 || dw < 0.7) continue;
        const near = (0.15 + dw / 2) / len;
        const ts = wide ? [0.5] : rng() < 0.5 ? [near, 1 - near, 0.5] : [1 - near, near, 0.5];
        for (const tt of ts) {
          const c: Vec2 = [p1[0] + (q1[0] - p1[0]) * tt, p1[1] + (q1[1] - p1[1]) * tt];
          const hit = wallAt(toPlan(f, c), inner);
          if (!hit) continue;
          if (!wide && dw < 1.3 && !clearAt(p1, q1, c, a, b)) { fallback ??= { ...hit, dw }; continue; }
          add(hit.w, hit.offset, 'door', dw, wide && dw >= 1.3 ? 2.1 : 2.04);
          linked.add(`${Math.min(a, b)}|${Math.max(a, b)}`);
          return true;
        }
      }
    }
    if (fallback) {
      add(fallback.w, fallback.offset, 'door', fallback.dw, 2.04);
      linked.add(`${Math.min(a, b)}|${Math.max(a, b)}`);
      return true;
    }
    return false;
  };
  for (const o of present) {
    if (o === HALL || o < 0) continue;
    const laid = L.rooms[o];
    const prefs = laid.name === 'Walk-in robe' ? ['master' as const] : ACCESS[laid.type] ?? ['hall'];
    let ok = false;
    for (const want of prefs) {
      const targets = [...present].filter((x) => x !== o && typeOf(x) === want);
      for (const t of targets) if (doorBetween(o, t, WIDE.has(`${laid.type}|${want}`))) { ok = true; break; }
      if (ok) break;
    }
    if (!ok && !['bedroom', 'master', 'bathroom', 'ensuite', 'wc', 'garage'].includes(laid.type) && laid.name !== 'Walk-in robe') {
      // living spaces may open off any neighbour that is not a bedroom or wet room
      const others = [...present].filter((x) => x !== o && x !== STAIRS && !['bedroom', 'master', 'bathroom', 'ensuite', 'wc', 'garage'].includes(typeOf(x)));
      for (const t of others) if (doorBetween(o, t, false)) { ok = true; break; }
    }
    if (!ok) penalty += 60;
  }
  // open archways between living spaces that share a long wall
  const ids = [...present];
  for (const a of ids) for (const b of ids) {
    if (a >= b || !WIDE.has(`${typeOf(a)}|${typeOf(b)}`) || typeOf(a) === 'stairs' || typeOf(b) === 'stairs' || typeOf(a) === 'hall' || typeOf(b) === 'hall') continue;
    if (!linked.has(`${a}|${b}`)) doorBetween(a, b, true);
  }

  // ---- exterior: front door, garage door, windows ----
  const frontLocal: Vec2 = [0, 1];
  let frontOwner = -1;
  const extEdges = (room: Room) => {
    const out: { w: Wall; from: number; to: number; n: Vec2; len: number }[] = [];
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ei = F.line.findIndex((a, k) => { const b = F.line[(k + 1) % F.line.length]; return projectOnSegment(p, a, b).d < 3e-3 && projectOnSegment(q, a, b).d < 3e-3; });
      if (ei < 0 || dist(p, q) < 0.3) continue;
      const w = ext.find((x) => x.id === `w${F.level}-e${ei}`);
      if (!w) continue;
      const L0 = dist(w.a, w.b);
      const t0 = projectOnSegment(p, w.a, w.b).t * L0, t1 = projectOnSegment(q, w.a, w.b).t * L0;
      const nPlan = outwardNormal(F.line, ei);
      const nl = toLocal({ angle: f.angle, origin: [0, 0] }, nPlan);
      out.push({ w, from: Math.min(t0, t1), to: Math.max(t0, t1), n: nl, len: Math.abs(t1 - t0) });
    }
    return out.sort((a, b) => b.len - a.len);
  };
  const free = (e: { w: Wall; from: number; to: number }, width: number): number | null => {
    const taken = (busy.get(e.w.id) ?? []).filter(([a, b]) => b > e.from && a < e.to).sort((x, y) => x[0] - y[0]);
    let best: [number, number] | null = null, cur = e.from + 0.3;
    for (const [a, b] of [...taken, [e.to - 0.3, e.to - 0.3] as [number, number]]) {
      if (a - cur > (best ? best[1] - best[0] : 0)) best = [cur, a];
      cur = Math.max(cur, b);
    }
    if (!best || best[1] - best[0] < width) return null;
    return (best[0] + best[1]) / 2;
  };
  const roomsByOwner = (pred: (t: RoomType | 'hall', o: number) => boolean) => floor.rooms.filter((r) => pred(typeOf(ownerOfRoom.get(r.id)!), ownerOfRoom.get(r.id)!));

  if (fi === 0) {
    // front door: entry first, then living, then hallway; facing the street, near the lot entrance
    const entLocal = ctx.entrance ? toLocal(f, ctx.entrance) : null;
    let best: { e: ReturnType<typeof extEdges>[number]; score: number; at: number; type: string; owner: number } | null = null;
    // facing the street first; a side facade only when no street-facing wall can take it
    for (const minFacing of [0.3, -0.2]) {
      if (best) break;
      for (const [type, bonus] of [['entry', 6], ['hall', 3], ['living', 2], ['dining', 0], ['kitchen', -1]] as const) {
        for (const r of roomsByOwner((t) => t === type)) {
          for (const e of extEdges(r)) {
            const facing = e.n[0] * frontLocal[0] + e.n[1] * frontLocal[1];
            if (facing < minFacing || e.len < 0.95) continue;
            let at = (e.from + e.to) / 2;
            if (entLocal) {
              const pl = toLocal(f, e.w.a), ql = toLocal(f, e.w.b);
              at = projectOnSegment(entLocal, pl, ql).t * dist(e.w.a, e.w.b);
            }
            // keep a return each side, clear of the room's corners; the end of a hallway may be
            // the doorway itself (its side walls are the returns)
            const ret = type === 'hall' ? 0.02 : 0.3;
            if (e.to - e.from < 0.92 + ret * 2) continue;
            at = Math.min(e.to - 0.46 - ret, Math.max(e.from + 0.46 + ret, at));
            const pt = toLocal(f, [e.w.a[0] + ((e.w.b[0] - e.w.a[0]) * at) / dist(e.w.a, e.w.b), e.w.a[1] + ((e.w.b[1] - e.w.a[1]) * at) / dist(e.w.a, e.w.b)]);
            const score = bonus + facing * 3 - (entLocal ? dist(pt, entLocal) * 0.15 : 0);
            if (!best || score > best.score) best = { e, score, at, type, owner: ownerOfRoom.get(r.id)! };
          }
        }
      }
    }
    if (best) { add(best.e.w, best.at, 'door', 0.92, 2.1); frontOwner = best.owner; }
    else penalty += 40;
    // an entry hall that doesn't reach the street is pointless
    if (best && best.type !== 'entry' && L.rooms.some((r) => r.type === 'entry')) penalty += 14;
    for (const r of roomsByOwner((t) => t === 'garage')) {
      const es = extEdges(r).filter((e) => e.len >= 2.8).sort((a, b) => (b.n[1] - a.n[1]) || b.len - a.len);
      if (!es.length) { penalty += 14; continue; }
      if (es[0].n[1] < 0.5) penalty += 12; // the garage door should face the street
      const gw = Math.min(r.area >= 30 ? 4.8 : 2.4, es[0].len - 0.6);
      const at = free(es[0], gw);
      if (at !== null) add(es[0].w, at, 'door', gw, 2.2);
    }
  }
  // ---- connectivity: every room can be reached from the front door (ground floor) or the stairs ----
  {
    const TRANSIT = new Set<RoomType | 'hall'>(['hall', 'entry', 'living', 'kitchen', 'dining', 'stairs', 'laundry']);
    const PRIV = new Set<RoomType | 'hall'>(['bedroom', 'master', 'bathroom', 'ensuite', 'wc']);
    const masterId = [...present].find((x) => typeOf(x) === 'master') ?? -1;
    const reach = () => {
      const start = fi === 0 ? frontOwner : present.has(STAIRS) ? STAIRS : HALL;
      const seen = new Set<number>(start >= 0 ? [start] : []);
      const q = [...seen];
      while (q.length) {
        const r = q.shift()!;
        const through = TRANSIT.has(typeOf(r)) || r === masterId;
        if (!through) continue;
        for (const key of linked) {
          const [x, y] = key.split('|').map(Number);
          const nb = x === r ? y : y === r ? x : -1;
          if (nb < 0 || seen.has(nb)) continue;
          if (r === masterId && !(typeOf(nb) === 'ensuite' || L.rooms[nb]?.name === 'Walk-in robe')) continue;
          seen.add(nb); q.push(nb);
        }
      }
      return seen;
    };
    for (let round = 0; round < 12; round++) {
      const seen = reach();
      const lost = [...present].filter((x) => x >= 0 && !seen.has(x) && typeOf(x) !== 'garage');
      if (!lost.length || (fi === 0 && frontOwner < 0)) break;
      let fixed = false;
      for (const u of lost.sort((a, b) => Number(PRIV.has(typeOf(a))) - Number(PRIV.has(typeOf(b))))) {
        const tu = typeOf(u);
        const allowed: (RoomType | 'hall')[] = tu === 'ensuite' || L.rooms[u]?.name === 'Walk-in robe' ? ['master'] : PRIV.has(tu) ? (tu === 'wc' ? ['hall', 'entry', 'laundry'] : ['hall']) : ['hall', 'entry', 'living', 'kitchen', 'dining'];
        const targets = [...seen].filter((t) => allowed.includes(typeOf(t))).sort((a, b) => allowed.indexOf(typeOf(a)) - allowed.indexOf(typeOf(b)));
        for (const t of targets) if (doorBetween(u, t, WIDE.has(`${tu}|${typeOf(t)}`))) { fixed = true; break; }
        if (fixed) break;
      }
      if (!fixed) break;
    }
    penalty += [...present].filter((x) => x >= 0 && typeOf(x) !== 'garage' && !reach().has(x)).length * 60;
  }

  for (const r of floor.rooms) {
    const o = ownerOfRoom.get(r.id)!;
    const t = typeOf(o);
    if (t === 'hall' || t === 'garage') continue;
    const spec = WINDOW[t as RoomType];
    if (!spec) continue;
    const es = extEdges(r);
    let placed = 0;
    const want = t === 'living' ? 2 : 1;
    for (const e of es) {
      if (placed >= want) break;
      const width = Math.min(spec.w, e.len - 0.8);
      if (width < Math.min(0.6, spec.w)) continue;
      const at = free(e, width);
      if (at === null) continue;
      add(e.w, at, 'window', width, spec.h, spec.sill);
      placed++;
    }
    if (!placed && HABITABLE.has(t as RoomType)) penalty += 12;
  }
  return penalty;
}

// ---------------------------------------------------------------------------------------------
// the whole house, scoring, variants
// ---------------------------------------------------------------------------------------------

interface Candidate { plan: PlanSpec; score: number }

function scoreFloor(ctx: Ctx, b: Built): number {
  const f = ctx.frame;
  let pen = b.penalties;
  const L = b.layout;
  const seen = new Set<number>();
  let hall = 0, total = 0;
  for (const r of b.floor.rooms) {
    const o = b.ownerOfRoom.get(r.id)!;
    seen.add(o);
    total += r.area;
    if (o === HALL) { hall += r.area; continue; }
    if (o === STAIRS || o < 0) continue;
    const laid = L.rooms[o];
    const loc = r.polygon.map((p) => toLocal(f, p));
    const xs = loc.map((p) => p[0]), ys = loc.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
    const ratio = Math.max(w, d) / Math.max(0.1, Math.min(w, d));
    const weight = ['other', 'ensuite', 'laundry', 'wc', 'entry', 'garage'].includes(laid.type) ? 0.4 : 1;
    if (ratio > 2.2) pen += (ratio - 2.2) * 9 * weight;
    if (Math.min(w, d) < laid.minW * 0.85) pen += 14 * weight;
    const exp = L.expected[o] || laid.target;
    if (laid.target > 0) pen += (Math.abs(r.area - laid.target) / laid.target) * 6 * weight + (Math.abs(r.area - exp) / Math.max(exp, 1)) * 2;
    if (r.polygon.length > 6) pen += (r.polygon.length - 6) * 1.6 * weight;
  }
  for (let o = 1; o < L.rooms.length; o++) if (!seen.has(o) && (o !== STAIRS || L.owner.includes(STAIRS))) pen += 90;
  if (total > 0) pen += Math.max(0, hall / total - 0.15) * 120;
  return -pen;
}

function generateCandidate(input: GeneratorInput): Candidate {
  const env = input.envelope;
  if (!env.floors.length || env.floors.some((f) => (f.footprint?.length ?? 0) < 3)) throw new Error('Draw every floor\'s footprint first.');
  const ctx = context(env);
  const n = ctx.floors.length;
  const rng = mulberry32((input.seed * 2654435761) ^ (input.bedrooms * 97 + input.bathrooms * 13 + input.extras.length * 7));
  const brief: Brief = { bedrooms: input.bedrooms, bathrooms: input.bathrooms, extras: input.extras };
  const programs = buildProgram(brief, ctx.floors.map((f) => f.inner));
  nameRooms(programs);
  const livingBack = input.extras.includes('living-back');
  const G = ctx.floors[0];
  // 1.0 m hallways; 1.25 m only in large homes
  const h = G.inner >= 160 ? 5 : 4;
  const pubShare = (() => {
    const rs = programs[0].rooms;
    const t = rs.reduce((s, r) => s + r.target, 0) || 1;
    return rs.filter((r) => r.zone === 0).reduce((s, r) => s + r.target, 0) / t;
  })();
  const tf = n === 1 ? (livingBack ? 1 - pubShare : pubShare) : livingBack ? 0.4 : 0.6;
  const tfR = Math.round(tf * 20) / 20;

  // the garage is placed first: a fixed rectangle on the street side, linked to the hallway
  const garageSpec = programs[0].rooms.find((r) => r.type === 'garage') ?? null;
  if (garageSpec) programs[0].rooms = programs[0].rooms.filter((r) => r !== garageSpec);
  let garageOpts: (GarageCand | null)[] = [null];
  if (garageSpec) {
    // a double garage on larger floors, but not always: it takes 2.5 m more of the street front,
    // and some seeds try a single one so the rules can choose the layout that works
    const double = G.inner >= 260 || (G.inner >= 170 && rng() < 0.6);
    let gc = double ? garageCandidates(ctx, 'double') : [];
    if (!gc.length) gc = garageCandidates(ctx, 'single');
    if (!gc.length) throw new Error(GARAGE_ERR);
    garageOpts = gc.slice(0, 5);
  }
  interface Combo { garage: GarageCand | null; band: Band; score: number; link: ReturnType<typeof garageLink> }
  const combos: Combo[] = [];
  for (const go of garageOpts) {
    let taken = 0;
    for (const c of spineCandidates(ctx, h, tfR, n > 1, go?.rect ?? null)) {
      const link = go ? garageLink(ctx.grid, c.band, go.rect) : null;
      if (go && !link) continue; // a garage must open onto the hallway
      combos.push({ garage: go, band: c.band, score: c.score + (go?.score ?? 0), link });
      if (++taken >= 4) break;
    }
  }
  combos.sort((a, b) => b.score - a.score);
  if (!combos.length) {
    if (garageSpec) throw new Error(GARAGE_ERR);
    if (n > 1 && spineCandidates(ctx, h, tfR, false).length) throw new Error(STAIRS_ERR);
    throw new Error('These footprints are too narrow for rooms and a hallway (about 4 m wide at least).');
  }
  const pool = combos.filter((c) => c.score >= combos[0].score - Math.max(6, Math.abs(combos[0].score) * 0.2)).slice(0, 4);
  const weights = [0.5, 0.25, 0.15, 0.1].slice(0, pool.length);
  const pick = <T,>(arr: T[], ws: number[]) => {
    let x = rng() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < arr.length; i++) { x -= ws[i]; if (x <= 0) return arr[i]; }
    return arr[arr.length - 1];
  };
  let combo = pick(pool, weights);
  let stairs: Rect | null = null;
  if (n > 1) {
    const order = [combo, ...combos.slice(0, 12).filter((c) => c !== combo)];
    for (const c of order) { stairs = stairsFor(ctx, c.band, rng, livingBack, c.garage?.rect ?? null); if (stairs) { combo = c; break; } }
    if (!stairs) throw new Error(STAIRS_ERR);
  }
  const spine = combo.band;
  let fixedGarage: FixedGarage | null = null;
  if (combo.garage && garageSpec) {
    const r = { ...combo.garage.rect };
    if (combo.link?.grow) r.j0 -= combo.link.grow; // deeper, to meet the hallway: still a rectangle
    fixedGarage = { rect: r, lobby: combo.link?.lobby ?? null, spec: garageSpec };
  }
  const floors: Floor[] = [];
  let score = 0;
  for (let fi = 0; fi < n; fi++) {
    const band = fi === 0 ? spine : stairs ? upperBand(ctx, fi, spine, stairs, h, programs[fi].rooms.length) : bandOnFloor(ctx, fi, spine, stairs);
    const segs = [band, ...branchesFor(ctx, fi, band, stairs, h, fi === 0 ? fixedGarage?.rect ?? null : null)];
    const L = layoutFloor(ctx, fi, programs[fi], segs, stairs, rng, { livingBack }, fi === 0 ? fixedGarage : null);
    const built = buildFloor(ctx, fi, L, rng);
    floors.push(built.floor);
    score += scoreFloor(ctx, built);
  }
  if (ctx.entrance) {
    // the front door should be near the lot's entrance
    const f0 = floors[0];
    const door = f0.openings.find((o) => o.type === 'door' && o.width < 1.2 && f0.walls.find((w) => w.id === o.wallId)?.exterior);
    const w = door && f0.walls.find((x) => x.id === door.wallId);
    if (door && w) {
      const L0 = dist(w.a, w.b) || 1;
      const p: Vec2 = [w.a[0] + ((w.b[0] - w.a[0]) * door.offset) / L0, w.a[1] + ((w.b[1] - w.a[1]) * door.offset) / L0];
      score -= dist(p, ctx.entrance) * 0.25;
    }
  }
  const area = Math.round(env.floors.reduce((s, f) => s + footprintArea(f.footprint), 0));
  const plan: PlanSpec = {
    version: '1.0',
    meta: {
      title: input.title ?? `${input.bedrooms} bed ${input.bathrooms} bath · ${area} m²`,
      createdBy: 'client',
      mode: input.mode ?? 'creative',
      createdAt: new Date(0).toISOString(),
      seed: input.seed,
      stage: 'design',
    },
    ...(env.site ? { site: structuredClone(env.site) } : {}),
    floors,
    requirements: {
      area, floors: n, bedrooms: input.bedrooms, bathrooms: input.bathrooms, extras: [...input.extras],
      ...(input.style ? { style: input.style } : {}), notes: input.notes ?? '',
    },
  };
  return { plan, score };
}

/** One plan for an envelope + brief + seed. Throws a friendly Error when the envelope can't work. */
export function generatePlan(input: GeneratorInput): PlanSpec {
  return generateCandidate(input).plan;
}

/** Signature used to drop duplicate variants. */
export function planSignature(p: PlanSpec): string {
  return p.floors.map((f) => f.rooms.map((r) => `${r.type}:${r.polygon.flat().map((v) => v.toFixed(1)).join(',')}`).sort().join('|')).join('#');
}

/** Score of a generated plan (higher is better); exposed for tests and the variant picker. */
export function planScore(input: GeneratorInput): number {
  return generateCandidate(input).score;
}

/**
 * The best `count` distinct layouts for an envelope + brief, from `tries` seeded candidates.
 * Throws the generator's friendly message when no candidate works.
 */
export function generateVariants(input: Omit<GeneratorInput, 'seed'>, count = 4, baseSeed = 1, tries = count * 6): PlanSpec[] {
  const found: (Candidate & { hard: number; rank: number })[] = [];
  let error: unknown = null;
  for (let s = baseSeed; s < baseSeed + tries; s++) {
    try {
      const c = generateCandidate({ ...input, seed: s });
      // the design rules decide: no broken hard rule first, then the fewest soft-rule penalties
      const report = checkPlan(c.plan);
      found.push({ ...c, hard: report.hard, rank: report.penalty - c.score * 0.5 });
    } catch (e) { error = e; }
  }
  if (!found.length) throw error instanceof Error ? error : new Error('No layout fits these footprints.');
  found.sort((a, b) => a.hard - b.hard || a.rank - b.rank);
  const out: PlanSpec[] = [];
  const seen = new Set<string>();
  for (const c of found) {
    const sig = planSignature(c.plan);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c.plan);
    if (out.length >= count) break;
  }
  return out;
}

/** Layouts offered to the client: only ones that meet every hard design rule. */
export interface Layouts {
  /** distinct layouts breaking no hard rule, best first (empty when none could be found) */
  plans: PlanSpec[];
  reports: Report[];
  /** when nothing meets the rules: the closest attempt and what it breaks (never offered as a layout) */
  closest: { plan: PlanSpec; report: Report } | null;
  /** how many layouts were generated, and how many of them met every rule */
  considered: number;
  compliant: number;
}

/**
 * What a layout looks like, coarsely: the kind of room at every point of a 0.5 m lattice over each
 * floor. Two layouts with the same rooms in the same places have the same fingerprint.
 */
export function layoutFingerprint(p: PlanSpec, step = 0.5): string[][] {
  return p.floors.map((f) => {
    const pts = f.footprint ?? f.rooms.flatMap((r) => r.polygon);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const out: string[] = [];
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
        const r = f.rooms.find((rm) => pointInPolygon([x, y], rm.polygon));
        out.push(r ? kindOf(r) : '');
      }
    }
    return out;
  });
}

/** Share (0–1) of the floor where two layouts of the same floors put the same kind of room. */
export function layoutSimilarity(a: string[][], b: string[][]): number {
  let same = 0, n = 0;
  for (let f = 0; f < Math.min(a.length, b.length); f++) {
    for (let i = 0; i < Math.min(a[f].length, b[f].length); i++) {
      if (!a[f][i] && !b[f][i]) continue;
      n++;
      if (a[f][i] === b[f][i]) same++;
    }
  }
  return n ? same / n : 1;
}

/**
 * The generator's contract with the client: up to `count` distinct layouts that break **no** hard
 * design rule. It tries `tries` seeds, and up to `maxTries` while it has found fewer than `count`
 * compliant ones. A layout that breaks a hard rule is never returned as a plan; when none is
 * compliant, `closest` says how near the best attempt came (for the explanation).
 */
export function generateLayouts(input: Omit<GeneratorInput, 'seed'>, count = 3, baseSeed = 1, tries = 24, maxTries = tries * 2): Layouts {
  const found: (Candidate & { report: Report; rank: number })[] = [];
  const seen = new Set<string>();
  let clean = 0, error: unknown = null;
  for (let s = baseSeed; s < baseSeed + maxTries; s++) {
    if (s >= baseSeed + tries && clean >= Math.min(count, 1) && (clean >= count || s >= baseSeed + tries * 1.5)) break;
    try {
      const c = generateCandidate({ ...input, seed: s });
      const report = checkPlan(c.plan);
      const sig = planSignature(c.plan);
      if (!report.hard && !seen.has(sig)) clean++;
      seen.add(sig);
      found.push({ ...c, report, rank: report.penalty - c.score * 0.5 });
    } catch (e) { error = e; }
  }
  if (!found.length) throw error instanceof Error ? error : new Error('No layout fits these footprints.');
  found.sort((a, b) => a.report.hard - b.report.hard || a.rank - b.rank);
  // the best ones that differ: each next layout is the best-scoring one that isn't too similar to
  // those already picked (mirror images and different arrangements count as different)
  const ok = found.filter((c) => !c.report.hard);
  const prints = ok.map((c) => layoutFingerprint(c.plan));
  const picked: number[] = [];
  for (const cap of [0.8, 0.9, 0.97]) {
    for (let i = 0; i < ok.length && picked.length < count; i++) {
      if (picked.includes(i)) continue;
      if (picked.every((j) => layoutSimilarity(prints[i], prints[j]) < cap)) picked.push(i);
    }
    if (picked.length >= count) break;
  }
  picked.sort((a, b) => a - b);
  return {
    plans: picked.map((i) => ok[i].plan), reports: picked.map((i) => ok[i].report),
    closest: picked.length ? null : { plan: found[0].plan, report: found[0].report },
    considered: found.length, compliant: ok.length,
  };
}

export interface BriefSuggestion { brief: Brief; label: string; change: string }

/**
 * The closest briefs for which compliant layouts exist in these footprints, when the client's own
 * brief has none: fewest changes first (keep bedrooms, then bathrooms, then extras). Each one is
 * checked by actually generating it, within a time budget.
 */
export function suggestBriefs(input: Omit<GeneratorInput, 'seed'>, max = 3, budgetMs = 6000): BriefSuggestion[] {
  const t0 = Date.now();
  const env = input.envelope;
  const plates = env.floors.map((f) => Math.round(footprintArea(f.footprint)));
  const area = plates.reduce((a, b) => a + b, 0);
  const extras = input.extras;
  const cands: { brief: Brief; score: number }[] = [];
  for (let b = input.bedrooms; b >= Math.max(1, input.bedrooms - 2); b--) {
    for (let ba = Math.min(input.bathrooms, b + 1); ba >= Math.max(1, input.bathrooms - 2); ba--) {
      for (let mask = (1 << extras.length) - 1; mask >= 0; mask--) {
        const kept = extras.filter((_, i) => mask & (1 << i));
        for (const open of kept.includes('open-plan') ? [false] : [false, true]) {
          const ex = open ? [...kept, 'open-plan'] : kept;
          if (b === input.bedrooms && ba === input.bathrooms && ex.length === extras.length && !open) continue;
          // keep the bigger extras first (a garage before a laundry); preferences go first
          const score = b * 1000 + ba * 100 + kept.reduce((t, e) => t + 2 + Math.max(0, EXTRAS.find((x) => x.id === e)?.area ?? 0), 0) - (open ? 3 : 0);
          cands.push({ brief: { bedrooms: b, bathrooms: ba, extras: ex }, score });
        }
      }
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const out: BriefSuggestion[] = [];
  for (const c of cands) {
    if (out.length >= max || Date.now() - t0 > budgetMs) break;
    if (!checkFeasibility({ area, floors: plates.length, plates, ...c.brief }).ok) continue;
    try {
      const r = generateLayouts({ ...input, ...c.brief }, 1, 1, 8, 16);
      if (r.plans.length) out.push({ brief: c.brief, label: describe({ ...c.brief, floors: plates.length }), change: briefChange(input, c.brief) });
    } catch { /* this brief doesn't fit either */ }
  }
  return out;
}

/** "2 bathrooms instead of 3, without the study" */
function briefChange(from: Brief, to: Brief): string {
  const parts: string[] = [];
  if (to.bedrooms !== from.bedrooms) parts.push(`${to.bedrooms} bedroom${to.bedrooms === 1 ? '' : 's'} instead of ${from.bedrooms}`);
  if (to.bathrooms !== from.bathrooms) parts.push(`${to.bathrooms} bathroom${to.bathrooms === 1 ? '' : 's'} instead of ${from.bathrooms}`);
  const label = (id: string) => EXTRAS.find((e) => e.id === id)?.label.toLowerCase() ?? id;
  const dropped: Record<string, string> = { 'living-back': 'living room not necessarily at the back', 'master-ground': 'main bedroom upstairs', 'open-plan': 'separate living and kitchen' };
  for (const e of from.extras) if (!to.extras.includes(e)) parts.push(dropped[e] ?? `without the ${label(e)}`);
  for (const e of to.extras) if (!from.extras.includes(e)) parts.push(e === 'open-plan' ? 'open-plan living' : `with ${label(e)}`);
  return parts.join(', ');
}

/** The envelope part of a plan (lot + footprints), ready for the generator. */
export function envelopeOfPlan(plan: PlanSpec): Envelope {
  return {
    site: plan.site,
    floors: plan.floors.map((f) => ({ level: f.level, height: f.height, footprint: f.footprint ?? [] })),
  };
}

/** Generated floors keep the client's floor heights; everything else about the plan stays. */
export function applyLayout(plan: PlanSpec, layout: PlanSpec): PlanSpec {
  return {
    ...plan,
    meta: { ...plan.meta, seed: layout.meta.seed, stage: 'design' },
    floors: layout.floors.map((f, i) => ({ ...f, height: plan.floors[i]?.height ?? f.height, footprint: plan.floors[i]?.footprint ?? f.footprint })),
    requirements: layout.requirements,
  };
}

export const roundArea = r1;
