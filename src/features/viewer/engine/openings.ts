/**
 * Doors & windows that can be opened in the walkthrough.
 *
 * For every door/window we work out:
 *  - which triangles are the moving leaf (sash/panel) and which are the fixed frame/lining,
 *  - how it moves (swing about a vertical hinge, top/bottom hung, pivot, or slide),
 *  - where the hinge is and which way it swings.
 *
 * Direction comes from the model when it says so (IFC OperationType on the door/window or its
 * type: SINGLE_SWING_LEFT, SLIDING_TO_RIGHT, SIDEHUNGLEFTHAND, …) using the IFC convention:
 * a door swings towards its local +Y, and "left"/"right" is the hinge side seen looking along +Y.
 * When the model does not say, we fall back to sensible defaults (see `classify`).
 * Pure data, no Babylon: unit-testable in Node.
 */
import type { ModelData, ModelElement } from '@shared/model/types';

type V3 = [number, number, number];
export type Motion =
  /**
   * Rotate by `angle` about `axis` through `pivot`, in whichever sense moves the point `probe`
   * (on the free edge) towards `toward`. `toward` null = away from the person opening it.
   */
  | { type: 'rotate'; pivot: V3; axis: V3; probe: V3; toward: V3 | null; angle: number }
  /** translate by `offset` (world metres) */
  | { type: 'slide'; offset: V3 };

export interface Leaf {
  parts: ModelElement[];
  motion: Motion;
}

export interface Opening {
  id: string;
  kind: 'door' | 'window';
  name: string;
  storey: string;
  /** IFC operation (or our inferred one) shown to the user */
  operation: string;
  /** describes the movement in plain words, e.g. "Swings open, hinged on the left" */
  description: string;
  center: [number, number, number];
  /** local axes on the floor plane: X = width direction, Y = swing-side normal (unit, world) */
  ax: [number, number];
  ay: [number, number];
  width: number;
  height: number;
  leaves: Leaf[];
}

const DOOR = /Door/i;
const WINDOW = /Window/i;

