/**
 * Deterministic, seeded floor-plan generator ("Creative" mode and "Chat" mode).
 *
 * Strategy: the footprint is split front-to-back into three bands —
 *   back band  (private: bedrooms, wet areas)
 *   hallway    (full-width circulation spine)
 *   front band (public: living, kitchen, garage; the street / entry side)
 * Each band is subdivided into columns sized by target area (a strip treemap),
 * so every room touches the hallway (bedrooms off a hallway) and an exterior
 * wall (windows). Wet areas are grouped, living sits next to the kitchen and
 * the entry door is always on the front wall. Doors go on shared walls,
 * windows on exterior walls. Same inputs + seed ⇒ identical PlanSpec.
 */
import type { PlanSpec, Floor, Room, Wall, Opening, RoomType } from '@shared/planspec/schema';
import { mulberry32 } from '@shared/util/rng';
import { normalizeSite, rectBoundary } from '@shared/planspec/site';
import { FEASIBILITY, type ProgramInput } from './feasibility';

export interface GeneratorInput extends ProgramInput {
  seed: number;
  style?: string;
  title?: string;
  notes?: string;
  mode?: PlanSpec['meta']['mode'];
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
interface Box { key: string; type: RoomType; name: string; target: number; rect?: Rect }
interface Column { boxes: Box[]; suite?: { ensuite?: Box; robe?: Box } }

const HALL = 1.2;
const STAIRS_W = 2.4;
const EXT_T = 0.25;
const INT_T = 0.1;
const FLOOR_H = 2.7;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const MIN_W: Partial<Record<RoomType, number>> = {
  master: 3.2, bedroom: 2.7, bathroom: 1.7, ensuite: 1.7, laundry: 1.6, wc: 1.2, kitchen: 2.4,
  living: 3.6, garage: 3.3, study: 2.4, dining: 2.7, stairs: STAIRS_W, other: 2.0,
};

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Split a width among columns proportionally to their target areas, respecting minimum widths. */
function columnWidths(cols: Column[], width: number): number[] {
  const target = cols.map((c) => c.boxes.reduce((s, b) => s + b.target, 0) + (c.suite?.ensuite?.target ?? 0) + (c.suite?.robe?.target ?? 0));
  const mins = cols.map((c) => Math.max(...c.boxes.map((b) => MIN_W[b.type] ?? 2)) + (c.suite?.ensuite ? 1.7 : 0));
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum >= width) return mins.map((m) => (m / minSum) * width);
  let w = target.map((t) => (t / target.reduce((a, b) => a + b, 0)) * width);
  for (let iter = 0; iter < 8; iter++) {
    const fixed = w.map((v, i) => v < mins[i]);
    if (!fixed.some(Boolean)) break;
    const fixedSum = w.reduce((s, _, i) => s + (fixed[i] ? mins[i] : 0), 0);
    const freeTarget = target.reduce((s, t, i) => s + (fixed[i] ? 0 : t), 0);
    w = w.map((_, i) => (fixed[i] ? mins[i] : (target[i] / freeTarget) * (width - fixedSum)));
  }
  return w;
}

/** Lay out columns left→right inside a band rect. `hallSide` is the y edge touching the hallway. */
function layoutBand(cols: Column[], band: Rect, hallSide: 'top' | 'bottom', suiteSideRight: (i: number) => boolean) {
  if (!cols.length) return;
  const widths = columnWidths(cols, band.x1 - band.x0);
  let x = band.x0;
  cols.forEach((c, i) => {
    const x1 = i === cols.length - 1 ? band.x1 : r1(x + widths[i]);
    const rect: Rect = { x0: x, y0: band.y0, x1, y1: band.y1 };
    if (c.suite?.ensuite) {
      // Main bedroom suite: bedroom | (ensuite at the exterior side, walk-in robe at the hall side)
      const sw = r1(Math.min(2.2, Math.max(1.7, (rect.x1 - rect.x0) * 0.38)));
      const right = suiteSideRight(i);
      const sx0 = right ? rect.x1 - sw : rect.x0, sx1 = right ? rect.x1 : rect.x0 + sw;
      c.boxes[0].rect = right ? { ...rect, x1: sx0 } : { ...rect, x0: sx1 };
      const depth = rect.y1 - rect.y0;
      const ed = r1(Math.min(depth - 1.2, Math.max(2.2, depth * 0.62)));
      const ext = hallSide === 'bottom' ? { y0: rect.y0, y1: rect.y0 + ed } : { y0: rect.y1 - ed, y1: rect.y1 };
      const hall = hallSide === 'bottom' ? { y0: rect.y0 + ed, y1: rect.y1 } : { y0: rect.y0, y1: rect.y1 - ed };
      c.suite.ensuite.rect = { x0: sx0, x1: sx1, ...ext };
      if (c.suite.robe) c.suite.robe.rect = { x0: sx0, x1: sx1, ...hall };
    } else {
      // Stack boxes in a column (normally just one room per column).
      const depth = rect.y1 - rect.y0;
      const total = c.boxes.reduce((s, b) => s + b.target, 0);
      let y = hallSide === 'bottom' ? rect.y1 : rect.y0;
      c.boxes.forEach((b, j) => {
        const d = j === c.boxes.length - 1 ? Math.abs((hallSide === 'bottom' ? rect.y0 : rect.y1) - y) : r1((b.target / total) * depth);
        b.rect = hallSide === 'bottom' ? { x0: rect.x0, x1: rect.x1, y0: y - d, y1: y } : { x0: rect.x0, x1: rect.x1, y0: y, y1: y + d };
        y = hallSide === 'bottom' ? y - d : y + d;
      });
    }
    x = x1;
  });
}

