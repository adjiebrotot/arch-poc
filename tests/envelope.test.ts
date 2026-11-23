import { describe, it, expect } from 'vitest';
import { polygonInPolygon, offsetPolygon, polygonArea, clipSegmentToPolygon, segmentInPolygon, type Vec2 } from '../src/shared/util/geometry';
import * as env from '../src/shared/planspec/envelope';
import { emptyPlan, PlanSpecSchema, type PlanSpec, type Floor } from '../src/shared/planspec/schema';
import { normalizeSite, rectBoundary } from '../src/shared/planspec/site';
import { recomputeRooms, ensureFootprints } from '../src/features/design/engine/openplan3dAdapter';

const rect = (x: number, y: number, w: number, d: number): Vec2[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
const L: Vec2[] = [[4, 6], [18, 6], [18, 16], [11, 16], [11, 22], [4, 22]];

function planWith(lot: Vec2[], ...fps: Vec2[][]): PlanSpec {
  const p = emptyPlan('creative');
  p.site = normalizeSite({ width: 0, depth: 0, northAngle: 0, boundary: lot, roads: [{ edge: 2 }] });
  p.floors = fps.map((fp, i) => ({ level: i, height: 2.7, walls: [], rooms: [], openings: [], footprint: fp }));
  return p;
}

describe('polygon containment', () => {
  it('accepts shared edges and corners, rejects anything poking out', () => {
    const lot = rect(0, 0, 20, 30);
    expect(polygonInPolygon(rect(0, 0, 10, 10), lot)).toBe(true); // flush with two sides
    expect(polygonInPolygon(rect(15, 5, 6, 4), lot)).toBe(false);
    expect(polygonInPolygon(L, rect(4, 6, 14, 16))).toBe(true);
  });

  it('catches a side that crosses a notch even when every corner is inside', () => {
    // U-shaped container; the candidate bridges the gap between its legs
    const U: Vec2[] = [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]];
    expect(polygonInPolygon([[1, 8], [11, 8], [11, 9], [1, 9]], U)).toBe(false);
    expect(polygonInPolygon([[1, 1], [11, 1], [11, 3], [1, 3]], U)).toBe(true);
  });

  it('clips a segment to the strictly-inside parts of a polygon', () => {
    const U: Vec2[] = [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]];
    const parts = clipSegmentToPolygon([-2, 6], [14, 6], U);
    expect(parts).toHaveLength(2);
    expect(parts[0][0][0]).toBeCloseTo(0); expect(parts[0][1][0]).toBeCloseTo(4);
    expect(segmentInPolygon([0, 0], [12, 0], U)).toBe(true); // along the outline
  });

  it('pulls a footprint in by half a wall for the wall line', () => {
    const line = env.wallLine(L);
    expect(line).toHaveLength(6);
    expect(line[0]).toEqual([4.125, 6.125]);
    expect(polygonInPolygon(line, L)).toBe(true);
    expect(polygonArea(offsetPolygon(rect(0, 0, 10, 8), -1))).toBeCloseTo(12 * 10);
  });
});

describe('the envelope hierarchy: lot ⊇ ground ⊇ level 2 ⊇ level 3', () => {
  const lot = rect(0, 0, 24, 30);
  it('keeps the ground floor inside the lot', () => {
    const p = planWith(lot, L);
    expect(env.checkFootprint(p, 0, L)).toBeNull();
    expect(env.checkFootprint(p, 0, rect(10, 10, 20, 8))).toMatch(/inside the lot/);
    expect(env.checkFootprint(p, 0, [[0, 0], [5, 5], [5, 0], [0, 5]])).toMatch(/crosses/);
  });

  it('keeps every upper floor inside the floor below, and the floor below around it', () => {
    const p = planWith(lot, L, rect(4, 6, 14, 10));
    expect(env.checkFootprint(p, 1, rect(4, 6, 14, 10))).toBeNull();
    expect(env.checkFootprint(p, 1, rect(4, 6, 16, 10))).toMatch(/inside the footprint of the ground floor/);
    // shrinking the ground floor under level 2 is refused
    expect(env.checkFootprint(p, 0, rect(4, 6, 10, 10))).toMatch(/Level 2 sits on this floor/);
    // the lot can't cut into the ground floor
    expect(env.checkLot(p, rect(0, 0, 15, 30))).toMatch(/ground floor has to stay inside the lot/);
    expect(env.checkLot(p, [[0, 0], [24, 0], [24, 30], [2, 30], [0, 12]])).toBeNull();
    expect(env.hierarchyProblems(p)).toEqual([]);
  });

  it('starts a new floor as an exact copy of the one below', () => {
    const below: Floor = { level: 0, height: 2.8, walls: [], rooms: [], openings: [], footprint: L };
    const up = env.floorAbove(below, false);
    expect(up.level).toBe(1);
    expect(up.footprint).toEqual(L);
    expect(up.footprint).not.toBe(L);
    const withWalls = env.floorAbove(below, true);
    expect(withWalls.walls).toHaveLength(6);
    expect(withWalls.walls.every((w) => w.exterior && w.thickness === env.ENVELOPE_T)).toBe(true);
  });

  it('a plan without a lot or footprints is not complete', () => {
    expect(env.envelopeComplete(emptyPlan('chat'))).toBe(false);
    expect(env.envelopeComplete(planWith(lot, L))).toBe(true);
    expect(() => PlanSpecSchema.parse(planWith(lot, L))).not.toThrow();
  });
});

describe('changing a footprint under existing rooms', () => {
  function sketched(): Floor {
    const f0: Floor = { level: 0, height: 2.7, walls: env.envelopeWalls(rect(0, 0, 10, 8)), rooms: [], openings: [], footprint: rect(0, 0, 10, 8) };
    // an inside wall from the top outside wall to the bottom one
    f0.walls.push({ id: 'in', a: [5, 0.125], b: [5, 7.875], thickness: 0.1, exterior: false });
    f0.openings.push({ id: 'win', wallId: f0.walls[0].id, type: 'window', offset: 2, width: 1.2, height: 1.2, sill: 0.9 });
    return recomputeRooms(f0);
  }

  it('moves the outside walls and keeps inside walls attached to them', () => {
    const res = env.applyFootprint(sketched(), rect(0, 0, 10, 12));
    expect('floor' in res).toBe(true);
    if (!('floor' in res)) return;
    const inner = res.floor.walls.find((w) => w.id === 'in')!;
    expect(inner.b).toEqual([5, 11.875]); // slid down to the moved bottom wall
    expect(res.floor.openings).toHaveLength(1);
    expect(recomputeRooms(res.floor).rooms).toHaveLength(2);
  });

  it('refuses a footprint that would leave rooms outside it', () => {
    const f = sketched();
    f.walls.push({ id: 'free', a: [7, 3], b: [9.5, 3], thickness: 0.1, exterior: false });
    const res = env.applyFootprint(f, rect(0, 0, 8, 8));
    expect('error' in res).toBe(true);
  });

  it('gives older plans a footprint traced from their outside walls', () => {
    const p = emptyPlan('pro');
    p.floors[0].walls = env.envelopeWalls(rect(2, 3, 12, 9)).map((w, i) => ({ ...w, id: `old${i}` }));
    ensureFootprints(p);
    expect(p.floors[0].footprint).toEqual(rect(2, 3, 12, 9));
  });
});

describe('lot drawn on the grid', () => {
  it('snaps corners to the 1 m grid', () => {
    expect(env.snapToGrid([3.4, -1.6])).toEqual([3, -2]);
    expect(rectBoundary(0, 0, 3, 2)).toHaveLength(4);
  });
});
