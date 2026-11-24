/**
 * Design rules: what makes a floor plan logical, written down so it can be checked.
 *
 * The generator must satisfy every HARD rule (a candidate that breaks one is thrown away) and
 * minimises SOFT-rule penalties when it ranks layouts. The same checker runs on hand-drawn plans
 * in the workspace ("Design check"), so it only reads the PlanSpec: rooms, walls, doors, windows,
 * the lot and its street.
 *
 * Four families:
 *  - shape       rooms that must be rectangles (garage, wet rooms, entry, robes), a clear
 *                rectangle every room must contain, door clearances, corner counts
 *  - size        minimum and maximum areas per room kind, garage fit for a car
 *  - proportion  room sizes relative to each other (main bedroom ≥ bedrooms ≥ bathrooms…)
 *  - placement   privacy, security and convenience (bedrooms off the hallway, garage door to the
 *                street, front door in the entry, wet rooms grouped, kitchen beside living…)
 */
import type { PlanSpec, Floor, Room, Wall, Opening } from '@shared/planspec/schema';
import { floorLabel } from '@shared/planspec/schema';
import { wallLine } from '@shared/planspec/envelope';
import { frontEdge, outwardNormal } from '@shared/planspec/site';
import { dist, pointInPolygon, polygonArea, polygonInPolygon, simplifyPolygon, type Vec2 } from '@shared/util/geometry';
import { chooseFrame, toLocal, dirToLocal, type Frame } from './raster';

export type RuleKind = 'shape' | 'size' | 'proportion' | 'placement';
export type Severity = 'hard' | 'soft';
export interface Issue { message: string; roomId?: string; level?: number; weight?: number }
export interface RuleResult { id: string; title: string; kind: RuleKind; severity: Severity; why: string; ok: boolean; issues: Issue[] }
export interface Report { results: RuleResult[]; hard: number; soft: number; penalty: number; byKind: Record<RuleKind, number> }

/**
 * A layout's score out of 100 (overall, or one family of rules): 100 with no penalty, falling
 * smoothly as preference penalties add up; 0 when a hard rule is broken.
 */
export function designScore(r: Report, kind?: RuleKind): number {
  if (r.hard) return 0;
  const pen = kind ? r.byKind[kind] : r.penalty;
  const k = kind ? 40 : 120;
  return Math.round((100 * k) / (k + pen));
}

/** What a room is, from its type and name (the generator and the editor share these names). */
export type Kind = 'garage' | 'entry' | 'living' | 'livingKitchen' | 'family' | 'kitchen' | 'dining' | 'study' | 'laundry' | 'wc' | 'bathroom'
  | 'ensuite' | 'master' | 'bedroom' | 'robe' | 'storage' | 'retreat' | 'hall' | 'stairs' | 'open' | 'other';

export function kindOf(r: Pick<Room, 'type' | 'name'>): Kind {
  const n = r.name.toLowerCase();
  switch (r.type) {
    case 'living': return /kitchen/.test(n) ? 'livingKitchen' : /family|rumpus|sitting|games|media/.test(n) ? 'family' : 'living';
    case 'hallway': return 'hall';
    case 'other': return /robe/.test(n) ? 'robe' : /storage|store|linen/.test(n) ? 'storage' : /retreat|sitting|lounge/.test(n) ? 'retreat' : /open space/.test(n) ? 'open' : 'other';
    default: return r.type as Kind;
  }
}
const PRIVATE: Kind[] = ['master', 'bedroom', 'bathroom', 'ensuite', 'robe', 'wc'];
const HABITABLE: Kind[] = ['master', 'bedroom', 'living', 'livingKitchen', 'family', 'kitchen', 'dining', 'study', 'retreat'];
const WET: Kind[] = ['bathroom', 'ensuite', 'laundry', 'wc', 'kitchen', 'livingKitchen'];

/**
 * Per kind: area range (m², measured to wall centres), the clear rectangle the room must contain
 * (m, either way round), the longest side over the shortest of the room's extent, and its shape:
 * `rect` must be a rectangle, `simple` at most an L (6 corners), `free` up to 8 corners.
 */
export const ROOM_RULES: Partial<Record<Kind, { min: number; max: number; clear: [number, number]; aspect: number; shape: 'rect' | 'simple' | 'free' }>> = {
  master: { min: 12, max: 26, clear: [3.0, 3.4], aspect: 1.9, shape: 'simple' },
  bedroom: { min: 9, max: 17, clear: [2.7, 3.0], aspect: 1.9, shape: 'simple' },
  bathroom: { min: 4, max: 8.5, clear: [1.6, 2.1], aspect: 2.6, shape: 'rect' },
  ensuite: { min: 3.5, max: 7.5, clear: [1.5, 2.0], aspect: 2.6, shape: 'rect' },
  wc: { min: 1.4, max: 3.6, clear: [0.9, 1.4], aspect: 3.2, shape: 'rect' },
  laundry: { min: 3.5, max: 8, clear: [1.5, 1.8], aspect: 3, shape: 'rect' },
  kitchen: { min: 7, max: 20, clear: [2.4, 2.7], aspect: 2.6, shape: 'simple' },
  living: { min: 14, max: 50, clear: [3.3, 3.6], aspect: 2.4, shape: 'free' },
  livingKitchen: { min: 20, max: 70, clear: [3.3, 3.6], aspect: 2.6, shape: 'free' },
  family: { min: 11, max: 32, clear: [3.0, 3.3], aspect: 2.4, shape: 'free' },
  dining: { min: 8, max: 20, clear: [2.7, 3.0], aspect: 2.2, shape: 'simple' },
  study: { min: 6, max: 14, clear: [2.4, 2.4], aspect: 2.2, shape: 'simple' },
  retreat: { min: 7, max: 22, clear: [2.7, 2.7], aspect: 2.4, shape: 'simple' },
  entry: { min: 2.5, max: 9, clear: [1.4, 1.8], aspect: 4.5, shape: 'rect' },
  robe: { min: 1.8, max: 6, clear: [1.1, 1.4], aspect: 3.2, shape: 'rect' },
  storage: { min: 1.2, max: 7, clear: [0.9, 1.2], aspect: 4, shape: 'rect' },
};
/** A garage must take a car: centre-line size of a single (3.25 × 6 m) and a double (5.75 × 6 m) garage. */
export const GARAGE = { single: [3.25, 6.0] as [number, number], double: [5.75, 6.0] as [number, number], doorSingle: 2.4, doorDouble: 4.8, maxArea: 42 };
/** Glazing (window width × height) a lived-in room should have, as a share of its floor area. */
export const GLAZING = 0.1;
/** Every door opens onto a clear square this big on both sides. */
export const DOOR_CLEAR = 0.8;
/** Widest a hallway may be anywhere (m), and how far over its maximum a room may grow. */
export const HALL_MAX = 2.6;
export const OVERSIZE = 1.5;
/** How far past its kind's proportion limit a room may stretch before it is a corridor. */
export const ASPECT_HARD = 1.5;

