import { describe, it, expect } from 'vitest';
import { Editor } from '../src/features/design/workspace/editor.svelte';
import { emptyPlan, type Floor, type PlanSpec } from '../src/shared/planspec/schema';
import { normalizeSite, rectBoundary } from '../src/shared/planspec/site';
import { polygonArea, type Vec2 } from '../src/shared/util/geometry';

const L: Vec2[] = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
const snap = (e: Editor) => structuredClone(JSON.parse(JSON.stringify(e.floor))) as Floor;

describe('workspace: rooms of any shape', () => {
  it('draws an L-shaped room from its corners', () => {
    const e = new Editor(emptyPlan('pro'));
    const res = e.addRoomPolygon(L);
    expect(res.error).toBeUndefined();
    expect(e.floor.walls).toHaveLength(6);
    const room = e.floor.rooms.find((r) => r.id === res.id)!;
    expect(room.area).toBeCloseTo(27, 1);
    expect(room.polygon).toHaveLength(6);
    expect(e.floor.walls.every((w) => w.exterior)).toBe(true);
  });

  it('refuses outlines that cross themselves', () => {
    const e = new Editor(emptyPlan('pro'));
    expect(e.addRoomPolygon([[0, 0], [4, 4], [4, 0], [0, 4]]).error).toMatch(/crosses/);
    expect(e.floor.walls).toHaveLength(0);
  });

  it('drags a corner: both walls follow and the area updates', () => {
    const e = new Editor(emptyPlan('pro'));
    e.snapping = false;
    e.addRoomPolygon([[0, 0], [4, 0], [4, 4], [0, 4]]);
    e.moveVertexFrom(snap(e), [4, 4], [5, 6]);
    const r = e.floor.rooms[0];
    expect(r.polygon.length).toBe(4);
    expect(polygonArea(r.polygon)).toBeCloseTo(22, 1); // (0,0) (4,0) (5,6) (0,4)
    expect(e.floor.walls.filter((w) => w.a.join() === '5,6' || w.b.join() === '5,6')).toHaveLength(2);
  });

  it('pulling the middle of a side adds a corner (splits the wall, keeps its window)', () => {
    const e = new Editor(emptyPlan('pro'));
    e.snapping = false;
    e.addRoomPolygon([[0, 0], [6, 0], [6, 4], [0, 4]]);
    const top = e.floor.walls.find((w) => w.a[1] === 0 && w.b[1] === 0)!;
    e.addOpening('window', [1.2, 0], 0.3);
    const sp = e.splitWall(snap(e), top.id, [3, 0])!;
    expect(sp.floor.walls).toHaveLength(5);
    e.moveVertexFrom(sp.floor, sp.point, [3, -1.5]);
    const r = e.floor.rooms[0];
    expect(r.polygon).toHaveLength(5);
    expect(r.area).toBeCloseTo(24 + 4.5, 1);
    expect(e.floor.openings).toHaveLength(1);
    // removing that corner straightens the side again
    expect(e.removeVertex([3, -1.5])).toBeNull();
    expect(e.floor.walls).toHaveLength(4);
    expect(e.floor.rooms[0].area).toBeCloseTo(24, 1);
    // the window is moved back onto the straightened wall
    expect(e.floor.openings).toHaveLength(1);
    expect(e.floor.walls.some((w) => w.id === e.floor.openings[0].wallId)).toBe(true);
  });

  it('an inside wall that T-joins a moved wall slides along with it', () => {
    const e = new Editor(emptyPlan('pro'));
    e.snapping = false;
    e.addRoomPolygon([[0, 0], [6, 0], [6, 4], [0, 4]]);
    e.addWall([3, 0], [3, 4]);
    expect(e.floor.rooms).toHaveLength(2);
    // drag the bottom-right corner down: the right wall leans, the bottom wall tilts
    e.moveVertexFrom(snap(e), [6, 4], [6, 6]);
    const inner = e.floor.walls.find((w) => (w.a[0] === 3 && w.a[1] === 0) || (w.b[0] === 3 && w.b[1] === 0))!;
    const low = inner.a[1] === 0 ? inner.b : inner.a;
    expect(low[0]).toBeCloseTo(3);
    expect(low[1]).toBeCloseTo(5); // still on the tilted bottom wall (4 → 6 across 6 m, at x = 3 → 5)
    expect(e.floor.rooms).toHaveLength(2);
  });
});

