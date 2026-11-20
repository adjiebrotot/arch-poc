import { describe, it, expect } from 'vitest';
import { planSpecToOpenPlan3D, openPlan3DToPlanSpec, recomputeRooms } from '../src/features/design/engine/openplan3dAdapter';
import { generatePlan } from '../src/features/design/generator/generator';
import { planSignature } from '../src/features/design/generator/generator';

const plan = generatePlan({ area: 120, floors: 1, bedrooms: 3, bathrooms: 1, extras: ['laundry'], seed: 4 });

describe('PlanSpec ⇄ openPlan3D adapters', () => {
  it('converts to openPlan3D centimetre floors', () => {
    const op = planSpecToOpenPlan3D(plan);
    expect(op).toHaveLength(1);
    const w0 = plan.floors[0].walls[0];
    expect(op[0].walls[0].start).toEqual({ x: w0.a[0] * 100, y: w0.a[1] * 100 });
    expect(op[0].doors.length + op[0].windows.length).toBe(plan.floors[0].openings.length);
    // openPlan3D detects the same number of rooms from the walls alone
    expect(op[0].rooms.length).toBe(plan.floors[0].rooms.length);
    expect(op[0].rooms.map((r) => r.name).sort()).toEqual(plan.floors[0].rooms.map((r) => r.name).sort());
  });

  it('round-trips without losing rooms, walls or openings', () => {
    const back = openPlan3DToPlanSpec(planSpecToOpenPlan3D(plan), plan.meta);
    expect(back.floors[0].walls).toHaveLength(plan.floors[0].walls.length);
    expect(back.floors[0].openings).toHaveLength(plan.floors[0].openings.length);
    expect(planSignature({ ...back, floors: back.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => ({ ...r, polygon: bbox(r.polygon) })) })) }))
      .toEqual(planSignature({ ...plan, floors: plan.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => ({ ...r, polygon: bbox(r.polygon) })) })) }));
    for (const o of plan.floors[0].openings) {
      const b = back.floors[0].openings.find((x) => x.id === o.id)!;
      expect(b.offset).toBeCloseTo(o.offset, 2);
    }
  });

  it('recomputeRooms keeps room names and exterior flags', () => {
    const f = recomputeRooms(plan.floors[0]);
    expect(f.rooms.map((r) => r.name).sort()).toEqual(plan.floors[0].rooms.map((r) => r.name).sort());
    expect(f.walls.map((w) => w.exterior)).toEqual(plan.floors[0].walls.map((w) => w.exterior));
  });
});

function bbox(p: [number, number][]): [number, number][] {
  const xs = p.map((v) => v[0]), ys = p.map((v) => v[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}