/** Splits the model into static elements (frames, everything else) and operable openings. */
export function extractOpenings(model: ModelData): { statics: ModelElement[]; openings: Opening[] } {
  const groups = new Map<string, ModelElement[]>();
  const statics: ModelElement[] = [];
  for (const e of model.elements) {
    if (!DOOR.test(e.type) && !WINDOW.test(e.type)) { statics.push(e); continue; }
    const key = e.openingGroup ?? (e.expressId !== undefined ? `x${e.expressId}` : e.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const openings: Opening[] = [];
  for (const [key, parts] of groups) {
    const o = buildOpening(key, parts, model);
    if (!o) { statics.push(...parts); continue; }
    statics.push(...o.frames);
    openings.push(o.opening);
  }
  return { statics, openings };
}

interface Frame { ax: [number, number]; ay: [number, number]; o: [number, number] }

function buildOpening(key: string, parts: ModelElement[], model: ModelData): { opening: Opening; frames: ModelElement[] } | null {
  const kind: Opening['kind'] = parts.some((p) => DOOR.test(p.type)) ? 'door' : 'window';
  const tris = parts.reduce((n, p) => n + p.indices.length / 3, 0);
  if (!tris || tris > 60000) return null;
  const f = localFrame(parts);
  if (!f) return null;
  // overall local bbox: u along width, w along swing normal, y up
  const B = bboxLocal(parts.map((p) => ({ p, tri: null })), f);
  const width = B.u1 - B.u0, height = B.y1 - B.y0;
  if (width < 0.2 || height < 0.2) return null;
  // skylights / roof windows are not operable here
  if (kind === 'window' && /skylight|roof ?window/i.test(parts[0].name)) return null;

  const op = classify(kind, parts, width, height);
  if (op.type === 'fixed') return null;

  // ---- which triangles move? --------------------------------------------------------
  const leafSel = new Map<ModelElement, Uint8Array>();
  const explicit = parts.some((p) => p.openingRole);
  if (explicit) {
    for (const p of parts) leafSel.set(p, new Uint8Array(p.indices.length / 3).fill(p.openingRole === 'leaf' ? 1 : 0));
  } else {
    const comps = components(parts);
    const tol = Math.max(0.008, width * 0.01);
    let leafWidth = 0;
    const isLeaf = comps.map((c) => {
      const b = bboxLocal(c.tris, f);
      const inset = b.u0 > B.u0 + tol && b.u1 < B.u1 - tol;
      // glazing that spans the whole frame (no separate sash) still moves for windows
      const glass = kind === 'window' && c.tris.some((t) => t.p.material === 'glass');
      const ok = inset || (glass && b.y0 > B.y0 + tol);
      if (ok) leafWidth = Math.max(leafWidth, b.u1 - b.u0);
      return ok;
    });
    const anyLeaf = isLeaf.some(Boolean) && leafWidth > width * (op.leaves === 2 ? 0.25 : 0.35);
    for (const p of parts) leafSel.set(p, new Uint8Array(p.indices.length / 3).fill(anyLeaf ? 0 : 1));
    if (anyLeaf) comps.forEach((c, i) => { if (isLeaf[i]) for (const t of c.tris) leafSel.get(t.p)![t.tri!] = 1; });
  }

  // split each part into frame + leaf geometry
  const frames: ModelElement[] = [];
  const leafParts: ModelElement[] = [];
  for (const p of parts) {
    const sel = leafSel.get(p)!;
    const [fr, lf] = [subset(p, sel, 0), subset(p, sel, 1)];
    if (fr) frames.push(fr);
    if (lf) leafParts.push(lf);
  }
  if (!leafParts.length) return null;
  const L = bboxLocal(leafParts.map((p) => ({ p, tri: null })), f);

  // ---- leaves and their motion --------------------------------------------------------
  const world = (u: number, w: number, y: number): V3 =>
    [f.o[0] + f.ax[0] * u + f.ay[0] * w, y, f.o[1] + f.ax[1] * u + f.ay[1] * w];
  const AY: V3 = [f.ay[0], 0, f.ay[1]], AX: V3 = [f.ax[0], 0, f.ax[1]], UP: V3 = [0, 1, 0];
  // windows: which way along +Y is the inside of the building?
  const c0 = world((B.u0 + B.u1) / 2, (B.w0 + B.w1) / 2, 0);
  const mc = [(model.bbox.min[0] + model.bbox.max[0]) / 2, (model.bbox.min[2] + model.bbox.max[2]) / 2];
  const inward = (mc[0] - c0[0]) * f.ay[0] + (mc[1] - c0[2]) * f.ay[1] >= 0 ? 1 : -1;
  const sideVec = (side: Side): V3 | null => {
    const k = side === 'in' ? inward : side === 'out' ? -inward : side;
    return k === 0 ? null : [AY[0] * k, 0, AY[2] * k];
  };
  const sideSign = (side: Side) => (side === 'in' ? inward : side === 'out' ? -inward : side);
  const leaves: Leaf[] = [];
  let description = op.description;
  const lw = L.u1 - L.u0;
  const swingLeaf = (ps: ModelElement[], hingeEnd: -1 | 1, side: Side, angle: number) => {
    const b = bboxLocal(ps.map((p) => ({ p, tri: null })), f);
    const u = hingeEnd < 0 ? b.u0 : b.u1, free = hingeEnd < 0 ? b.u1 : b.u0;
    // hinge on the face of the leaf on the side it swings to (centre when it swings both ways)
    const k = sideSign(side);
    const w = k > 0 ? b.w1 : k < 0 ? b.w0 : (b.w0 + b.w1) / 2;
    leaves.push({ parts: ps, motion: { type: 'rotate', pivot: world(u, w, b.y0), axis: UP, probe: world(free, w, b.y0), toward: sideVec(side), angle } });
  };
  if (op.type === 'swing' && op.leaves === 2) {
    const [a, b] = splitByU(leafParts, f, (L.u0 + L.u1) / 2);
    if (a.length && b.length) { swingLeaf(a, -1, op.side, op.angle); swingLeaf(b, 1, op.side, op.angle); }
    else {
      // one piece spans both halves (e.g. a single glazed pane): open it as one leaf
      swingLeaf(leafParts, op.hingeEnd, op.side, op.angle);
      description = description.replace(/^Double (door|casement), both (leaves|sashes)/, 'Single $1,').replace(/^Double door/, 'Door');
    }
  } else if (op.type === 'swing') {
    swingLeaf(leafParts, op.hingeEnd, op.side, op.angle);
  } else if (op.type === 'tilt') {
    const um = (L.u0 + L.u1) / 2, wm = (L.w0 + L.w1) / 2;
    const y = op.hinge === 'top' ? L.y1 : op.hinge === 'bottom' ? L.y0 : (L.y0 + L.y1) / 2;
    const probeY = op.hinge === 'bottom' ? L.y1 : L.y0;
    leaves.push({ parts: leafParts, motion: { type: 'rotate', pivot: world(um, wm, y), axis: AX, probe: world(um, wm, probeY), toward: sideVec(op.side), angle: op.angle } });
  } else if (op.type === 'pivot') {
    const um = (L.u0 + L.u1) / 2, wm = (L.w0 + L.w1) / 2;
    leaves.push({ parts: leafParts, motion: { type: 'rotate', pivot: world(um, wm, L.y0), axis: UP, probe: world(L.u1, wm, L.y0), toward: sideVec(op.side), angle: op.angle } });
  } else if (op.type === 'slide') {
    if (op.leaves === 2) {
      const [a, b] = splitByU(leafParts, f, (L.u0 + L.u1) / 2);
      const d = lw * 0.45;
      if (a.length && b.length) {
        leaves.push({ parts: a, motion: { type: 'slide', offset: [-AX[0] * d, 0, -AX[2] * d] } });
        leaves.push({ parts: b, motion: { type: 'slide', offset: [AX[0] * d, 0, AX[2] * d] } });
      } else leaves.push({ parts: leafParts, motion: { type: 'slide', offset: [AX[0] * d * op.dir, 0, AX[2] * d * op.dir] } });
    } else if (op.vertical) {
      leaves.push({ parts: leafParts, motion: { type: 'slide', offset: [0, (L.y1 - L.y0) * op.fraction, 0] } });
    } else {
      // a sliding leaf travels past its partner: step it in a little so it doesn't z-fight
      const d = lw * op.fraction, s = inward * 0.04;
      leaves.push({ parts: leafParts, motion: { type: 'slide', offset: [AX[0] * d * op.dir + AY[0] * s, 0, AX[2] * d * op.dir + AY[2] * s] } });
    }
  }

  const c = world((B.u0 + B.u1) / 2, (B.w0 + B.w1) / 2, (B.y0 + B.y1) / 2);
  const first = parts[0];
  return {
    frames,
    opening: {
      id: key, kind, name: cleanName(first.name, kind), storey: first.storey,
      operation: op.label, description,
      center: c, ax: f.ax, ay: f.ay, width, height, leaves,
    },
  };
}

// ---- operation types ------------------------------------------------------------------
/** +1 = towards local +Y, -1 = towards -Y, 0 = away from whoever opens it, 'in'/'out' = into/out of the building */
type Side = -1 | 0 | 1 | 'in' | 'out';
type Op =
  | { type: 'fixed' }
  | { type: 'swing'; leaves: 1 | 2; hingeEnd: -1 | 1; side: Side; angle: number; label: string; description: string }
  | { type: 'tilt'; hinge: 'top' | 'bottom' | 'middle'; side: Side; angle: number; leaves: 1; label: string; description: string }
  | { type: 'pivot'; side: Side; angle: number; leaves: 1; label: string; description: string }
  | { type: 'slide'; leaves: 1 | 2; dir: -1 | 1; vertical?: boolean; fraction: number; label: string; description: string };

const DEG = Math.PI / 180;

/**
 * Turns the IFC operation (or the name, or the size) into a movement.
 * Doors follow the IFC convention (swing to local +Y, hinge left/right seen along +Y).
 * Windows: IFC does not fix the side a casement opens to, so sashes open inwards
 * (towards the building), like European turn/tilt windows.
 */
export function classify(kind: 'door' | 'window', parts: ModelElement[], width: number, height: number): Op {
  const raw = (parts.find((p) => p.operation)?.operation ?? '').toUpperCase();
  const name = parts.map((p) => p.name).join(' ').toLowerCase();
  if (kind === 'door') {
    const op = raw || inferDoor(name, width);
    const label = op;
    const sw = (leaves: 1 | 2, hingeEnd: -1 | 1, side: Side, description: string): Op =>
      ({ type: 'swing', leaves, hingeEnd, side, angle: 95 * DEG, label, description });
    switch (op) {
      case 'SINGLE_SWING_LEFT': return sw(1, -1, 1, 'Swings open, hinged on the left');
      case 'SINGLE_SWING_RIGHT': return sw(1, 1, 1, 'Swings open, hinged on the right');
      case 'DOUBLE_SWING_LEFT': return sw(1, -1, 0, 'Swings both ways (away from you), hinged on the left');
      case 'DOUBLE_SWING_RIGHT': return sw(1, 1, 0, 'Swings both ways (away from you), hinged on the right');
      case 'DOUBLE_DOOR_SINGLE_SWING': case 'DOUBLE_PANEL_SINGLE_SWING':
      case 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT': case 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT':
        return sw(2, -1, 1, 'Double door, both leaves swing open');
      case 'DOUBLE_DOOR_DOUBLE_SWING': return sw(2, -1, 0, 'Double door, swings both ways (away from you)');
      case 'FOLDING_TO_LEFT': return sw(1, -1, 1, 'Folds open to the left');
      case 'FOLDING_TO_RIGHT': return sw(1, 1, 1, 'Folds open to the right');
      case 'DOUBLE_DOOR_FOLDING': return sw(2, -1, 1, 'Double folding door');
      case 'SLIDING_TO_LEFT': return { type: 'slide', leaves: 1, dir: -1, fraction: 0.92, label, description: 'Slides open to the left' };
      case 'SLIDING_TO_RIGHT': return { type: 'slide', leaves: 1, dir: 1, fraction: 0.92, label, description: 'Slides open to the right' };
      case 'DOUBLE_DOOR_SLIDING': return { type: 'slide', leaves: 2, dir: 1, fraction: 0.9, label, description: 'Double sliding door, leaves part in the middle' };
      case 'ROLLINGUP': return { type: 'slide', leaves: 1, dir: 1, vertical: true, fraction: 0.92, label, description: 'Rolls up' };
      case 'SWING_FIXED_LEFT': return sw(1, 1, 1, 'Swing leaf with a fixed side panel');
      case 'SWING_FIXED_RIGHT': return sw(1, -1, 1, 'Swing leaf with a fixed side panel');
      case 'REVOLVING': case 'REVOLVING_HORIZONTAL': case 'REVOLVING_VERTICAL': return { type: 'fixed' };
      case 'DOUBLE_LEAF': return sw(2, -1, 0, 'Double door, swings away from you');
      default: return sw(1, -1, 0, 'Swings open away from you (direction not specified in the model)');
    }
  }
  const op = raw || inferWindow(name, width, height);
  const label = op;
  switch (op) {
    case 'FIXEDCASEMENT': case 'FIXED': return { type: 'fixed' };
    case 'SIDEHUNGLEFTHAND': case 'TILTANDTURNLEFTHAND':
      return { type: 'swing', leaves: 1, hingeEnd: -1, side: 'in', angle: 85 * DEG, label, description: 'Casement, hinged on the left, opens inwards' };
    case 'SIDEHUNGRIGHTHAND': case 'TILTANDTURNRIGHTHAND':
      return { type: 'swing', leaves: 1, hingeEnd: 1, side: 'in', angle: 85 * DEG, label, description: 'Casement, hinged on the right, opens inwards' };
    case 'DOUBLECASEMENT':
      return { type: 'swing', leaves: 2, hingeEnd: -1, side: 'in', angle: 85 * DEG, label, description: 'Double casement, both sashes open inwards' };
    case 'TOPHUNG': return { type: 'tilt', hinge: 'top', side: 'out', angle: 30 * DEG, leaves: 1, label, description: 'Awning: hinged at the top, bottom swings out' };
    case 'BOTTOMHUNG': return { type: 'tilt', hinge: 'bottom', side: 'in', angle: 15 * DEG, leaves: 1, label, description: 'Hopper: hinged at the bottom, top tilts in' };
    case 'PIVOTHORIZONTAL': return { type: 'tilt', hinge: 'middle', side: 'out', angle: 35 * DEG, leaves: 1, label, description: 'Pivots about a horizontal axis' };
    case 'PIVOTVERTICAL': return { type: 'pivot', side: 'in', angle: 80 * DEG, leaves: 1, label, description: 'Pivots about a vertical axis' };
    case 'SLIDINGHORIZONTAL': return { type: 'slide', leaves: 1, dir: 1, fraction: 0.5, label, description: 'Slides sideways' };
    case 'SLIDINGVERTICAL': return { type: 'slide', leaves: 1, dir: 1, vertical: true, fraction: 0.45, label, description: 'Sash slides up' };
    case 'REMOVABLECASEMENT': return { type: 'fixed' };
    default: return { type: 'swing', leaves: 1, hingeEnd: -1, side: 'in', angle: 85 * DEG, label: 'SIDEHUNGLEFTHAND', description: 'Casement, opens inwards (type not specified in the model)' };
  }
}

function inferDoor(name: string, width: number): string {
  if (/revolv/.test(name)) return 'REVOLVING';
  if (/roll|garage|shutter/.test(name)) return 'ROLLINGUP';
  if (/slid|slider|pocket|patio/.test(name)) return width > 2.2 ? 'DOUBLE_DOOR_SLIDING' : 'SLIDING_TO_LEFT';
  if (/fold|bi-?fold/.test(name)) return 'FOLDING_TO_LEFT';
  if (/double|pair|french/.test(name) || width > 1.5) return 'DOUBLE_LEAF';
  return '';
}

function inferWindow(name: string, width: number, height: number): string {
  if (/fixed|fix\b|picture|festverglas/.test(name)) return 'FIXEDCASEMENT';
  if (/slid|slider/.test(name)) return 'SLIDINGHORIZONTAL';
  if (/sash|hung window|double[- ]hung/.test(name)) return 'SLIDINGVERTICAL';
  if (/awning|top[- ]?hung/.test(name)) return 'TOPHUNG';
  if (/hopper|bottom[- ]?hung/.test(name)) return 'BOTTOMHUNG';
  if (/casement|turn|tilt/.test(name)) return width > 1.3 ? 'DOUBLECASEMENT' : 'SIDEHUNGLEFTHAND';
  if (width > 2.4 || (width > 1.8 && height > 1.9)) return 'SLIDINGHORIZONTAL';
  if (width > 1.3) return 'DOUBLECASEMENT';
  return '';
}

function cleanName(n: string, kind: 'door' | 'window') {
  const s = n.split(':')[0].replace(/^M_/, '').replace(/[_-]+/g, ' ').trim();
  return s || (kind === 'door' ? 'Door' : 'Window');
}

// ---- geometry helpers -------------------------------------------------------------------
type TriRef = { p: ModelElement; tri: number | null };

/** Local plan frame from the model's axes when known, else principal axes of the footprint. */
function localFrame(parts: ModelElement[]): Frame | null {
  let sx = 0, sz = 0, n = 0;
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) { sx += p.positions[i]; sz += p.positions[i + 2]; n++; }
  if (!n) return null;
  const o: [number, number] = [sx / n, sz / n];
  const a = parts.find((p) => p.axes)?.axes;
  if (a) {
    const xl = Math.hypot(a[0], a[2]), yl = Math.hypot(a[3], a[5]);
    if (xl > 0.5 && yl > 0.5) {
      const f: Frame = { o, ax: [a[0] / xl, a[2] / xl], ay: [a[3] / yl, a[5] / yl] };
      // some exporters rotate the geometry instead of the placement: trust axes only if
      // the element is actually wider along X than it is deep along Y
      const b = bboxLocal(parts.map((p) => ({ p, tri: null })), f);
      if (b.u1 - b.u0 >= (b.w1 - b.w0) * 0.8) return f;
    }
  }
  // PCA on the floor plane: width runs along the larger spread
  let cxx = 0, czz = 0, cxz = 0;
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) {
    const dx = p.positions[i] - o[0], dz = p.positions[i + 2] - o[1];
    cxx += dx * dx; czz += dz * dz; cxz += dx * dz;
  }
  const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  const ax: [number, number] = [Math.cos(ang), Math.sin(ang)];
  return { o, ax, ay: [-ax[1], ax[0]] };
}

