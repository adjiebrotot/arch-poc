import { describe, it, expect } from 'vitest';
import { generatePlan, generateVariants, planSignature } from '../src/features/design/generator/generator';
import { PlanSpecSchema } from '../src/shared/planspec/schema';
import { TEMPLATES, templatePlan } from '../src/features/design/generator/templates';

const brief = { area: 140, floors: 1, bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] };

describe('seeded generator', () => {
  it('is deterministic: same inputs + seed ⇒ same plan', () => {
    const a = generatePlan({ ...brief, seed: 42 });
    const b = generatePlan({ ...brief, seed: 42 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('produces valid PlanSpecs containing the requested rooms', () => {
    const p = generatePlan({ ...brief, seed: 3 });
    expect(() => PlanSpecSchema.parse(p)).not.toThrow();
    const types = p.floors[0].rooms.map((r) => r.type);
    expect(types.filter((t) => t === 'bedroom' || t === 'master').length).toBe(3);
    expect(types.filter((t) => t === 'bathroom' || t === 'ensuite').length).toBe(2);
    expect(types).toContain('garage');
    expect(types).toContain('laundry');
    expect(types).toContain('hallway');
  });

  it('room areas sum to the footprint and are all positive', () => {
    const p = generatePlan({ ...brief, seed: 9 });
    const sum = p.floors[0].rooms.reduce((s, r) => s + r.area, 0);
    expect(Math.abs(sum - 140)).toBeLessThan(6);
    for (const r of p.floors[0].rooms) expect(r.area).toBeGreaterThan(1);
  });

  it('places doors on shared walls and windows on exterior walls', () => {
    const p = generatePlan({ ...brief, seed: 5 });
    const f = p.floors[0];
    const walls = new Map(f.walls.map((w) => [w.id, w]));
    for (const o of f.openings) {
      const w = walls.get(o.wallId)!;
      expect(w).toBeTruthy();
      if (o.type === 'window') expect(w.exterior).toBe(true);
    }
    expect(f.openings.filter((o) => o.type === 'door').length).toBeGreaterThanOrEqual(f.rooms.length - 1);
  });

  it('every room except the hallway has a door', () => {
    const p = generatePlan({ ...brief, seed: 11 });
    const f = p.floors[0];
    expect(f.openings.some((o) => o.type === 'door' && walls(f).get(o.wallId)?.exterior)).toBe(true); // entry
  });

  it('creates distinct variants', () => {
    const v = generateVariants(brief, 4);
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(new Set(v.map(planSignature)).size).toBe(v.length);
  });

  it('handles multi-storey briefs with aligned stairs', () => {
    const p = generatePlan({ area: 200, floors: 2, bedrooms: 4, bathrooms: 3, extras: ['laundry'], seed: 2 });
    expect(p.floors.length).toBe(2);
    const s0 = p.floors[0].rooms.find((r) => r.type === 'stairs')!;
    const s1 = p.floors[1].rooms.find((r) => r.type === 'stairs')!;
    expect(s0.polygon).toEqual(s1.polygon);
  });

  it('seeded templates are stable', () => {
    for (const t of TEMPLATES) expect(planSignature(templatePlan(t.id))).toEqual(planSignature(templatePlan(t.id)));
  });
});

function walls(f: { walls: { id: string; exterior: boolean }[] }) {
  return new Map(f.walls.map((w) => [w.id, w]));
}
