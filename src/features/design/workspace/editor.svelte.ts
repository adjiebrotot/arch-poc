import type { PlanSpec, Floor, Wall, Opening, RoomType } from '@shared/planspec/schema';
import { ROOM_LABELS } from '@shared/planspec/schema';
import { recomputeRooms } from '../engine/openplan3dAdapter';
import { projectOnSegment, pointInPolygon, polygonCentroid, snap, dist, type Vec2 } from '@shared/util/geometry';
import { uid } from '@shared/util/id';
import type { Anchor } from '@shared/comments/model';

export type Tool = 'select' | 'room' | 'wall' | 'door' | 'window' | 'erase';
export type Selection = { kind: 'wall' | 'room' | 'opening'; id: string } | null;
export type Hit = { kind: 'wall' | 'room' | 'opening'; id: string; point: Vec2 } | { kind: 'space'; id: ''; point: Vec2 };

const HISTORY_MAX = 100;
export const GRID = 0.1;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const wallLen = (w: Wall) => dist(w.a, w.b);

export class Editor {
  plan = $state<PlanSpec>(null as unknown as PlanSpec);
  floorIdx = $state(0);
  tool = $state<Tool>('select');
  mode = $state<'edit' | 'comment'>('edit');
  selection = $state<Selection>(null);
  snapping = $state(true);
  showDims = $state(true);
  newWallThickness = $state(0.15);
  private undoStack: string[] = $state([]);
  private redoStack: string[] = $state([]);
  onChange: (() => void) | null = null;

  constructor(plan: PlanSpec) {
    this.plan = plan;
  }

  get floor(): Floor { return this.plan.floors[this.floorIdx] ?? this.plan.floors[0]; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---- history -----------------------------------------------------------------
  snapshot(): string { return JSON.stringify(this.plan); }
  pushHistory(snap = this.snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.plan = JSON.parse(s);
    this.validateSelection();
    this.onChange?.();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.plan = JSON.parse(s);
    this.validateSelection();
    this.onChange?.();
  }
  /** Apply a mutation to the current floor with history + room recompute + autosave. */
  commit(fn: (f: Floor) => Floor | void, opts: { history?: boolean; recompute?: boolean } = {}) {
    if (opts.history !== false) this.pushHistory();
    this.applyFloor(fn, opts.recompute !== false);
  }
  applyFloor(fn: (f: Floor) => Floor | void, recompute = true) {
    const f = structuredClone($state.snapshot(this.floor)) as Floor;
    let next = fn(f) ?? f;
    if (recompute) next = recomputeRooms(next);
    this.plan.floors[this.floorIdx] = next;
    this.validateSelection();
    this.onChange?.();
  }
  validateSelection() {
    const s = this.selection;
    if (!s) return;
    const f = this.floor;
    const exists = s.kind === 'wall' ? f.walls.some((w) => w.id === s.id) : s.kind === 'room' ? f.rooms.some((r) => r.id === s.id) : f.openings.some((o) => o.id === s.id);
    if (!exists) this.selection = null;
  }

  // ---- snapping & hit testing -----------------------------------------------------
  snapPoint(p: Vec2, tol: number): Vec2 {
    if (!this.snapping) return [r3(p[0]), r3(p[1])];
    let best: Vec2 | null = null, bd = tol;
    for (const w of this.floor.walls) for (const e of [w.a, w.b]) {
      const d = dist(p, e);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) return [...best] as Vec2;
    for (const w of this.floor.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.d < tol * 0.6 && pr.t > 0.02 && pr.t < 0.98) {
        // snap onto the wall, but keep grid along it when axis-aligned
        const q = pr.point;
        if (Math.abs(w.a[0] - w.b[0]) < 1e-6) return [w.a[0], snap(q[1], GRID)];
        if (Math.abs(w.a[1] - w.b[1]) < 1e-6) return [snap(q[0], GRID), w.a[1]];
        return [r3(q[0]), r3(q[1])];
      }
    }
    return [r3(snap(p[0], GRID)), r3(snap(p[1], GRID))];
  }