// ---------------------------------------------------------------------------------------------
// geometry helpers on the finished plan
// ---------------------------------------------------------------------------------------------

interface RoomInfo { room: Room; kind: Kind; level: number; local: Vec2[]; corners: number; bboxW: number; bboxH: number; rectangularity: number; slanted: boolean }
interface DoorInfo { o: Opening; wall: Wall; level: number; c: Vec2; n: Vec2; rooms: RoomInfo[]; exterior: boolean }

const opPoint = (w: Wall, o: Opening): Vec2 => {
  const L = dist(w.a, w.b) || 1;
  return [w.a[0] + ((w.b[0] - w.a[0]) * o.offset) / L, w.a[1] + ((w.b[1] - w.a[1]) * o.offset) / L];
};

/** Does the polygon contain an axis-aligned (local frame) rectangle a × b, either way round? */
export function containsRect(local: Vec2[], a: number, b: number, cell = 0.125): boolean {
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / cell - 1e-6), ny = Math.ceil((Math.max(...ys) - y0) / cell - 1e-6);
  if (nx <= 0 || ny <= 0) return false;
  const P = new Int32Array((nx + 1) * (ny + 1));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const inside = pointInPolygon([x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell], local) ? 1 : 0;
    P[(j + 1) * (nx + 1) + i + 1] = inside + P[j * (nx + 1) + i + 1] + P[(j + 1) * (nx + 1) + i] - P[j * (nx + 1) + i];
  }
  const fits = (w: number, h: number) => {
    const cw = Math.ceil(w / cell - 1e-6), ch = Math.ceil(h / cell - 1e-6);
    for (let j = 0; j + ch <= ny; j++) for (let i = 0; i + cw <= nx; i++) {
      const s = P[(j + ch) * (nx + 1) + i + cw] - P[j * (nx + 1) + i + cw] - P[(j + ch) * (nx + 1) + i] + P[j * (nx + 1) + i];
      if (s === cw * ch) return true;
    }
    return false;
  };
  return fits(a, b) || fits(b, a);
}

/** Narrower than this (m), a part of a room is a leftover limb, not living space. */
export const THIN_W = 2.0;

/**
 * Share (0–1) of a room's area lying in parts narrower than `w`: the cells (local frame) that no
 * w × w square inside the room covers.
 */
export function thinShare(local: Vec2[], w: number, cell = 0.25): number {
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / cell - 1e-6), ny = Math.ceil((Math.max(...ys) - y0) / cell - 1e-6);
  if (nx <= 0 || ny <= 0) return 0;
  const W = nx + 1;
  const P = new Int32Array(W * (ny + 1));
  const inside = new Uint8Array(nx * ny);
  let total = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = pointInPolygon([x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell], local) ? 1 : 0;
    inside[j * nx + i] = v; total += v;
    P[(j + 1) * W + i + 1] = v + P[j * W + i + 1] + P[(j + 1) * W + i] - P[j * W + i];
  }
  if (!total) return 0;
  const c = Math.max(1, Math.round(w / cell));
  // difference array of the cells covered by a full c × c square
  const D = new Int32Array((nx + 1) * (ny + 1));
  for (let j = 0; j + c <= ny; j++) for (let i = 0; i + c <= nx; i++) {
    if (P[(j + c) * W + i + c] - P[j * W + i + c] - P[(j + c) * W + i] + P[j * W + i] !== c * c) continue;
    D[j * (nx + 1) + i]++; D[j * (nx + 1) + i + c]--; D[(j + c) * (nx + 1) + i]--; D[(j + c) * (nx + 1) + i + c]++;
  }
  let covered = 0;
  const row = new Int32Array(nx + 1);
  for (let j = 0; j < ny; j++) {
    let run = 0;
    for (let i = 0; i < nx; i++) { row[i] += D[j * (nx + 1) + i]; run += row[i]; if (run > 0 && inside[j * nx + i]) covered++; }
    row[nx] += D[j * (nx + 1) + nx];
  }
  return 1 - covered / total;
}

/** Length of wall the two rooms share. */
export function sharedLength(A: Vec2[], B: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < A.length; i++) {
    const a0 = A[i], a1 = A[(i + 1) % A.length];
    const L = dist(a0, a1);
    if (L < 1e-6) continue;
    const ux = (a1[0] - a0[0]) / L, uy = (a1[1] - a0[1]) / L;
    for (let j = 0; j < B.length; j++) {
      const b0 = B[j], b1 = B[(j + 1) % B.length];
      const off = (p: Vec2) => Math.abs((p[0] - a0[0]) * uy - (p[1] - a0[1]) * ux);
      if (off(b0) > 0.02 || off(b1) > 0.02) continue;
      const t0 = (b0[0] - a0[0]) * ux + (b0[1] - a0[1]) * uy, t1 = (b1[0] - a0[0]) * ux + (b1[1] - a0[1]) * uy;
      total += Math.max(0, Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
    }
  }
  return total;
}