function bboxLocal(refs: TriRef[], f: Frame) {
  const b = { u0: Infinity, u1: -Infinity, w0: Infinity, w1: -Infinity, y0: Infinity, y1: -Infinity };
  const add = (pos: Float32Array, v: number) => {
    const dx = pos[v] - f.o[0], dz = pos[v + 2] - f.o[1];
    const u = dx * f.ax[0] + dz * f.ax[1], w = dx * f.ay[0] + dz * f.ay[1], y = pos[v + 1];
    if (u < b.u0) b.u0 = u; if (u > b.u1) b.u1 = u;
    if (w < b.w0) b.w0 = w; if (w > b.w1) b.w1 = w;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  };
  for (const r of refs) {
    if (r.tri === null) { for (let v = 0; v < r.p.positions.length; v += 3) add(r.p.positions, v); }
    else for (let k = 0; k < 3; k++) add(r.p.positions, r.p.indices[r.tri * 3 + k] * 3);
  }
  return b;
}

/**
 * Connected pieces: triangles of one part sharing an edge (vertices welded at 2 mm). Edge- rather
 * than vertex-connectivity keeps a door leaf apart from the lining it merely touches.
 */
function components(parts: ModelElement[]): { tris: TriRef[] }[] {
  const ids = new Map<string, number>();
  const vid = (p: Float32Array, v: number) => {
    const k = `${Math.round(p[v] * 500)},${Math.round(p[v + 1] * 500)},${Math.round(p[v + 2] * 500)}`;
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    return id;
  };
  const tris: TriRef[] = [];
  const parent: number[] = [];
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edgeOwner = new Map<string, number>();
  for (const p of parts) {
    for (let t = 0; t < p.indices.length / 3; t++) {
      const ti = tris.length;
      tris.push({ p, tri: t });
      parent.push(ti);
      const v = [0, 1, 2].map((k) => vid(p.positions, p.indices[t * 3 + k] * 3));
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        if (a === b) continue;
        // only within one part: separate parts are separate solids (leaf vs lining) even where they touch
        const key = `${parts.indexOf(p)}:${a < b ? `${a}_${b}` : `${b}_${a}`}`;
        const o = edgeOwner.get(key);
        if (o === undefined) edgeOwner.set(key, ti);
        else { const ra = find(o), rb = find(ti); if (ra !== rb) parent[ra] = rb; }
      }
    }
  }
  const out = new Map<number, TriRef[]>();
  tris.forEach((t, i) => {
    const r = find(i);
    if (!out.has(r)) out.set(r, []);
    out.get(r)!.push(t);
  });
  return [...out.values()].map((t) => ({ tris: t }));
}