/** Build maximal wall segments from all room rectangles. */
function buildWalls(rects: Rect[], W: number, D: number, level: number): Wall[] {
  const h = new Map<number, [number, number][]>();
  const v = new Map<number, [number, number][]>();
  const add = (m: Map<number, [number, number][]>, k: number, a: number, b: number) => {
    const key = r3(k);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push([Math.min(a, b), Math.max(a, b)]);
  };
  for (const r of rects) {
    add(h, r.y0, r.x0, r.x1); add(h, r.y1, r.x0, r.x1);
    add(v, r.x0, r.y0, r.y1); add(v, r.x1, r.y0, r.y1);
  }
  const walls: Wall[] = [];
  const merge = (m: Map<number, [number, number][]>, horizontal: boolean) => {
    for (const [k, list] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a[0] - b[0]);
      let cur = [...list[0]] as [number, number];
      const flush = () => {
        if (cur[1] - cur[0] < 0.05) return;
        const exterior = horizontal ? Math.abs(k) < 1e-3 || Math.abs(k - D) < 1e-3 : Math.abs(k) < 1e-3 || Math.abs(k - W) < 1e-3;
        walls.push({
          id: `w${level}-${walls.length}`,
          a: horizontal ? [r3(cur[0]), k] : [k, r3(cur[0])],
          b: horizontal ? [r3(cur[1]), k] : [k, r3(cur[1])],
          thickness: exterior ? EXT_T : INT_T,
          exterior,
        });
      };
      for (const s of list.slice(1)) {
        if (s[0] <= cur[1] + 1e-3) cur[1] = Math.max(cur[1], s[1]);
        else { flush(); cur = [...s] as [number, number]; }
      }
      flush();
    }
  };
  merge(h, true);
  merge(v, false);
  return walls;
}

interface SharedEdge { horizontal: boolean; k: number; from: number; to: number }
function sharedEdge(a: Rect, b: Rect): SharedEdge | null {
  const eps = 1e-3;
  for (const [ya, yb] of [[a.y1, b.y0], [a.y0, b.y1]]) {
    if (Math.abs(ya - yb) < eps) {
      const from = Math.max(a.x0, b.x0), to = Math.min(a.x1, b.x1);
      if (to - from > eps) return { horizontal: true, k: ya, from, to };
    }
  }
  for (const [xa, xb] of [[a.x1, b.x0], [a.x0, b.x1]]) {
    if (Math.abs(xa - xb) < eps) {
      const from = Math.max(a.y0, b.y0), to = Math.min(a.y1, b.y1);
      if (to - from > eps) return { horizontal: false, k: xa, from, to };
    }
  }
  return null;
}