function frameFor(plan: PlanSpec): { frame: Frame; front: Vec2 | null } {
  const fp = plan.floors[0]?.footprint;
  const site = plan.site;
  let front: Vec2 | null = null;
  if (site?.boundary) { const fe = frontEdge(site); if (fe !== null) front = outwardNormal(site.boundary, fe); }
  const ground = fp ? wallLine(fp) : plan.floors[0].walls.flatMap((w) => [w.a, w.b]);
  return { frame: chooseFrame(ground.length >= 3 ? ground : [[0, 0], [1, 0], [1, 1]], front), front };
}

function analyse(plan: PlanSpec) {
  const { frame, front } = frameFor(plan);
  const rooms: RoomInfo[] = [];
  const doors: DoorInfo[] = [];
  const windows: { o: Opening; level: number; c: Vec2; room?: RoomInfo; n: Vec2 }[] = [];
  plan.floors.forEach((f) => {
    const here: RoomInfo[] = f.rooms.map((room) => {
      const local = room.polygon.map((p) => toLocal(frame, p));
      const simple = simplifyPolygon(local, 0.01);
      const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
      const bboxW = Math.max(...xs) - Math.min(...xs), bboxH = Math.max(...ys) - Math.min(...ys);
      // a side that isn't square to the grid can only be a slanted outside wall
      const slanted = simple.some((p, i) => { const q = simple[(i + 1) % simple.length]; return Math.abs(p[0] - q[0]) > 0.02 && Math.abs(p[1] - q[1]) > 0.02; });
      return { room, kind: kindOf(room), level: f.level, local, corners: simple.length, bboxW, bboxH, rectangularity: polygonArea(local) / Math.max(1e-6, bboxW * bboxH), slanted };
    });
    rooms.push(...here);
    const walls = new Map(f.walls.map((w) => [w.id, w]));
    for (const o of f.openings) {
      const w = walls.get(o.wallId);
      if (!w) continue;
      const c = opPoint(w, o);
      const L = dist(w.a, w.b) || 1;
      const n: Vec2 = [-(w.b[1] - w.a[1]) / L, (w.b[0] - w.a[0]) / L];
      // the rooms on either side: probe just past each face of the wall
      const off = w.thickness / 2 + 0.15;
      const sides = [1, -1].map((sg) => here.find((r) => pointInPolygon([c[0] + n[0] * off * sg, c[1] + n[1] * off * sg], r.room.polygon)));
      const touching = [...new Set(sides.filter((r): r is RoomInfo => !!r))];
      const exterior = touching.length < 2 || sides.some((r) => !r);
      if (o.type === 'door') doors.push({ o, wall: w, level: f.level, c, n, rooms: touching, exterior });
      else windows.push({ o, level: f.level, c, room: touching[0], n });
    }
  });
  return { frame, front, rooms, doors, windows };
}

// ---------------------------------------------------------------------------------------------
// the rules
// ---------------------------------------------------------------------------------------------

type A = ReturnType<typeof analyse>;
interface Rule { id: string; title: string; kind: RuleKind; severity: Severity; why: string; check: (a: A, plan: PlanSpec) => Issue[] }
const at = (r: RoomInfo, msg: string, weight = 1): Issue => ({ message: `${r.room.name}${r.level > 0 ? ` (${floorLabel(r.level).toLowerCase()})` : ''}: ${msg}`, roomId: r.room.id, level: r.level, weight });
const fmt = (v: number) => v.toFixed(1);
const doorsOf = (a: A, r: RoomInfo) => a.doors.filter((d) => d.rooms.includes(r));
const others = (d: DoorInfo, r: RoomInfo) => d.rooms.filter((x) => x !== r);
const facesStreet = (a: A, d: { n: Vec2; c: Vec2 }, r: RoomInfo) => {
  if (!a.front) return true;
  // outward normal of the wall at this opening (away from the room)
  const probe: Vec2 = [d.c[0] + d.n[0] * 0.3, d.c[1] + d.n[1] * 0.3];
  const out: Vec2 = pointInPolygon(probe, r.room.polygon) ? [-d.n[0], -d.n[1]] : d.n;
  return out[0] * a.front[0] + out[1] * a.front[1] > 0.5;
};