/** Two halves by whole pieces either side of `mid`; empty halves when a big piece straddles it. */
function splitByU(parts: ModelElement[], f: Frame, mid: number): [ModelElement[], ModelElement[]] {
  const sel = new Map(parts.map((p) => [p, new Uint8Array(p.indices.length / 3)]));
  for (const c of components(parts)) {
    const b = bboxLocal(c.tris, f);
    const side = b.u1 <= mid + 0.01 ? 0 : b.u0 >= mid - 0.01 ? 1 : (b.u0 + b.u1) / 2 < mid ? 0 : 1;
    if (b.u0 < mid - 0.05 && b.u1 > mid + 0.05) return [[], []];
    for (const t of c.tris) sel.get(t.p)![t.tri!] = side;
  }
  const a: ModelElement[] = [], b: ModelElement[] = [];
  for (const p of parts) {
    const l = subset(p, sel.get(p)!, 0), r = subset(p, sel.get(p)!, 1);
    if (l) a.push(l);
    if (r) b.push(r);
  }
  return [a, b];
}

/** Copy of `e` keeping only triangles where sel[t] === want (vertices compacted). */
export function subset(e: ModelElement, sel: Uint8Array, want: number): ModelElement | null {
  let count = 0;
  for (let t = 0; t < sel.length; t++) if (sel[t] === want) count++;
  if (!count) return null;
  if (count === sel.length) return e;
  const remap = new Int32Array(e.positions.length / 3).fill(-1);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let t = 0; t < sel.length; t++) {
    if (sel[t] !== want) continue;
    for (let k = 0; k < 3; k++) {
      const v = e.indices[t * 3 + k];
      if (remap[v] < 0) {
        remap[v] = pos.length / 3;
        pos.push(e.positions[v * 3], e.positions[v * 3 + 1], e.positions[v * 3 + 2]);
        nrm.push(e.normals[v * 3], e.normals[v * 3 + 1], e.normals[v * 3 + 2]);
        if (e.uvs) uv.push(e.uvs[v * 2], e.uvs[v * 2 + 1]);
      }
      idx.push(remap[v]);
    }
  }
  return {
    ...e,
    positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx),
    ...(e.uvs ? { uvs: new Float32Array(uv) } : {}),
  };
}
