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
export interface Report { results: RuleResult[]; hard: number; soft: number; penalty: number }

/** What a room is, from its type and name (the generator and the editor share these names). */
export type Kind = 'garage' | 'entry' | 'living' | 'livingKitchen' | 'family' | 'kitchen' | 'dining' | 'study' | 'laundry' | 'wc' | 'bathroom'
  | 'ensuite' | 'master' | 'bedroom' | 'robe' | 'storage' | 'retreat' | 'hall' | 'stairs' | 'open' | 'other';

export function kindOf(r: Pick<Room, 'type' | 'name'>): Kind {
  const n = r.name.toLowerCase();
  switch (r.type) {
    case 'living': return /kitchen/.test(n) ? 'livingKitchen' : /family|rumpus|sitting/.test(n) ? 'family' : 'living';
    case 'hallway': return 'hall';
    case 'other': return /robe/.test(n) ? 'robe' : /storage|store|linen/.test(n) ? 'storage' : /retreat|sitting/.test(n) ? 'retreat' : /open space/.test(n) ? 'open' : 'other';
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
  master: { min: 12, max: 30, clear: [3.0, 3.4], aspect: 1.9, shape: 'simple' },
  bedroom: { min: 9, max: 20, clear: [2.7, 3.0], aspect: 1.9, shape: 'simple' },
  bathroom: { min: 4, max: 10, clear: [1.6, 2.1], aspect: 2.6, shape: 'rect' },
  ensuite: { min: 3.5, max: 8.5, clear: [1.5, 2.0], aspect: 2.6, shape: 'rect' },
  wc: { min: 1.4, max: 4.5, clear: [0.9, 1.4], aspect: 3.2, shape: 'rect' },
  laundry: { min: 3.5, max: 9, clear: [1.5, 1.8], aspect: 3, shape: 'rect' },
  kitchen: { min: 7, max: 25, clear: [2.4, 2.7], aspect: 2.6, shape: 'simple' },
  living: { min: 14, max: 55, clear: [3.3, 3.6], aspect: 2.4, shape: 'free' },
  livingKitchen: { min: 20, max: 70, clear: [3.3, 3.6], aspect: 2.6, shape: 'free' },
  family: { min: 11, max: 40, clear: [3.0, 3.3], aspect: 2.4, shape: 'free' },
  dining: { min: 8, max: 25, clear: [2.7, 3.0], aspect: 2.2, shape: 'simple' },
  study: { min: 6, max: 18, clear: [2.4, 2.4], aspect: 2.2, shape: 'simple' },
  retreat: { min: 7, max: 30, clear: [2.7, 2.7], aspect: 2.4, shape: 'simple' },
  entry: { min: 2.5, max: 14, clear: [1.4, 1.8], aspect: 4.5, shape: 'rect' },
  robe: { min: 1.8, max: 7, clear: [1.1, 1.4], aspect: 3.2, shape: 'rect' },
  storage: { min: 1.2, max: 9, clear: [0.9, 1.2], aspect: 4, shape: 'rect' },
};
/** A garage must take a car: centre-line size of a single (3.25 × 6 m) and a double (5.75 × 6 m) garage. */
export const GARAGE = { single: [3.25, 6.0] as [number, number], double: [5.75, 6.0] as [number, number], doorSingle: 2.4, doorDouble: 4.8, maxArea: 42 };
/** Every door opens onto a clear square this big on both sides. */
export const DOOR_CLEAR = 0.8;

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
    id: 'hall-share', kind: 'size', severity: 'soft', title: 'Hallways stay compact',
    why: 'Circulation over about 15 % of a floor is space nobody lives in.',
    check: (a, plan) => plan.floors.flatMap((f) => {
      const rs = a.rooms.filter((r) => r.level === f.level);
      const total = rs.reduce((s, r) => s + r.room.area, 0), hall = rs.filter((r) => r.kind === 'hall').reduce((s, r) => s + r.room.area, 0);
      return total && hall / total > 0.17 ? [{ message: `${floorLabel(f.level)}: hallways are ${Math.round((hall / total) * 100)} % of the floor`, level: f.level, weight: (hall / total - 0.17) * 80 }] : [];
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
      return a.rooms.flatMap((r) => ((r.kind === 'master' || r.kind === 'bedroom') && r.room.area > L) || (r.kind === 'kitchen' && r.room.area > L * 1.05) ? [at(r, `${fmt(r.room.area)} m² beats the living room (${fmt(L)} m²)`, 8)] : []);
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
    id: 'stairs-hall', kind: 'placement', severity: 'hard', title: 'Stairs open onto a hallway or landing',
    why: 'Stairs arriving inside a room turn it into a corridor.',
    check: (a) => a.rooms.filter((r) => r.kind === 'stairs').flatMap((r) => (doorsOf(a, r).some((d) => others(d, r).some((o) => o.kind === 'hall' || o.kind === 'entry' || o.kind === 'open')) ? [] : [at(r, 'doesn\'t open onto a hallway')])),
  },
];

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
  const penalty = hard * 100 + results.filter((r) => r.severity === 'soft').reduce((s, r) => s + r.issues.reduce((t, i) => t + (i.weight ?? 1), 0), 0);
  return { results, hard, soft, penalty };
}

export { dirToLocal };
