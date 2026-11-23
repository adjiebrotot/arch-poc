/**
 * Adapter between our canonical PlanSpec (metres, [x,y] tuples, room polygons)
 * and the vendored openPlan3D data model (centimetres, {x,y} points, rooms
 * defined by their bounding walls, openings positioned 0–1 along a wall).
 *
 * openPlan3D's room detection (planar face tracing with T-junction splitting)
 * is what turns a set of walls into rooms with live areas in the workspace.
 */
import type { OP3DFloor, OP3DWall, OP3DRoom } from '@vendor/openplan3d';
import { resolveRoomGeometry } from '@vendor/openplan3d';
import type { PlanSpec, Floor, Room, Wall, RoomType } from '@shared/planspec/schema';
import { ROOM_TYPES } from '@shared/planspec/schema';
import { pointInPolygon, polygonCentroid, polygonArea, offsetPolygon, type Vec2 } from '@shared/util/geometry';
import { ENVELOPE_T } from '@shared/planspec/envelope';

const CM = 100;
const toCm = (v: number) => Math.round(v * CM * 10) / 10;
const toM = (v: number) => Math.round((v / CM) * 1000) / 1000;
const wallLen = (w: Wall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

function emptyOP3DFloor(level: number, heightM: number): OP3DFloor {
  return {
    id: `floor-${level}`,
    name: level === 0 ? 'Ground floor' : `Level ${level + 1}`,
    level,
    elevation: Math.round(level * heightM * CM),
    walls: [], rooms: [], doors: [], windows: [], furniture: [], stairs: [], columns: [],
    guides: [], measurements: [], annotations: [], textAnnotations: [], groups: [],
  };
}

function wallToOP3D(w: Wall, heightM: number): OP3DWall {
  return {
    id: w.id,
    start: { x: toCm(w.a[0]), y: toCm(w.a[1]) },
    end: { x: toCm(w.b[0]), y: toCm(w.b[1]) },
    thickness: toCm(w.thickness),
    height: Math.round(heightM * CM),
    color: w.exterior ? '#d9d4cc' : '#f2efe9',
    details: { material: w.exterior ? 'exterior' : 'interior' },
  };
}

/** Detect room faces for a set of PlanSpec walls using openPlan3D. */
export function detectFaces(walls: Wall[], heightM: number): { room: OP3DRoom; polygon: Vec2[] }[] {
  if (walls.length < 3) return [];
  const faces = resolveRoomGeometry({ walls: walls.map((w) => wallToOP3D(w, heightM)), rooms: [] });
  return faces
    .map((f) => ({ room: f.room, polygon: f.polygon.map((p) => [toM(p.x), toM(p.y)] as Vec2) }))
    .filter((f) => f.polygon.length >= 3 && polygonArea(f.polygon) > 0.3);
}

/** Find the previous room that best corresponds to a newly detected face. */
function matchRoom(face: Vec2[], previous: Room[], used: Set<string>): Room | undefined {
  let best: Room | undefined;
  let bestScore = -Infinity;
  for (const r of previous) {
    if (used.has(r.id) || r.polygon.length < 3) continue;
    const c = polygonCentroid(r.polygon);
    if (!pointInPolygon(c, face)) continue;
    // Prefer the room whose size is closest to the face.
    const score = -Math.abs(polygonArea(face) - r.area);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/** Exterior if, somewhere along the wall, one side is outside every room. */
function isExterior(w: Wall, rooms: Room[]): boolean {
  const len = wallLen(w);
  if (len < 1e-6 || rooms.length === 0) return w.exterior;
  const nx = -(w.b[1] - w.a[1]) / len, ny = (w.b[0] - w.a[0]) / len;
  const off = w.thickness / 2 + 0.08;
  for (const t of [0.15, 0.5, 0.85]) {
    const px = w.a[0] + (w.b[0] - w.a[0]) * t, py = w.a[1] + (w.b[1] - w.a[1]) * t;
    for (const s of [1, -1]) {
      const p: Vec2 = [px + nx * off * s, py + ny * off * s];
      if (!rooms.some((r) => pointInPolygon(p, r.polygon))) return true;
    }
  }
  return false;
}

/**
 * Recompute rooms (polygons + live areas) from the floor's walls, keeping the
 * names/types of rooms that still exist. Also refreshes exterior flags.
 */
export function recomputeRooms(floor: Floor): Floor {
  const faces = detectFaces(floor.walls, floor.height);
  const used = new Set<string>();
  const rooms: Room[] = faces.map((f, i) => {
    const prev = matchRoom(f.polygon, floor.rooms, used);
    if (prev) used.add(prev.id);
    return {
      id: prev?.id ?? `room-${floor.level}-${i}-${Math.round(polygonCentroid(f.polygon)[0] * 10)}`,
      name: prev?.name ?? 'Room',
      type: prev?.type ?? 'other',
      polygon: f.polygon,
      // openPlan3D deducts rooms drawn inside another room (an island) from the outer one
      area: Math.round((f.room.area > 0 ? f.room.area : polygonArea(f.polygon)) * 10) / 10,
    };
  });
  const walls = floor.walls.map((w) => ({ ...w, exterior: isExterior(w, rooms) }));
  return { ...floor, walls, rooms };
}

/**
 * Footprint for plans made before footprints existed: the outline traced by the outside walls,
 * pushed out by half a wall so it is the outer face of the building.
 */
export function deriveFootprint(floor: Floor): Vec2[] | null {
  const ext = floor.walls.filter((w) => w.exterior);
  const faces = detectFaces(ext.length >= 3 ? ext : floor.walls, floor.height);
  if (!faces.length) return null;
  const outline = faces.sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0].polygon;
  return offsetPolygon(outline, -ENVELOPE_T / 2).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as Vec2);
}

/** Give every floor with walls a footprint (older plans). Mutates and returns the plan. */
export function ensureFootprints(plan: PlanSpec): PlanSpec {
  for (const f of plan.floors) {
    if (f.footprint || !f.walls.length) continue;
    const fp = deriveFootprint(f);
    if (fp) f.footprint = fp;
  }
  return plan;
}

/** PlanSpec → openPlan3D floors (cm). Room metadata travels in `details.roomType`. */
export function planSpecToOpenPlan3D(plan: PlanSpec): OP3DFloor[] {
  return plan.floors.map((f) => {
    const out = emptyOP3DFloor(f.level, f.height);
    out.walls = f.walls.map((w) => wallToOP3D(w, f.height));
    const byId = new Map(f.walls.map((w) => [w.id, w]));
    for (const o of f.openings) {
      const w = byId.get(o.wallId);
      if (!w) continue;
      const position = Math.min(1, Math.max(0, o.offset / (wallLen(w) || 1)));
      if (o.type === 'door') {
        out.doors.push({ id: o.id, wallId: o.wallId, position, width: toCm(o.width), height: toCm(o.height), type: 'single', swingDirection: 'left', flipSide: false });
      } else {
        out.windows.push({ id: o.id, wallId: o.wallId, position, width: toCm(o.width), height: toCm(o.height), sillHeight: toCm(o.sill ?? 0.9), type: 'standard' });
      }
    }
    const faces = detectFaces(f.walls, f.height);
    const used = new Set<string>();
    out.rooms = faces.map((face) => {
      const meta = matchRoom(face.polygon, f.rooms, used);
      if (meta) used.add(meta.id);
      return {
        ...face.room,
        id: meta?.id ?? face.room.id,
        name: meta?.name ?? 'Room',
        floorTexture: meta?.type === 'bathroom' || meta?.type === 'ensuite' ? 'tile' : 'wood',
        details: { roomType: meta?.type ?? 'other' },
      };
    });
    return out;
  });
}

/** openPlan3D floors (cm) → PlanSpec. */
export function openPlan3DToPlanSpec(floors: OP3DFloor[], meta: PlanSpec['meta'], heightM = 2.7): PlanSpec {
  const outFloors: Floor[] = floors.map((f) => {
    const walls: Wall[] = f.walls.map((w) => ({
      id: w.id,
      a: [toM(w.start.x), toM(w.start.y)],
      b: [toM(w.end.x), toM(w.end.y)],
      thickness: toM(w.thickness),
      exterior: w.details?.material === 'exterior',
    }));
    const byId = new Map(walls.map((w) => [w.id, w]));
    const h = f.walls[0] ? f.walls[0].height / CM : heightM;
    const openings = [
      ...f.doors.map((d) => ({ id: d.id, wallId: d.wallId, type: 'door' as const, offset: toM(d.position * Math.hypot(...sub(f, d.wallId))), width: toM(d.width), height: toM(d.height) })),
      ...f.windows.map((d) => ({ id: d.id, wallId: d.wallId, type: 'window' as const, offset: toM(d.position * Math.hypot(...sub(f, d.wallId))), width: toM(d.width), height: toM(d.height), sill: toM(d.sillHeight) })),
    ].filter((o) => byId.has(o.wallId));
    const faces = resolveRoomGeometry(f);
    const rooms: Room[] = faces.map((face, i) => {
      const t = face.room.details?.roomType as RoomType | undefined;
      const polygon = face.polygon.map((p) => [toM(p.x), toM(p.y)] as Vec2);
      return {
        id: face.room.id || `room-${i}`,
        name: face.room.name || 'Room',
        type: t && (ROOM_TYPES as readonly string[]).includes(t) ? t : 'other',
        polygon,
        area: Math.round(polygonArea(polygon) * 10) / 10,
      };
    });
    return { level: f.level, height: h, walls, rooms, openings };
  });
  return { version: '1.0', meta, floors: outFloors };
}

function sub(f: OP3DFloor, wallId: string): [number, number] {
  const w = f.walls.find((x) => x.id === wallId);
  return w ? [w.end.x - w.start.x, w.end.y - w.start.y] : [0, 0];
}