export const RULES: Rule[] = [
  // ---------------- shape ----------------
  {
    id: 'garage-rect', kind: 'shape', severity: 'hard', title: 'The garage is a rectangle a car fits in',
    why: 'Cars need a straight, unobstructed bay: at least 3.25 × 6 m for one car, 5.75 × 6 m for two (to wall centres).',
    check: (a) => a.rooms.filter((r) => r.kind === 'garage').flatMap((r) => {
      const out: Issue[] = [];
      if (r.corners !== 4 || r.rectangularity < 0.99) out.push(at(r, `not a rectangle (${r.corners} corners)`));
      const [s, l] = [Math.min(r.bboxW, r.bboxH), Math.max(r.bboxW, r.bboxH)];
      if (s < GARAGE.single[0] - 0.05 || l < GARAGE.single[1] - 0.05) out.push(at(r, `${fmt(s)} × ${fmt(l)} m is too small for a car (3.25 × 6 m)`));
      return out;
    }),
  },
  {
    id: 'rect-rooms', kind: 'shape', severity: 'hard', title: 'Wet rooms, the entry and robes are rectangles',
    why: 'Bathrooms, laundries, toilets, robes and the entry are fitted out along straight walls; odd corners waste them. Only a slanted outside wall may cut one corner off.',
    check: (a) => a.rooms.filter((r) => ROOM_RULES[r.kind]?.shape === 'rect' && r.room.name !== 'Open space').flatMap((r) => {
      const ok = r.slanted ? r.corners <= 5 : r.corners === 4 && r.rectangularity > 0.98;
      return ok ? [] : [at(r, `has ${r.corners} corners; it should be a plain rectangle`)];
    }),
  },
  {
    id: 'clear-rect', kind: 'shape', severity: 'hard', title: 'Every room has a usable clear rectangle',
    why: 'A bedroom must fit a bed with space round it, a bathroom its fittings: area alone is not enough when a room is narrow or oddly shaped.',
    check: (a) => a.rooms.flatMap((r) => {
      const rule = ROOM_RULES[r.kind];
      if (!rule) return [];
      const [w, h] = rule.clear;
      return containsRect(r.local, w - 0.01, h - 0.01) ? [] : [at(r, `no clear ${w} × ${h} m space in it`)];
    }),
  },
  {
    id: 'simple-shapes', kind: 'shape', severity: 'soft', title: 'Rooms keep simple shapes',
    why: 'Bedrooms and kitchens at most an L, living areas at most 8 corners: every extra corner is furniture that doesn\'t fit.',
    check: (a) => a.rooms.flatMap((r) => {
      const rule = ROOM_RULES[r.kind];
      if (!rule || rule.shape === 'rect') return [];
      const max = rule.shape === 'simple' ? 6 : 8;
      return r.corners > max ? [at(r, `${r.corners} corners`, (r.corners - max) * 2)] : [];
    }),
  },
  {
    id: 'room-corners', kind: 'shape', severity: 'hard', title: 'No room has more than 8 corners',
    why: 'An L with a notch or two is livable; beyond 8 corners a room is leftover space wrapped round other rooms.',
    check: (a) => a.rooms.filter((r) => r.kind !== 'hall' && r.kind !== 'open' && r.kind !== 'stairs').flatMap((r) => (r.corners > 8 ? [at(r, `${r.corners} corners`)] : [])),
  },
  {
    id: 'bedroom-shape', kind: 'shape', severity: 'hard', title: 'Bedrooms are a rectangle or a simple L',
    why: 'A bed, wardrobes and a way round them need plain walls: a bedroom wrapped round a bathroom or the stairs (a U or a Z, more than 6 corners; one more where a slanted outside wall cuts it) is leftover space with a bed in it.',
    check: (a) => a.rooms.filter((r) => r.kind === 'master' || r.kind === 'bedroom').flatMap((r) => (r.corners > (r.slanted ? 7 : 6) ? [at(r, `${r.corners} corners`)] : [])),
  },
  {
    id: 'hall-corridor', kind: 'shape', severity: 'hard', title: 'Hallways are corridors, not rooms',
    why: `A hallway wider than ${HALL_MAX} m anywhere is space nobody lives in: it should be a room, or part of one.`,
    check: (a) => a.rooms.filter((r) => r.kind === 'hall').flatMap((r) => (containsRect(r.local, HALL_MAX + 0.01, HALL_MAX + 0.01) ? [at(r, `is wider than ${HALL_MAX} m in places`)] : [])),
  },
  {
    id: 'not-corridors', kind: 'shape', severity: 'hard', title: 'Rooms are not corridors',
    why: `A room more than ${ASPECT_HARD} × longer than its kind allows (a 1.75 × 8 m bathroom, a 12 m deep kitchen) is a corridor with fittings in it.`,
    check: (a) => a.rooms.flatMap((r) => {
      const rule = ROOM_RULES[r.kind];
      if (!rule) return [];
      const ratio = Math.max(r.bboxW, r.bboxH) / Math.max(0.1, Math.min(r.bboxW, r.bboxH));
      return ratio > rule.aspect * ASPECT_HARD ? [at(r, `${fmt(ratio)} : 1, a corridor`)] : [];
    }),
  },
  {
    id: 'proportions', kind: 'shape', severity: 'soft', title: 'Rooms are not long and thin',
    why: 'A room much longer than it is wide is a corridor with furniture in it.',
    check: (a) => a.rooms.flatMap((r) => {
      const rule = ROOM_RULES[r.kind];
      if (!rule) return [];
      const ratio = Math.max(r.bboxW, r.bboxH) / Math.max(0.1, Math.min(r.bboxW, r.bboxH));
      return ratio > rule.aspect ? [at(r, `${fmt(ratio)} : 1`, (ratio - rule.aspect) * 6)] : [];
    }),
  },
  {
    id: 'no-thin-limbs', kind: 'shape', severity: 'soft', title: 'Rooms have no narrow leftover limbs',
    why: `A part of a room narrower than ${THIN_W} m (a leg wrapped round the garage or the stairs, a strip behind a bathroom) can't be furnished or lived in: it is corridor the room has to pay for.`,
    check: (a) => a.rooms.filter((r) => !['hall', 'stairs', 'open', 'garage', 'entry', 'robe', 'storage', 'wc', 'ensuite', 'bathroom', 'laundry'].includes(r.kind) && r.corners > 4).flatMap((r) => {
      const share = thinShare(r.local, THIN_W);
      return share > 0.12 ? [at(r, `${Math.round(share * 100)} % of it is narrower than ${THIN_W} m`, 2 + share * 25)] : [];
    }),
  },
  {
    id: 'door-clear', kind: 'shape', severity: 'hard', title: 'Doors open onto clear space',
    why: `Each doorway needs a clear ${DOOR_CLEAR} × ${DOOR_CLEAR} m square on both sides, not a wall or a corner.`,
    check: (a) => a.doors.filter((d) => !d.exterior && d.o.width < 1.3).flatMap((d) => {
      const out: Issue[] = [];
      for (const s of [1, -1]) {
        const ux = (d.wall.b[0] - d.wall.a[0]) / dist(d.wall.a, d.wall.b), uy = (d.wall.b[1] - d.wall.a[1]) / dist(d.wall.a, d.wall.b);
        const h = DOOR_CLEAR / 2, off = d.wall.thickness / 2 + 0.01;
        const sq: Vec2[] = [[-h, off], [h, off], [h, off + DOOR_CLEAR], [-h, off + DOOR_CLEAR]].map(([t, n]) => [d.c[0] + ux * t + d.n[0] * n * s, d.c[1] + uy * t + d.n[1] * n * s]);
        const mid: Vec2 = [d.c[0] + d.n[0] * (off + h) * s, d.c[1] + d.n[1] * (off + h) * s];
        const room = d.rooms.find((r) => pointInPolygon(mid, r.room.polygon));
        if (!room || !polygonInPolygon(sq, room.room.polygon, 0.06)) out.push({ message: `A door ${room ? `into ${room.room.name}` : `on ${floorLabel(d.level).toLowerCase()}`} opens against a wall`, roomId: room?.room.id, level: d.level });
      }
      return out;
    }),
  },

  // ---------------- size ----------------
  {
    id: 'min-size', kind: 'size', severity: 'hard', title: 'Rooms meet minimum sizes',
    why: 'Below these areas a room can\'t hold what it is for (e.g. a bedroom under 9 m², a bathroom under 4 m²).',
    check: (a) => a.rooms.flatMap((r) => {
      const rule = ROOM_RULES[r.kind];
      return rule && r.room.area < rule.min - 0.05 ? [at(r, `${fmt(r.room.area)} m², under ${rule.min} m²`)] : [];
    }),
  },
  {
    id: 'max-size', kind: 'size', severity: 'soft', title: 'Rooms are not oversized',
    why: 'Space is better spent on another room than on a 25 m² bathroom or a bedroom bigger than the living room.',
    check: (a) => a.rooms.flatMap((r) => {
      const rule = r.kind === 'garage' ? { max: GARAGE.maxArea } : ROOM_RULES[r.kind];
      return rule && r.room.area > rule.max ? [at(r, `${fmt(r.room.area)} m², over ${rule.max} m²`, (r.room.area / rule.max - 1) * 20)] : [];
    }),
  },
  {
    id: 'way-oversized', kind: 'size', severity: 'hard', title: 'No room is grossly oversized',
    why: `More than ${OVERSIZE} × a room's largest sensible size (a 30 m² study, a 45 m² kitchen) means spare space was dumped into it: it should be another room.`,
    check: (a) => a.rooms.flatMap((r) => {
      const rule = r.kind === 'garage' ? { max: GARAGE.maxArea } : ROOM_RULES[r.kind];
      return rule && r.room.area > rule.max * OVERSIZE ? [at(r, `${fmt(r.room.area)} m², more than ${OVERSIZE} × ${rule.max} m²`)] : [];
    }),
  },
  {
    id: 'hall-share', kind: 'size', severity: 'soft', title: 'Hallways stay compact',
    why: 'Circulation over about 15 % of a floor is space nobody lives in.',
    check: (a, plan) => plan.floors.flatMap((f) => {
      const rs = a.rooms.filter((r) => r.level === f.level);
      const total = rs.reduce((s, r) => s + r.room.area, 0), hall = rs.filter((r) => r.kind === 'hall').reduce((s, r) => s + r.room.area, 0);
      return total && hall / total > 0.15 ? [{ message: `${floorLabel(f.level)}: hallways are ${Math.round((hall / total) * 100)} % of the floor`, level: f.level, weight: 1 + (hall / total - 0.15) * 150 }] : [];
    }),
  },

  // ---------------- proportion ----------------
  {
    id: 'master-largest', kind: 'proportion', severity: 'hard', title: 'The main bedroom is the largest bedroom',
    why: 'Otherwise it isn\'t the main bedroom.',
    check: (a) => {
      const m = a.rooms.find((r) => r.kind === 'master');
      if (!m) return [];
      return a.rooms.filter((r) => r.kind === 'bedroom' && r.room.area > m.room.area + 0.3).map((r) => at(r, `${fmt(r.room.area)} m² is bigger than the main bedroom (${fmt(m.room.area)} m²)`));
    },
  },
  {
    id: 'master-distinct', kind: 'proportion', severity: 'soft', title: 'The main bedroom is clearly the main bedroom',
    why: 'It holds the largest bed and two people: at least a tenth bigger than any other bedroom, not the same room with a different name.',
    check: (a) => {
      const m = a.rooms.find((r) => r.kind === 'master');
      const big = Math.max(0, ...a.rooms.filter((r) => r.kind === 'bedroom').map((r) => r.room.area));
      return m && big > 0 && m.room.area < big * 1.1 ? [at(m, `${fmt(m.room.area)} m² against a ${fmt(big)} m² bedroom`, 3 + Math.min(4, (big * 1.1 - m.room.area)))] : [];
    },
  },
  {
    id: 'bedrooms-even', kind: 'proportion', severity: 'soft', title: 'Secondary bedrooms are similar sizes',
    why: 'Children\'s and guest bedrooms should be comparable: the biggest at most 1.5 × the smallest.',
    check: (a) => {
      const bs = a.rooms.filter((r) => r.kind === 'bedroom').map((r) => r.room.area);
      if (bs.length < 2) return [];
      const ratio = Math.max(...bs) / Math.min(...bs);
      return ratio > 1.5 ? [{ message: `bedrooms range from ${fmt(Math.min(...bs))} to ${fmt(Math.max(...bs))} m²`, weight: (ratio - 1.5) * 12 }] : [];
    },
  },
  {
    id: 'bath-vs-bed', kind: 'proportion', severity: 'hard', title: 'Bathrooms are smaller than bedrooms',
    why: 'A bathroom bigger than the bedrooms it serves is wasted space; an ensuite stays well under its bedroom.',
    check: (a) => {
      const beds = a.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master');
      if (!beds.length) return [];
      const smallest = Math.min(...beds.map((r) => r.room.area));
      const m = a.rooms.find((r) => r.kind === 'master');
      return a.rooms.flatMap((r) => {
        if (r.kind === 'bathroom' && r.room.area > smallest * 0.8) return [at(r, `${fmt(r.room.area)} m² against a ${fmt(smallest)} m² bedroom`)];
        if (r.kind === 'ensuite' && m && r.room.area > m.room.area * 0.6) return [at(r, `${fmt(r.room.area)} m² against the ${fmt(m.room.area)} m² main bedroom`)];
        if (r.kind === 'robe' && m && r.room.area > m.room.area * 0.45) return [at(r, `too big next to the main bedroom`)];
        if ((r.kind === 'laundry' || r.kind === 'wc' || r.kind === 'storage') && r.room.area > smallest) return [at(r, `bigger than a bedroom`)];
        return [];
      });
    },
  },
  {
    id: 'living-largest', kind: 'proportion', severity: 'soft', title: 'The living room is the largest room',
    why: 'Everyone shares it; it should beat any bedroom, and the kitchen shouldn\'t outgrow it.',
    check: (a) => {
      const living = a.rooms.filter((r) => r.kind === 'living' || r.kind === 'livingKitchen');
      if (!living.length) return [];
      const L = Math.max(...living.map((r) => r.room.area));
      // nothing on the living room's own floor outranks it, and no bedroom anywhere does
      const lv = Math.min(...living.map((r) => r.level));
      const rivals: Kind[] = ['kitchen', 'dining', 'study', 'family', 'retreat', 'laundry'];
      return a.rooms.flatMap((r) => ((r.kind === 'master' || r.kind === 'bedroom') && r.room.area > L) || (rivals.includes(r.kind) && r.level === lv && r.room.area > L * 1.02)
        ? [at(r, `${fmt(r.room.area)} m² beats the living room (${fmt(L)} m²)`, 8 + Math.min(12, (r.room.area / L - 1) * 20))] : []);
    },
  },

  // ---------------- placement ----------------
  {
    id: 'private-off-hall', kind: 'placement', severity: 'hard', title: 'Bedrooms and bathrooms open off the hallway',
    why: 'Privacy: nobody should walk through the living room, the kitchen, the garage or another bedroom to reach a bedroom or a bathroom.',
    check: (a) => a.rooms.filter((r) => PRIVATE.includes(r.kind)).flatMap((r) => {
      const allowed: Kind[] = r.kind === 'ensuite' || r.kind === 'robe' ? ['master'] : r.kind === 'master' ? ['hall', 'ensuite', 'robe'] : r.kind === 'wc' ? ['hall', 'entry', 'laundry'] : ['hall'];
      const ds = doorsOf(a, r).filter((d) => !d.exterior);
      if (!ds.length) return [at(r, 'has no door')];
      const bad = ds.flatMap((d) => others(d, r)).filter((o) => !allowed.includes(o.kind));
      const fromHall = ds.some((d) => others(d, r).some((o) => allowed.includes(o.kind)));
      return [...bad.map((o) => at(r, `opens into ${o.room.name}`)), ...(fromHall ? [] : [at(r, 'is not reached from the hallway')])];
    }),
  },
  {
    id: 'reachable', kind: 'placement', severity: 'hard', title: 'Every room is reachable from the front door',
    why: 'Through the entry, hallways and living spaces, and up the stairs, without passing through someone\'s bedroom.',
    check: (a) => {
      const transit: Kind[] = ['hall', 'entry', 'living', 'livingKitchen', 'family', 'kitchen', 'dining', 'stairs', 'open', 'laundry'];
      const front = a.doors.filter((d) => d.exterior && d.level === 0 && d.o.width < 2).flatMap((d) => d.rooms);
      const seen = new Set<RoomInfo>(front);
      const q = [...front];
      while (q.length) {
        const r = q.shift()!;
        if (!transit.includes(r.kind) && r.kind !== 'master') continue;
        // the main bedroom only leads on to its own ensuite and robe
        let next = [...doorsOf(a, r).flatMap((d) => others(d, r)), ...(r.kind === 'stairs' ? a.rooms.filter((x) => x.kind === 'stairs' && x !== r) : [])];
        if (r.kind === 'master') next = next.filter((n) => n.kind === 'ensuite' || n.kind === 'robe');
        for (const n of next) if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
      return a.rooms.filter((r) => !seen.has(r) && r.kind !== 'garage').map((r) => at(r, 'can\'t be reached from the front door'));
    },
  },
  {
    id: 'garage-street', kind: 'placement', severity: 'hard', title: 'The garage door faces the street, the garage opens into the house',
    why: 'Security and convenience: cars come from the street, and the garage connects to the hallway, entry, laundry or kitchen, never to a bedroom or bathroom.',
    check: (a) => a.rooms.filter((r) => r.kind === 'garage').flatMap((r) => {
      const ds = doorsOf(a, r);
      const car = ds.filter((d) => d.exterior && d.o.width >= GARAGE.doorSingle - 0.01);
      const out: Issue[] = [];
      if (!car.length) out.push(at(r, 'no car door in an outside wall'));
      else if (!car.some((d) => facesStreet(a, d, r))) out.push(at(r, 'its car door doesn\'t face the street'));
      const inside = ds.filter((d) => !d.exterior).flatMap((d) => others(d, r));
      if (!inside.length) out.push(at(r, 'no door into the house'));
      for (const o of inside) if (!['hall', 'entry', 'laundry', 'kitchen', 'livingKitchen', 'storage'].includes(o.kind)) out.push(at(r, `opens into ${o.room.name}`));
      return out;
    }),
  },
  {
    id: 'front-door', kind: 'placement', severity: 'hard', title: 'The front door is on the street side, into the entry',
    why: 'Visitors arrive from the street; the front door leads into the entry or hallway, never straight into a bedroom or a wet room.',
    check: (a) => {
      const fd = a.doors.filter((d) => d.exterior && d.level === 0 && d.o.width < 2 && !d.rooms.some((r) => r.kind === 'garage'));
      if (!fd.length) return [{ message: 'there is no front door' }];
      const out: Issue[] = [];
      const d = fd[0], r = d.rooms[0];
      if (r && !['entry', 'hall', 'living', 'livingKitchen', 'family', 'dining'].includes(r.kind)) out.push(at(r, 'the front door opens into it'));
      if (r && !facesStreet(a, d, r)) out.push({ message: 'the front door doesn\'t face the street' });
      if (r && r.kind !== 'entry' && a.rooms.some((x) => x.kind === 'entry')) out.push(at(r, 'has the front door although there is an entry'));
      return out;
    },
  },
  {
    id: 'daylight', kind: 'placement', severity: 'hard', title: 'Bedrooms and living rooms have a window',
    why: 'Daylight and fresh air, and a way out in a fire for bedrooms.',
    check: (a) => a.rooms.filter((r) => ['master', 'bedroom', 'living', 'livingKitchen', 'family'].includes(r.kind)).flatMap((r) => (a.windows.some((w) => w.room === r) ? [] : [at(r, 'has no window')])),
  },
  {
    id: 'daylight-other', kind: 'placement', severity: 'soft', title: 'Kitchen, dining and study have a window',
    why: 'They are lived in all day.',
    check: (a) => a.rooms.filter((r) => ['kitchen', 'dining', 'study', 'retreat'].includes(r.kind)).flatMap((r) => (a.windows.some((w) => w.room === r) ? [] : [at(r, 'has no window', 6)])),
  },
  {
    id: 'kitchen-living', kind: 'placement', severity: 'hard', title: 'The kitchen sits beside the living or dining room',
    why: 'Cooking, eating and living are one daily circuit.',
    check: (a) => a.rooms.filter((r) => r.kind === 'kitchen').flatMap((r) => (a.rooms.some((o) => o.level === r.level && ['living', 'dining', 'family', 'livingKitchen'].includes(o.kind) && sharedLength(r.room.polygon, o.room.polygon) >= 1) ? [] : [at(r, 'doesn\'t share a wall with the living or dining room')])),
  },
  {
    id: 'wc-hygiene', kind: 'placement', severity: 'hard', title: 'Toilets don\'t open into kitchen or living areas',
    why: 'Hygiene and privacy: toilets and bathrooms open off a hallway, entry or laundry.',
    check: (a) => a.rooms.filter((r) => r.kind === 'wc' || r.kind === 'bathroom').flatMap((r) => doorsOf(a, r).flatMap((d) => others(d, r)).filter((o) => ['kitchen', 'livingKitchen', 'dining', 'living', 'family'].includes(o.kind)).map((o) => at(r, `opens into ${o.room.name}`))),
  },
  {
    id: 'quiet-bedrooms', kind: 'placement', severity: 'soft', title: 'The main bedroom is on the quiet side',
    why: 'Security, privacy and noise: on the ground floor the main bedroom should not face the street.',
    check: (a) => a.rooms.filter((r) => r.kind === 'master' && r.level === 0).flatMap((r) => (a.windows.filter((w) => w.room === r).some((w) => facesStreet(a, w, r)) ? [at(r, 'faces the street', 6)] : [])),
  },
  {
    id: 'daylight-area', kind: 'placement', severity: 'soft', title: 'Windows are sized to the room',
    why: `Daylight and ventilation: the glazing of a room people live or sleep in should be at least ${Math.round(GLAZING * 100)} % of its floor area, so a big room needs more than one standard window.`,
    check: (a) => a.rooms.filter((r) => HABITABLE.includes(r.kind)).flatMap((r) => {
      const ws = a.windows.filter((w) => w.room === r);
      if (!ws.length) return []; // no window at all is the daylight rules' business
      const glass = ws.reduce((s, w) => s + w.o.width * w.o.height, 0);
      return glass < r.room.area * GLAZING - 0.05 ? [at(r, `${fmt(glass)} m² of glazing for ${fmt(r.room.area)} m² of floor`, 2 + (1 - glass / (r.room.area * GLAZING)) * 6)] : [];
    }),
  },
  {
    id: 'wet-ventilation', kind: 'placement', severity: 'soft', title: 'Bathrooms and laundries have a window',
    why: 'Steam and damp: a bathroom, ensuite or laundry on an outside wall airs itself; an internal one depends on a fan and a duct for its whole life.',
    check: (a) => a.rooms.filter((r) => ['bathroom', 'ensuite', 'laundry'].includes(r.kind)).flatMap((r) => (a.windows.some((w) => w.room === r) ? [] : [at(r, 'has no window (it needs mechanical ventilation)', 1.5)])),
  },
  {
    id: 'arrival', kind: 'placement', severity: 'soft', title: 'Bedrooms and stairs are reached without crossing the living room',
    why: 'Privacy and security: from the front door, the way to the bedrooms, bathrooms and stairs runs through the entry and hallways; a guest in the living room doesn\'t see everyone going to bed, and nobody carries shopping across the sofa.',
    check: (a) => {
      const fd = a.doors.find((d) => d.exterior && d.level === 0 && d.o.width < 2 && !d.rooms.some((r) => r.kind === 'garage'));
      if (!fd || !fd.rooms.length) return [];
      const quiet: Kind[] = ['hall', 'entry', 'stairs', 'open'];
      const seen = new Set<RoomInfo>(fd.rooms);
      const q = [...fd.rooms];
      while (q.length) {
        const r = q.shift()!;
        if (!quiet.includes(r.kind)) continue;
        for (const n of [...doorsOf(a, r).flatMap((d) => others(d, r)), ...(r.kind === 'stairs' ? a.rooms.filter((x) => x.kind === 'stairs' && x !== r) : [])]) if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
      const cut = a.rooms.filter((r) => ['master', 'bedroom', 'bathroom'].includes(r.kind) || (r.kind === 'stairs' && r.level === 0)).filter((r) => !seen.has(r));
      if (!cut.length) return [];
      const through = quiet.includes(fd.rooms[0].kind) ? 'a living space' : fd.rooms[0].room.name.toLowerCase();
      return [{ message: `${cut.slice(0, 3).map((r) => r.room.name).join(', ')}${cut.length > 3 ? '…' : ''}: reached only through ${through}`, roomId: cut[0].room.id, level: cut[0].level, weight: 4 + Math.min(4, cut.length) }];
    },
  },
  {
    id: 'front-door-privacy', kind: 'placement', severity: 'soft', title: 'No bedroom or bathroom door beside the front door',
    why: 'Privacy and security: whoever stands at the open front door should not look straight into a bathroom or a bedroom; their doors are at least 2 m away from it.',
    check: (a) => {
      const fd = a.doors.find((d) => d.exterior && d.level === 0 && d.o.width < 2 && !d.rooms.some((r) => r.kind === 'garage'));
      if (!fd) return [];
      return a.doors.filter((d) => !d.exterior && d.level === 0 && dist(d.c, fd.c) < 2 && d.rooms.some((r) => fd.rooms.includes(r)))
        .flatMap((d) => d.rooms.filter((r) => ['bathroom', 'wc', 'master', 'bedroom'].includes(r.kind)).map((r) => at(r, `its door is ${fmt(dist(d.c, fd.c))} m from the front door`, 4)));
    },
  },
  {
    id: 'wet-cluster', kind: 'placement', severity: 'soft', title: 'Wet rooms are grouped',
    why: 'Plumbing: each bathroom, ensuite, laundry or toilet shares a wall with another wet room or the kitchen.',
    check: (a) => a.rooms.filter((r) => ['bathroom', 'ensuite', 'laundry', 'wc'].includes(r.kind)).flatMap((r) => (a.rooms.some((o) => o !== r && o.level === r.level && WET.includes(o.kind) && sharedLength(r.room.polygon, o.room.polygon) >= 0.5) ? [] : [at(r, 'stands alone', 3)])),
  },
  {
    id: 'laundry-near', kind: 'placement', severity: 'soft', title: 'The laundry is near the kitchen, garage or bathrooms',
    why: 'Convenience: washing is carried between them.',
    check: (a) => a.rooms.filter((r) => r.kind === 'laundry').flatMap((r) => (a.rooms.some((o) => o.level === r.level && ['kitchen', 'livingKitchen', 'garage', 'bathroom', 'hall'].includes(o.kind) && sharedLength(r.room.polygon, o.room.polygon) >= 0.8) ? [] : [at(r, 'is far from the kitchen, garage and bathrooms', 3)])),
  },
  {
    id: 'bedroom-noise', kind: 'placement', severity: 'soft', title: 'Bedrooms don\'t share a wall with the garage or living areas',
    why: 'Security and quiet: car fumes and noise, the television and the kitchen are on the other side of a hallway or a cupboard, not of a bedroom wall.',
    check: (a) => a.rooms.filter((r) => r.kind === 'master' || r.kind === 'bedroom').flatMap((r) => {
      const loud = a.rooms.filter((o) => o.level === r.level && ['garage', 'living', 'livingKitchen', 'family', 'kitchen'].includes(o.kind) && sharedLength(r.room.polygon, o.room.polygon) >= 1);
      return loud.map((o) => at(r, `shares a wall with the ${o.room.name.toLowerCase()}`, o.kind === 'garage' ? 4 : 2));
    }),
  },
  {
    id: 'bath-near-beds', kind: 'placement', severity: 'soft', title: 'Bathrooms are close to the bedrooms they serve',
    why: 'Convenience at night: a shared bathroom within a few steps of the bedrooms on its floor.',
    check: (a) => a.rooms.filter((r) => r.kind === 'bathroom').flatMap((r) => {
      const beds = a.rooms.filter((o) => o.level === r.level && o.kind === 'bedroom');
      if (!beds.length) return [];
      const c = (x: RoomInfo) => { const n = x.room.polygon.length; return [x.room.polygon.reduce((t, p) => t + p[0], 0) / n, x.room.polygon.reduce((t, p) => t + p[1], 0) / n] as Vec2; };
      const near = Math.min(...beds.map((b) => dist(c(b), c(r))));
      return near > 8 ? [at(r, `is ${fmt(near)} m from the nearest bedroom`, (near - 8) * 0.8)] : [];
    }),
  },
  {
    id: 'stairs-hall', kind: 'placement', severity: 'hard', title: 'Stairs open onto a hallway or landing',
    why: 'Stairs arriving inside a room turn it into a corridor.',
    check: (a) => a.rooms.filter((r) => r.kind === 'stairs').flatMap((r) => (doorsOf(a, r).some((d) => others(d, r).some((o) => o.kind === 'hall' || o.kind === 'entry' || o.kind === 'open')) ? [] : [at(r, 'doesn\'t open onto a hallway')])),
  },
  {
    id: 'stairs-stacked', kind: 'placement', severity: 'hard', title: 'Stairs line up on every level',
    why: 'A stair is one object through the house: it must sit in exactly the same place on the floor below and the floor above, and every floor of a multi-storey home needs it.',
    check: (a, plan) => {
      if (plan.floors.length < 2) return [];
      const out: Issue[] = [];
      const levels = [...plan.floors].sort((x, y) => x.level - y.level);
      const stairsOn = (lv: number) => a.rooms.filter((r) => r.kind === 'stairs' && r.level === lv);
      for (const f of levels) if (!stairsOn(f.level).length) out.push({ message: `${floorLabel(f.level)}: there are no stairs`, level: f.level });
      for (let i = 0; i + 1 < levels.length; i++) {
        const lo = stairsOn(levels[i].level), hi = stairsOn(levels[i + 1].level);
        for (const s of hi) {
          // the same footprint below: overlapping almost entirely, about the same size
          const match = lo.some((t) => Math.abs(t.room.area - s.room.area) < 0.5 && s.room.polygon.every((p) => pointInPolygon(p, t.room.polygon) || t.room.polygon.some((q) => dist(p, q) < 0.05) || distToEdge(p, t.room.polygon) < 0.05));
          if (!match) out.push(at(s, `isn't above the stairs on ${floorLabel(levels[i].level).toLowerCase()}`));
        }
      }
      return out;
    },
  },
];

const distToEdge = (p: Vec2, poly: Vec2[]) => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
};

/** Check a plan against every rule. `penalty` ranks plans: hard rules count 100 each. */
export function checkPlan(plan: PlanSpec): Report {
  const a = analyse(plan);
  const results: RuleResult[] = RULES.map((r) => {
    let issues: Issue[];
    try { issues = r.check(a, plan); } catch (e) { issues = [{ message: `could not be checked (${(e as Error).message})` }]; }
    return { id: r.id, title: r.title, kind: r.kind, severity: r.severity, why: r.why, ok: issues.length === 0, issues };
  });
  const hard = results.filter((r) => r.severity === 'hard').reduce((s, r) => s + r.issues.length, 0);
  const soft = results.filter((r) => r.severity === 'soft').reduce((s, r) => s + r.issues.length, 0);
  const softPen = (r: RuleResult) => r.issues.reduce((t, i) => t + (i.weight ?? 1), 0);
  const penalty = hard * 100 + results.filter((r) => r.severity === 'soft').reduce((s, r) => s + softPen(r), 0);
  const byKind = { shape: 0, size: 0, proportion: 0, placement: 0 } as Record<RuleKind, number>;
  for (const r of results) byKind[r.kind] += r.severity === 'soft' ? softPen(r) : r.issues.length * 100;
  return { results, hard, soft, penalty, byKind };
}

export { dirToLocal };