/** Find the wall containing a point on an edge line, return wall + offset from wall.a. */
function wallAt(walls: Wall[], e: SharedEdge, along: number): { wall: Wall; offset: number } | null {
  for (const w of walls) {
    const horiz = Math.abs(w.a[1] - w.b[1]) < 1e-6;
    if (horiz !== e.horizontal) continue;
    if (horiz) {
      if (Math.abs(w.a[1] - e.k) > 1e-3) continue;
      const lo = Math.min(w.a[0], w.b[0]), hi = Math.max(w.a[0], w.b[0]);
      if (along >= lo - 1e-6 && along <= hi + 1e-6) return { wall: w, offset: r3(Math.abs(along - w.a[0])) };
    } else {
      if (Math.abs(w.a[0] - e.k) > 1e-3) continue;
      const lo = Math.min(w.a[1], w.b[1]), hi = Math.max(w.a[1], w.b[1]);
      if (along >= lo - 1e-6 && along <= hi + 1e-6) return { wall: w, offset: r3(Math.abs(along - w.a[1])) };
    }
  }
  return null;
}

const ACCESS: Partial<Record<RoomType, RoomType[]>> = {
  master: ['hallway'], bedroom: ['hallway'], bathroom: ['hallway'], study: ['hallway', 'living'],
  wc: ['hallway', 'laundry'], laundry: ['hallway', 'kitchen', 'garage'], kitchen: ['hallway', 'living'],
  living: ['hallway'], garage: ['hallway', 'laundry'], dining: ['hallway', 'kitchen'], stairs: ['hallway'],
  ensuite: ['master'], other: ['master', 'hallway'], entry: ['hallway'],
};

const WINDOW: Partial<Record<RoomType, { w: number; h: number; sill: number }>> = {
  master: { w: 1.8, h: 1.4, sill: 0.8 }, bedroom: { w: 1.5, h: 1.4, sill: 0.8 }, living: { w: 2.4, h: 2.1, sill: 0.1 },
  kitchen: { w: 1.4, h: 1.0, sill: 1.05 }, dining: { w: 1.8, h: 2.1, sill: 0.1 }, study: { w: 1.2, h: 1.4, sill: 0.8 },
  bathroom: { w: 0.8, h: 0.6, sill: 1.5 }, ensuite: { w: 0.8, h: 0.6, sill: 1.5 }, laundry: { w: 0.8, h: 1.0, sill: 1.1 },
  wc: { w: 0.6, h: 0.6, sill: 1.5 }, stairs: { w: 0.9, h: 1.2, sill: 1.0 },
};

function box(type: RoomType, name: string, target: number, key = name): Box {
  return { key, type, name, target };
}

/** Distribute n items over k buckets as evenly as possible. */
const spread = (n: number, k: number) => Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));