  hitTest(p: Vec2, tol: number): Hit {
    const f = this.floor;
    const wallById = new Map(f.walls.map((w) => [w.id, w]));
    for (const o of f.openings) {
      const w = wallById.get(o.wallId);
      if (!w) continue;
      const pr = projectOnSegment(p, w.a, w.b);
      const along = pr.t * wallLen(w);
      if (pr.d < Math.max(w.thickness / 2, tol) && Math.abs(along - o.offset) < o.width / 2 + tol * 0.3) return { kind: 'opening', id: o.id, point: p };
    }
    let bestW: Wall | null = null, bd = Infinity;
    for (const w of f.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.d < Math.max(w.thickness / 2 + tol * 0.4, tol) && pr.d < bd) { bd = pr.d; bestW = w; }
    }
    if (bestW) return { kind: 'wall', id: bestW.id, point: p };
    // smallest room containing the point
    const rooms = f.rooms.filter((r) => pointInPolygon(p, r.polygon)).sort((a, b) => a.area - b.area);
    if (rooms[0]) return { kind: 'room', id: rooms[0].id, point: p };
    return { kind: 'space', id: '', point: p };
  }

  nearestWall(p: Vec2, tol: number): { wall: Wall; offset: number } | null {
    let best: { wall: Wall; offset: number } | null = null, bd = tol;
    for (const w of this.floor.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.d < bd) { bd = pr.d; best = { wall: w, offset: pr.t * wallLen(w) }; }
    }
    return best;
  }

  // ---- operations -------------------------------------------------------------------
  /** Add the parts of an edge that aren't already covered by a collinear wall. */
  private addEdge(f: Floor, a: Vec2, b: Vec2, thickness: number) {
    const len = dist(a, b);
    if (len < 0.05) return;
    const covered: [number, number][] = [];
    for (const w of f.walls) {
      const pa = projectOnSegment(w.a, a, b), pb = projectOnSegment(w.b, a, b);
      const lineDist = (q: Vec2) => {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / len;
      };
      if (lineDist(w.a) > 0.02 || lineDist(w.b) > 0.02) continue;
      const ta = ((w.a[0] - a[0]) * (b[0] - a[0]) + (w.a[1] - a[1]) * (b[1] - a[1])) / (len * len);
      const tb = ((w.b[0] - a[0]) * (b[0] - a[0]) + (w.b[1] - a[1]) * (b[1] - a[1])) / (len * len);
      void pa; void pb;
      const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(1, Math.max(ta, tb));
      if (hi - lo > 1e-4) covered.push([lo, hi]);
    }
    covered.sort((x, y) => x[0] - y[0]);
    let t = 0;
    const pieces: [number, number][] = [];
    for (const [lo, hi] of covered) {
      if (lo > t + 0.01) pieces.push([t, lo]);
      t = Math.max(t, hi);
    }
    if (t < 0.99) pieces.push([t, 1]);
    for (const [lo, hi] of pieces) {
      const pa: Vec2 = [r3(a[0] + (b[0] - a[0]) * lo), r3(a[1] + (b[1] - a[1]) * lo)];
      const pb: Vec2 = [r3(a[0] + (b[0] - a[0]) * hi), r3(a[1] + (b[1] - a[1]) * hi)];
      if (dist(pa, pb) > 0.05) f.walls.push({ id: uid('w'), a: pa, b: pb, thickness, exterior: false });
    }
  }

  addRoomRect(p0: Vec2, p1: Vec2): string | null {
    const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]);
    const y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const corners: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    this.commit((f) => {
      for (let i = 0; i < 4; i++) this.addEdge(f, corners[i], corners[(i + 1) % 4], this.newWallThickness);
    });
    const c: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
    const room = this.floor.rooms.filter((r) => pointInPolygon(c, r.polygon)).sort((a, b) => a.area - b.area)[0];
    if (room) {
      if (room.name === 'Room') this.applyFloor((f) => { const r = f.rooms.find((x) => x.id === room.id)!; r.name = 'New room'; }, false);
      this.selection = { kind: 'room', id: room.id };
      return room.id;
    }
    return null;
  }

  addWall(a: Vec2, b: Vec2) {
    if (dist(a, b) < 0.1) return;
    this.commit((f) => this.addEdge(f, a, b, this.newWallThickness));
  }

  addOpening(type: 'door' | 'window', p: Vec2, tol: number): boolean {
    const hit = this.nearestWall(p, tol);
    if (!hit) return false;
    const w = hit.wall;
    const len = wallLen(w);
    const width = Math.min(type === 'door' ? 0.82 : 1.2, len - 0.2);
    if (width < 0.4) return false;
    const offset = r3(Math.min(len - width / 2 - 0.05, Math.max(width / 2 + 0.05, snap(hit.offset, GRID))));
    const o: Opening = type === 'door'
      ? { id: uid('o'), wallId: w.id, type, offset, width, height: 2.04 }
      : { id: uid('o'), wallId: w.id, type, offset, width, height: 1.2, sill: 0.9 };
    this.commit((f) => { f.openings.push(o); }, { recompute: false });
    this.selection = { kind: 'opening', id: o.id };
    return true;
  }

  /** Move a wall along its normal; walls attached to it (ends or T-junctions) follow. */
  moveWallFrom(start: Floor, id: string, delta: Vec2): void {
    const w0 = start.walls.find((w) => w.id === id);
    if (!w0) return;
    const len = wallLen(w0) || 1;
    const nx = -(w0.b[1] - w0.a[1]) / len, ny = (w0.b[0] - w0.a[0]) / len;
    let d = delta[0] * nx + delta[1] * ny;
    if (this.snapping) d = snap(d, GRID);
    const dv: Vec2 = [nx * d, ny * d];
    const mv = (p: Vec2): Vec2 => [r3(p[0] + dv[0]), r3(p[1] + dv[1])];
    this.applyFloor(() => {
      const f = structuredClone(start) as Floor;
      for (const w of f.walls) {
        if (w.id === id) { w.a = mv(w.a); w.b = mv(w.b); continue; }
        for (const k of ['a', 'b'] as const) if (projectOnSegment(w[k], w0.a, w0.b).d < 0.02) w[k] = mv(w[k]);
      }
      // keep openings inside their (possibly resized) walls
      const byId = new Map(f.walls.map((w) => [w.id, w]));
      for (const o of f.openings) {
        const w = byId.get(o.wallId);
        if (w) o.offset = r3(Math.min(Math.max(o.offset, o.width / 2), Math.max(o.width / 2, wallLen(w) - o.width / 2)));
      }
      return f;
    });
  }

  moveOpeningFrom(start: Floor, id: string, p: Vec2) {
    const o0 = start.openings.find((o) => o.id === id);
    const w = start.walls.find((x) => x.id === o0?.wallId);
    if (!o0 || !w) return;
    const len = wallLen(w);
    const t = projectOnSegment(p, w.a, w.b).t * len;
    const off = Math.min(len - o0.width / 2, Math.max(o0.width / 2, this.snapping ? snap(t, GRID) : t));
    this.applyFloor(() => {
      const f = structuredClone(start) as Floor;
      f.openings.find((o) => o.id === id)!.offset = r3(off);
      return f;
    }, false);
  }

  deleteElement(sel: NonNullable<Selection>) {
    this.commit((f) => {
      if (sel.kind === 'opening') f.openings = f.openings.filter((o) => o.id !== sel.id);
      if (sel.kind === 'wall') {
        f.walls = f.walls.filter((w) => w.id !== sel.id);
        f.openings = f.openings.filter((o) => o.wallId !== sel.id);
      }
      if (sel.kind === 'room') {
        // Removing a room = removing walls that only bound this room and nothing else.
        const room = f.rooms.find((r) => r.id === sel.id);
        if (!room) return;
        const others = f.rooms.filter((r) => r.id !== sel.id);
        const onBoundary = (w: Wall) => {
          const mid: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
          return room.polygon.some((p, i) => projectOnSegment(mid, p, room.polygon[(i + 1) % room.polygon.length]).d < 0.02);
        };
        const sharedWith = (w: Wall) => others.some((r) => {
          const mid: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
          return r.polygon.some((p, i) => projectOnSegment(mid, p, r.polygon[(i + 1) % r.polygon.length]).d < 0.02);
        });
        const remove = new Set(f.walls.filter((w) => onBoundary(w) && !sharedWith(w)).map((w) => w.id));
        f.walls = f.walls.filter((w) => !remove.has(w.id));
        f.openings = f.openings.filter((o) => !remove.has(o.wallId));
      }
    });
    this.selection = null;
  }

  updateRoom(id: string, patch: { name?: string; type?: RoomType }) {
    this.commit((f) => {
      const r = f.rooms.find((x) => x.id === id);
      if (!r) return;
      if (patch.type && (r.name === ROOM_LABELS[r.type] || ['Room', 'New room'].includes(r.name)) && !patch.name) r.name = ROOM_LABELS[patch.type];
      Object.assign(r, patch);
    }, { recompute: false });
  }
  updateOpening(id: string, patch: Partial<Opening>) {
    this.commit((f) => { const o = f.openings.find((x) => x.id === id); if (o) Object.assign(o, patch); }, { recompute: false });
  }
  updateWall(id: string, patch: Partial<Wall>) {
    this.commit((f) => { const w = f.walls.find((x) => x.id === id); if (w) Object.assign(w, patch); }, { recompute: false });
  }

  addFloor() {
    this.pushHistory();
    const top = this.plan.floors[this.plan.floors.length - 1];
    // Copy the outer walls of the top floor as a starting point.
    const walls = top.walls.filter((w) => w.exterior).map((w) => ({ ...w, id: uid('w') }));
    this.plan.floors.push(recomputeRooms({ level: top.level + 1, height: top.height, walls, rooms: [], openings: [] }));
    this.floorIdx = this.plan.floors.length - 1;
    this.onChange?.();
  }
  removeFloor() {
    if (this.plan.floors.length < 2) return;
    this.pushHistory();
    this.plan.floors.splice(this.floorIdx, 1);
    this.plan.floors.forEach((f, i) => (f.level = i));
    this.floorIdx = Math.max(0, this.floorIdx - 1);
    this.onChange?.();
  }

  // ---- comment anchors (pins follow their element) ---------------------------------
  anchorFor(hit: Hit): Anchor {
    const f = this.floor;
    const p = hit.point;
    const base = { floor: f.level, position: [p[0], 0, p[1]] as [number, number, number] };
    if (hit.kind === 'wall') {
      const w = f.walls.find((x) => x.id === hit.id)!;
      const pr = projectOnSegment(p, w.a, w.b);
      const len = wallLen(w) || 1;
      const side = ((p[0] - pr.point[0]) * -(w.b[1] - w.a[1]) + (p[1] - pr.point[1]) * (w.b[0] - w.a[0])) / len;
      return { ...base, elementId: w.id, elementKind: 'wall', local: [pr.t, side], elementLabel: w.exterior ? 'Outside wall' : 'Wall' };
    }
    if (hit.kind === 'room') {
      const r = f.rooms.find((x) => x.id === hit.id)!;
      const c = polygonCentroid(r.polygon);
      return { ...base, elementId: r.id, elementKind: 'room', local: [p[0] - c[0], p[1] - c[1]], elementLabel: r.name };
    }
    if (hit.kind === 'opening') {
      const o = f.openings.find((x) => x.id === hit.id)!;
      return { ...base, elementId: o.id, elementKind: o.type, local: [], elementLabel: o.type === 'door' ? 'Door' : 'Window' };
    }
    return { ...base, elementKind: 'space', elementLabel: 'Open space' };
  }

  /** Current plan position of an anchor (follows moved elements). */
  resolveAnchor(a: Anchor): Vec2 | null {
    const f = this.plan.floors.find((x) => x.level === (a.floor ?? 0));
    if (!f) return null;
    const fallback: Vec2 = [a.position[0], a.position[2]];
    if (!a.elementId) return fallback;
    if (a.elementKind === 'wall') {
      const w = f.walls.find((x) => x.id === a.elementId);
      if (!w || !a.local) return fallback;
      const len = wallLen(w) || 1;
      const nx = -(w.b[1] - w.a[1]) / len, ny = (w.b[0] - w.a[0]) / len;
      const t = a.local[0];
      return [w.a[0] + (w.b[0] - w.a[0]) * t + nx * a.local[1], w.a[1] + (w.b[1] - w.a[1]) * t + ny * a.local[1]];
    }
    if (a.elementKind === 'room') {
      const r = f.rooms.find((x) => x.id === a.elementId);
      if (!r || !a.local) return fallback;
      const c = polygonCentroid(r.polygon);
      return [c[0] + a.local[0], c[1] + a.local[1]];
    }
    const o = f.openings.find((x) => x.id === a.elementId);
    const w = o && f.walls.find((x) => x.id === o.wallId);
    if (!o || !w) return fallback;
    const len = wallLen(w) || 1;
    return [w.a[0] + ((w.b[0] - w.a[0]) * o.offset) / len, w.a[1] + ((w.b[1] - w.a[1]) * o.offset) / len];
  }
}
