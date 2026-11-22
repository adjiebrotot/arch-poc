import { describe, it, expect } from 'vitest';
import { Editor } from '../src/features/design/workspace/editor.svelte';
import { emptyPlan, type Floor } from '../src/shared/planspec/schema';
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