export function generatePlan(input: GeneratorInput): PlanSpec {
  const rng = mulberry32(input.seed * 2654435761 + input.bedrooms * 97 + input.bathrooms * 13 + input.floors);
  const m = FEASIBILITY.minArea;
  const floors = Math.min(3, Math.max(1, Math.round(input.floors)));
  const plate = input.area / floors;
  const ratio = pick(rng, [1.2, 1.35, 1.5, 1.7]);
  let W = Math.sqrt(plate * ratio);
  let D = plate / W;
  if (D < 7) { D = 7; W = plate / D; }
  if (W < 6.4) { W = 6.4; D = plate / W; }
  W = r1(W); D = r1(D);
  const bands = D - HALL;
  const has = (e: string) => input.extras.includes(e);
  const openPlan = has('open-plan');
  const garageLeft = rng() < 0.5;
  const masterLeft = rng() < 0.5;
  const wetNextToMaster = rng() < 0.6;

  // ---- Programme per floor --------------------------------------------------
  const bathrooms = Math.max(1, input.bathrooms);
  const bedrooms = Math.max(1, input.bedrooms);
  const ensuite = bathrooms >= 2;
  const groundBath = floors > 1 && bathrooms >= 3;
  let sharedBaths = bathrooms - (ensuite ? 1 : 0) - (groundBath ? 1 : 0);

  interface FloorProgram { back: Column[]; front: Column[] }
  const programs: FloorProgram[] = [];

  const publicCols = (): Column[] => {
    const cols: Column[] = [];
    const living = openPlan ? box('living', 'Living & kitchen', m.living + m.kitchen + 6) : box('living', 'Living', m.living + 4);
    const kitchen = openPlan ? null : box('kitchen', 'Kitchen', m.kitchen + 3);
    const garage = has('garage') ? box('garage', 'Garage', m.garage) : null;
    const study = has('study') && floors === 1 ? box('study', 'Study', m.study) : null;
    const core = kitchen ? (rng() < 0.5 ? [living, kitchen] : [kitchen, living]) : [living];
    const seq: Box[] = [...core];
    if (study) seq.splice(rng() < 0.5 ? 0 : seq.length, 0, study);
    if (garage) garageLeft ? seq.unshift(garage) : seq.push(garage);
    for (const b of seq) cols.push({ boxes: [b] });
    return cols;
  };

  const privateCols = (beds: number, withMaster: boolean, baths: number, extrasHere: Box[]): Column[] => {
    const wet: Column[] = [];
    for (let i = 0; i < baths; i++) wet.push({ boxes: [box('bathroom', baths > 1 ? `Bathroom ${i + 1}` : 'Bathroom', m.bathroom + 1.5)] });
    for (const e of extrasHere) wet.push({ boxes: [e] });
    const bedCols: Column[] = [];
    let n = 2;
    for (let i = 0; i < beds - (withMaster ? 1 : 0); i++) bedCols.push({ boxes: [box('bedroom', `Bedroom ${withMaster ? n++ : n++}`, m.bedroom + 2)] });
    const cols: Column[] = [];
    if (withMaster) {
      const master: Column = { boxes: [box('master', 'Main bedroom', m.master + 2)] };
      if (ensuite) master.suite = { ensuite: box('ensuite', 'Ensuite', m.bathroom + 1), robe: box('other', 'Walk-in robe', 3, 'Walk-in robe') };
      cols.push(master);
    }
    if (wetNextToMaster || !withMaster) cols.push(...wet, ...bedCols);
    else {
      const mid = Math.ceil(bedCols.length / 2);
      cols.push(...bedCols.slice(0, mid), ...wet, ...bedCols.slice(mid));
    }
    return masterLeft ? cols : cols.reverse();
  };

  if (floors === 1) {
    const extras: Box[] = [];
    if (has('laundry')) extras.push(box('laundry', 'Laundry', m.laundry + 1));
    programs.push({ back: privateCols(bedrooms, true, sharedBaths, extras), front: publicCols() });
  } else {
    const back: Column[] = [];
    if (has('study')) back.push({ boxes: [box('study', 'Study', m.study)] });
    if (has('laundry')) back.push({ boxes: [box('laundry', 'Laundry', m.laundry + 1)] });
    back.push(groundBath ? { boxes: [box('bathroom', 'Guest bathroom', m.bathroom + 1)] } : { boxes: [box('wc', 'Powder room', 2.5)] });
    back.push({ boxes: [box('dining', 'Dining', 12)] });
    programs.push({ back: masterLeft ? back : back.reverse(), front: publicCols() });
    const uppers = floors - 1;
    const bedSplit = spread(bedrooms, uppers);
    const bathSplit = spread(Math.max(uppers, sharedBaths), uppers);
    sharedBaths = Math.max(uppers, sharedBaths);
    let bedNo = 2;
    for (let u = 0; u < uppers; u++) {
      const withMaster = u === 0;
      const cols = privateCols(bedSplit[u] || 0, withMaster && bedSplit[u] > 0, bathSplit[u], []);
      // Renumber bedrooms across floors.
      for (const c of cols) for (const b of c.boxes) if (b.type === 'bedroom') { b.name = `Bedroom ${bedNo++}`; b.key = b.name; }
      // Split between back band and the front band (which holds the stairs).
      const front: Column[] = [];
      const backCols = [...cols];
      const area = (cs: Column[]) => cs.reduce((s, c) => s + c.boxes.reduce((t, b) => t + b.target, 0), 0);
      while (backCols.length > 1 && area(backCols) > area(front) + 10) {
        const idx = backCols.findIndex((c) => c.boxes[0].type === 'bedroom');
        if (idx < 0) break;
        front.push(...backCols.splice(idx, 1));
      }
      if (!front.length) front.push({ boxes: [box('other', u === 0 ? 'Retreat' : 'Sitting room', 10)] });
      if (!backCols.length) backCols.push({ boxes: [box('other', 'Retreat', 10)] });
      programs.push({ back: backCols, front });
    }
  }

  // ---- Band depth -------------------------------------------------------------
  const area = (cs: Column[]) => cs.reduce((s, c) => s + c.boxes.reduce((t, b) => t + b.target, 0) + (c.suite?.ensuite?.target ?? 0) + (c.suite?.robe?.target ?? 0), 0);
  const g = programs[0];
  // Keep bands from getting too deep: move secondary bedrooms to the front if needed.
  if (floors === 1) {
    const share = () => area(g.back) / (area(g.back) + area(g.front));
    while (share() * bands > 5.4) {
      const idx = g.back.findIndex((c) => c.boxes[0].type === 'bedroom');
      if (idx < 0) break;
      const [moved] = g.back.splice(idx, 1);
      garageLeft ? g.front.push(moved) : g.front.unshift(moved);
    }
  }
  const share = floors === 1 ? area(g.back) / (area(g.back) + area(g.front)) : 0.5;
  const Db = r1(Math.min(bands - 2.8, Math.max(2.8, bands * share * (0.95 + rng() * 0.1))));
  const hall: Rect = { x0: 0, y0: Db, x1: W, y1: Db + HALL };
  const stairsLeft = floors > 1 ? garageLeft === false : false;
  const stairsRect: Rect | null = floors > 1
    ? stairsLeft ? { x0: 0, y0: Db + HALL, x1: STAIRS_W, y1: D } : { x0: W - STAIRS_W, y0: Db + HALL, x1: W, y1: D }
    : null;

  const outFloors: Floor[] = programs.map((p, level) => {
    const backBand: Rect = { x0: 0, y0: 0, x1: W, y1: Db };
    let frontBand: Rect = { x0: 0, y0: Db + HALL, x1: W, y1: D };
    if (stairsRect) frontBand = stairsLeft ? { ...frontBand, x0: STAIRS_W } : { ...frontBand, x1: W - STAIRS_W };
    const findWetIdx = (cols: Column[]) => cols.findIndex((c) => ['bathroom', 'laundry', 'wc'].includes(c.boxes[0].type));
    const wetIdx = findWetIdx(p.back);
    layoutBand(p.back, backBand, 'bottom', (i) => (wetIdx >= 0 ? wetIdx > i : !masterLeft));
    layoutBand(p.front, frontBand, 'top', () => true);

    const boxes: Box[] = [];
    for (const c of [...p.back, ...p.front]) {
      boxes.push(...c.boxes);
      if (c.suite?.ensuite) boxes.push(c.suite.ensuite);
      if (c.suite?.robe) boxes.push(c.suite.robe);
    }
    boxes.push({ key: 'Hallway', type: 'hallway', name: level === 0 ? 'Hallway' : 'Landing', target: 0, rect: hall });
    if (stairsRect) boxes.push({ key: 'Stairs', type: 'stairs', name: 'Stairs', target: 0, rect: stairsRect });

    const rects = boxes.map((b) => b.rect!).filter(Boolean);
    const walls = buildWalls([{ x0: 0, y0: 0, x1: W, y1: D }, ...rects], W, D, level);
    const openings: Opening[] = [];
    let oid = 0;
    const addOpening = (e: SharedEdge, along: number, type: 'door' | 'window', w: number, h: number, sill?: number) => {
      const hit = wallAt(walls, e, along);
      if (!hit) return;
      openings.push({ id: `o${level}-${oid++}`, wallId: hit.wall.id, type, offset: hit.offset, width: r3(w), height: h, ...(sill !== undefined ? { sill } : {}) });
    };

    // Doors on shared walls, following access rules.
    for (const b of boxes) {
      const prefs = ACCESS[b.type];
      if (!prefs || !b.rect) continue;
      let placed = false;
      for (const t of prefs) {
        const n = boxes.find((o) => o !== b && o.type === t && o.rect && (sharedEdge(b.rect!, o.rect)?.to ?? 0) - (sharedEdge(b.rect!, o.rect)?.from ?? 0) >= 0.95);
        if (!n) continue;
        const e = sharedEdge(b.rect, n.rect!)!;
        const len = e.to - e.from;
        const dw = b.type === 'garage' ? 0.82 : b.type === 'stairs' ? Math.min(1.0, len - 0.1) : 0.82;
        const along = len > dw + 0.6 ? e.from + 0.3 + dw / 2 : (e.from + e.to) / 2;
        addOpening(e, along, 'door', dw, 2.04);
        placed = true;
        break;
      }
      if (!placed && b.type !== 'hallway') {
        const n = boxes.find((o) => o !== b && o.rect && ((sharedEdge(b.rect!, o.rect)?.to ?? 0) - (sharedEdge(b.rect!, o.rect)?.from ?? 0)) >= 0.95);
        if (n) { const e = sharedEdge(b.rect, n.rect!)!; addOpening(e, (e.from + e.to) / 2, 'door', 0.82, 2.04); }
      }
    }
    // Living ↔ kitchen: a wide opening so the two spaces connect.
    const living = boxes.find((b) => b.type === 'living'), kitchen = boxes.find((b) => b.type === 'kitchen');
    if (living?.rect && kitchen?.rect) {
      const e = sharedEdge(living.rect, kitchen.rect);
      if (e && e.to - e.from > 2) addOpening(e, (e.from + e.to) / 2, 'door', Math.min(1.8, e.to - e.from - 0.6), 2.1);
    }

    // Windows (and the entry / garage doors) on exterior walls.
    for (const b of boxes) {
      if (!b.rect) continue;
      const r = b.rect;
      const edges: SharedEdge[] = [];
      if (Math.abs(r.y0) < 1e-3) edges.push({ horizontal: true, k: 0, from: r.x0, to: r.x1 });
      if (Math.abs(r.y1 - D) < 1e-3) edges.push({ horizontal: true, k: D, from: r.x0, to: r.x1 });
      if (Math.abs(r.x0) < 1e-3) edges.push({ horizontal: false, k: 0, from: r.y0, to: r.y1 });
      if (Math.abs(r.x1 - W) < 1e-3) edges.push({ horizontal: false, k: W, from: r.y0, to: r.y1 });
      for (const e of edges) {
        let from = e.from, to = e.to;
        const isFront = e.horizontal && Math.abs(e.k - D) < 1e-3;
        if (level === 0 && isFront && b.type === 'garage') {
          const gw = Math.min(2.7, to - from - 0.5);
          addOpening(e, (from + to) / 2, 'door', gw, 2.2);
          continue;
        }
        if (level === 0 && isFront && b.type === 'living') {
          // Entry door near the hallway end of the living room's front wall.
          const doorAlong = garageLeft ? to - 0.7 : from + 0.7;
          addOpening(e, doorAlong, 'door', 0.92, 2.1);
          if (garageLeft) to -= 1.4; else from += 1.4;
        }
        const spec = WINDOW[b.type];
        if (!spec || b.type === 'hallway') continue;
        const len = to - from;
        if (len < spec.w + 0.6) continue;
        // Long walls get the bigger windows; side walls of public rooms only if long enough.
        if (!e.horizontal && len < 2.5 && edges.length > 1) continue;
        addOpening(e, (from + to) / 2, 'window', Math.min(spec.w, len - 0.8), spec.h, spec.sill);
      }
    }

    const rooms: Room[] = boxes.filter((b) => b.rect).map((b, i) => {
      const r = b.rect!;
      return {
        id: `r${level}-${i}`,
        name: b.name,
        type: b.type,
        polygon: [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(([x, y]) => [r3(x), r3(y)] as [number, number]),
        area: r1((r.x1 - r.x0) * (r.y1 - r.y0)),
      };
    });
    return { level, height: FLOOR_H, walls, rooms, openings };
  });

  return {
    version: '1.0',
    meta: {
      title: input.title ?? `${bedrooms} bed ${bathrooms} bath · ${Math.round(input.area)} m²`,
      createdBy: 'client',
      mode: input.mode ?? 'creative',
      createdAt: new Date(0).toISOString(),
      seed: input.seed,
    },
    // Rectangular lot with a 4 m side and 6 m front/back margin; the street runs along the front
    // (bottom) side and the entrance lines up with the front door.
    site: normalizeSite({ width: r1(W + 8), depth: r1(D + 12), northAngle: 0, boundary: rectBoundary(-4, -6, r1(W + 8), r1(D + 12)), roads: [{ edge: 2 }] }, outFloors),
    floors: outFloors,
    requirements: {
      area: input.area, floors, bedrooms, bathrooms, extras: [...input.extras],
      ...(input.style ? { style: input.style } : {}), notes: input.notes ?? '',
    },
  };
}

/** Signature used to drop duplicate variants. */
export function planSignature(p: PlanSpec): string {
  return p.floors.map((f) => f.rooms.map((r) => `${r.type}:${r.polygon.flat().map((v) => v.toFixed(1)).join(',')}`).sort().join('|')).join('#');
}

/** Generate up to `count` distinct variants (3–6) for the same brief. */
export function generateVariants(input: Omit<GeneratorInput, 'seed'>, count = 4, baseSeed = 1): PlanSpec[] {
  const out: PlanSpec[] = [];
  const seen = new Set<string>();
  for (let s = baseSeed; out.length < count && s < baseSeed + count * 6; s++) {
    const p = generatePlan({ ...input, seed: s });
    const sig = planSignature(p);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(p);
  }
  return out;
}