const rect = (x: number, y: number, w: number, d: number): Vec2[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
/** A sketch-mode plan in the workspace: 24 × 30 lot, a 14 × 10 m ground floor with its outside walls. */
function sketch(): Editor {
  const p: PlanSpec = emptyPlan('pro');
  p.meta.stage = 'design';
  p.site = normalizeSite({ width: 24, depth: 30, northAngle: 0, boundary: rectBoundary(0, 0, 24, 30), roads: [{ edge: 2 }] });
  p.floors[0].footprint = rect(4, 6, 14, 10);
  const e = new Editor(p);
  e.addEnvelopeWalls();
  return e;
}

describe('workspace: rooms stay inside the footprint', () => {
  it('starts with outside walls along the footprint and one open space', () => {
    const e = sketch();
    expect(e.floor.walls).toHaveLength(4);
    expect(e.floor.rooms.map((r) => r.name)).toEqual(['Open space']);
    expect(e.roomBounds![0]).toEqual([4.125, 6.125]);
  });

  it('snaps corners to the 1 m grid and pulls stray ones onto the outside wall', () => {
    const e = sketch();
    expect(e.snapPoint([8.4, 9.6], 0.2)).toEqual([8, 10]);
    expect(e.snapPoint([9.4, 3], 0.2)).toEqual([9, 6.125]); // outside, above the top wall
  });

  it('draws rooms inside and refuses rooms that reach outside', () => {
    const e = sketch();
    const ok = e.addRoomPolygon([[4.125, 6.125], [10, 6.125], [10, 11], [4.125, 11]]);
    expect(ok.error).toBeUndefined();
    expect(e.floor.rooms.find((r) => r.id === ok.id)!.name).toBe('New room');
    expect(e.floor.rooms.some((r) => r.name === 'Open space')).toBe(true);
    expect(e.addRoomPolygon([[12, 8], [22, 8], [22, 12], [12, 12]]).error).toMatch(/inside/);
    expect(e.addRoomRect([15, 14], [20, 18]).error).toMatch(/inside/);
    expect(e.addWall([12, 8], [12, 20])).toMatch(/inside/);
  });

  it('protects the outside walls: they change only with the footprint', () => {
    const e = sketch();
    const outer = e.floor.walls[0];
    expect(e.deleteElement({ kind: 'wall', id: outer.id })).toMatch(/Footprint/);
    expect(e.floor.walls).toHaveLength(4);
    const before = JSON.stringify(e.floor.walls);
    e.moveWallFrom(snap(e), outer.id, [0, -3]);
    expect(JSON.stringify(e.floor.walls)).toBe(before);
  });

  it('reshapes the footprint and the rooms follow, but never past the lot', () => {
    const e = sketch();
    e.addRoomPolygon([[4.125, 6.125], [10, 6.125], [10, 11], [4.125, 11]]);
    expect(e.moveFootprintVertexFrom(rect(4, 6, 14, 10), 2, [20, 16], 0.2)).toBeNull();
    expect(e.floor.footprint).toEqual([[4, 6], [18, 6], [20, 16], [4, 16]]);
    expect(e.moveFootprintVertexFrom(e.floor.footprint!, 2, [26, 16], 0.2)).toMatch(/inside the lot/);
    expect(e.setFootprint(rect(4, 6, 5, 10))).toMatch(/outside the footprint|rooms/i);
  });

  it('adds a floor as a copy of the one below, then keeps it inside it', () => {
    const e = sketch();
    e.addFloor();
    expect(e.floorIdx).toBe(1);
    expect(e.floor.footprint).toEqual(rect(4, 6, 14, 10));
    expect(e.floor.walls).toHaveLength(4);
    expect(e.moveFootprintVertexFrom(e.floor.footprint!, 2, [18, 12], 0.2)).toBeNull();
    expect(e.moveFootprintVertexFrom(e.floor.footprint!, 1, [21, 6], 0.2)).toMatch(/inside the footprint of the ground floor/);
    // the ground floor can't shrink under level 2 any more, nor the lot under the ground floor
    e.floorIdx = 0;
    expect(e.setFootprint(rect(4, 6, 10, 10))).toMatch(/Level 2 sits on this floor/);
    expect(e.moveLotVertexFrom(e.site, 1, [10, 0], 0.2)).toMatch(/ground floor has to stay inside the lot/);
  });
});
