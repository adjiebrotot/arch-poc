import { describe, it, expect } from 'vitest';
import { generatePlan, generateVariants, planSignature, applyLayout, envelopeOfPlan, type Envelope } from '../src/features/design/generator/generator';
import { PlanSpecSchema, type Floor, type PlanSpec } from '../src/shared/planspec/schema';
import { TEMPLATES, templatePlan, fitTemplate, demoEnvelope } from '../src/features/design/generator/templates';
import { envelopeOf } from '../src/features/design/generator/feasibility';
import { checkPlan } from '../src/features/design/generator/rules';
import { normalizeSite, rectBoundary } from '../src/shared/planspec/site';
import { wallLine } from '../src/shared/planspec/envelope';
import { segmentInPolygon, polygonArea, polygonInPolygon, projectOnSegment, type Vec2 } from '../src/shared/util/geometry';

type Fp = Vec2[];
const lot = (w: number, d: number, edge = 2) => normalizeSite({ width: w, depth: d, northAngle: 0, boundary: rectBoundary(0, 0, w, d), roads: [{ edge }], entrance: { edge, t: 0.5 } });
const envelope = (site: ReturnType<typeof lot>, ...fps: Fp[]): Envelope => ({ site, floors: fps.map((footprint, level) => ({ level, height: 2.7, footprint })) });

const SHAPES: { name: string; env: Envelope; brief: { bedrooms: number; bathrooms: number; extras: string[] } }[] = [
  { name: 'rectangle', env: envelope(lot(22, 30), [[4, 8], [18, 8], [18, 18], [4, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] } },
  { name: 'L', env: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 20], [12, 20], [12, 26], [3, 26]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'study', 'laundry'] } },
  { name: 'U', env: envelope(lot(30, 30), [[3, 5], [27, 5], [27, 21], [19, 21], [19, 13], [11, 13], [11, 21], [3, 21]]), brief: { bedrooms: 4, bathrooms: 2, extras: ['laundry', 'dining'] } },
  { name: 'T', env: envelope(lot(30, 30), [[3, 4], [27, 4], [27, 12], [19, 12], [19, 24], [11, 24], [11, 12], [3, 12]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['laundry'] } },
  { name: 'chamfered (diagonal side)', env: envelope(lot(24, 30), [[3, 8], [15, 8], [21, 14], [21, 22], [3, 22]]), brief: { bedrooms: 3, bathrooms: 1, extras: ['open-plan', 'laundry'] } },
  { name: 'trapezoid', env: envelope(lot(26, 30), [[5, 6], [19, 6], [23, 20], [3, 20]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage'] } },
  { name: 'narrow and deep', env: envelope(lot(10, 36), [[1, 6], [8, 6], [8, 26], [1, 26]]), brief: { bedrooms: 2, bathrooms: 1, extras: ['laundry'] } },
  { name: 'turned 30°', env: envelope(lot(30, 30), [[6, 10], [18.12, 3], [24.12, 13.39], [12, 20.39]]), brief: { bedrooms: 2, bathrooms: 1, extras: [] } },
  { name: 'two storeys, smaller upper floor', env: envelope(lot(18, 30), [[3, 8], [15, 8], [15, 22], [3, 22]], [[3, 8], [15, 8], [15, 18], [3, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] } },
  { name: 'L ground floor, rectangular upper floor', env: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 20], [12, 20], [12, 26], [3, 26]], [[3, 6], [15, 6], [15, 18], [3, 18]]), brief: { bedrooms: 4, bathrooms: 3, extras: ['laundry', 'study'] } },
  { name: 'three storeys', env: envelope(lot(14, 30), [[2, 6], [12, 6], [12, 20], [2, 20]], [[2, 6], [12, 6], [12, 18], [2, 18]], [[2, 8], [10, 8], [10, 16], [2, 16]]), brief: { bedrooms: 4, bathrooms: 3, extras: ['laundry'] } },
];

const roomsOf = (p: PlanSpec, ...types: string[]) => p.floors.flatMap((f) => f.rooms).filter((r) => types.includes(r.type));

/** Every room (but the hallways) has a door or an opening somewhere on its outline. */
function hasDoor(f: Floor, poly: Vec2[]): boolean {
  const walls = new Map(f.walls.map((w) => [w.id, w]));
  return f.openings.some((o) => {
    if (o.type !== 'door') return false;
    const w = walls.get(o.wallId)!;
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const c: Vec2 = [w.a[0] + ((w.b[0] - w.a[0]) * o.offset) / len, w.a[1] + ((w.b[1] - w.a[1]) * o.offset) / len];
    return poly.some((p, i) => projectOnSegment(c, p, poly[(i + 1) % poly.length]).d < 0.02);
  });
}

describe('generator: rooms inside the client\'s own footprints', () => {
  for (const s of SHAPES) {
    describe(s.name, () => {
      const p = generatePlan({ envelope: s.env, ...s.brief, seed: 3 });

      it('is a valid PlanSpec that keeps the footprints exactly as drawn', () => {
        expect(() => PlanSpecSchema.parse(p)).not.toThrow();
        expect(p.floors).toHaveLength(s.env.floors.length);
        p.floors.forEach((f, i) => expect(f.footprint).toEqual(s.env.floors[i].footprint));
        expect(p.site!.boundary).toEqual(s.env.site!.boundary);
      });

      it('puts every wall inside its floor\'s footprint', () => {
        p.floors.forEach((f, i) => {
          const line = wallLine(s.env.floors[i].footprint);
          for (const w of f.walls) expect(segmentInPolygon(w.a, w.b, line, 0.01), `${w.id} ${w.a} → ${w.b}`).toBe(true);
          for (const r of f.rooms) expect(polygonInPolygon(r.polygon, line, 0.01)).toBe(true);
        });
      });

      it('fills each floor: room areas add up to the area inside its outside walls', () => {
        p.floors.forEach((f, i) => {
          const inner = polygonArea(wallLine(s.env.floors[i].footprint));
          const sum = f.rooms.reduce((t, r) => t + r.area, 0);
          expect(Math.abs(sum - inner) / inner).toBeLessThan(0.03);
          for (const r of f.rooms) expect(r.area).toBeGreaterThan(0.5);
        });
      });

      it('has the requested bedrooms and bathrooms, and a door into every room', () => {
        expect(roomsOf(p, 'bedroom', 'master')).toHaveLength(s.brief.bedrooms);
        expect(roomsOf(p, 'bathroom', 'ensuite').length).toBeGreaterThanOrEqual(s.brief.bathrooms);
        for (const f of p.floors) for (const r of f.rooms) if (r.type !== 'hallway') expect(hasDoor(f, r.polygon), `${r.name} has a door`).toBe(true);
      });

      it('has a front door in an outside wall of the ground floor', () => {
        const f = p.floors[0];
        expect(f.openings.some((o) => o.type === 'door' && f.walls.find((w) => w.id === o.wallId)?.exterior)).toBe(true);
      });

      if (s.env.floors.length > 1) {
        it('stacks the stairs in the same place on every floor, inside the top floor', () => {
          const stairs = p.floors.map((f) => f.rooms.find((r) => r.type === 'stairs')!);
          stairs.forEach((st) => expect(st).toBeTruthy());
          const area = polygonArea(stairs[0].polygon);
          for (const st of stairs) expect(polygonArea(st.polygon)).toBeCloseTo(area, 1);
          const top = s.env.floors[s.env.floors.length - 1].footprint;
          expect(polygonInPolygon(stairs[0].polygon, wallLine(top), 0.01)).toBe(true);
        });
      }
    });
  }

  it('is deterministic: same envelope + brief + seed ⇒ same plan', () => {
    const s = SHAPES[1];
    expect(JSON.stringify(generatePlan({ envelope: s.env, ...s.brief, seed: 42 }))).toEqual(JSON.stringify(generatePlan({ envelope: s.env, ...s.brief, seed: 42 })));
  });

  it('offers distinct variants', () => {
    const s = SHAPES[0];
    const v = generateVariants({ envelope: s.env, ...s.brief }, 3, 1, 12);
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(new Set(v.map(planSignature)).size).toBe(v.length);
  });

  it('turns the street side public: the garage door and front door face the road', () => {
    const p = generatePlan({ envelope: SHAPES[0].env, ...SHAPES[0].brief, seed: 5 });
    const f = p.floors[0];
    const garage = f.rooms.find((r) => r.type === 'garage')!;
    // the street is along the bottom of the lot (largest y): the garage reaches the front wall
    expect(Math.max(...garage.polygon.map((q) => q[1]))).toBeCloseTo(17.875, 2);
  });

  it('refuses an envelope where stairs can\'t reach the top floor, with a friendly message', () => {
    const env = envelope(lot(20, 30), [[2, 6], [14, 6], [14, 18], [2, 18]], [[2, 6], [5, 6], [5, 9], [2, 9]]);
    expect(() => generatePlan({ envelope: env, bedrooms: 2, bathrooms: 1, extras: [], seed: 1 })).toThrow(/stairs/);
  });

  it('applying a layout keeps the client\'s plan, floors and heights', () => {
    const base: PlanSpec = { version: '1.0', meta: { title: 'Mine', createdBy: 'client', mode: 'chat', createdAt: '', stage: 'layout' }, site: SHAPES[8].env.site, floors: SHAPES[8].env.floors.map((f) => ({ ...f, height: 3, walls: [], rooms: [], openings: [] })) };
    const v = generatePlan({ envelope: envelopeOfPlan(base), bedrooms: 3, bathrooms: 2, extras: [], seed: 2 });
    const out = applyLayout(base, v);
    expect(out.meta).toMatchObject({ title: 'Mine', mode: 'chat', stage: 'design' });
    expect(out.floors.map((f) => f.height)).toEqual([3, 3]);
    expect(out.floors[1].footprint).toEqual(base.floors[1].footprint);
  });
});

describe('templates are programmes fitted to the envelope', () => {
  it('adapts a template that is too big for the floors instead of changing the floors', () => {
    const small = { area: 70, floors: 1, plates: [70] };
    const ent = TEMPLATES.find((t) => t.id === 'entertainer')!;
    const fit = fitTemplate(ent, small);
    expect(fit.ok).toBe(true);
    expect(fit.adapted).toBe(true);
    expect(fit.brief.bedrooms).toBeLessThan(ent.bedrooms);
    expect(fitTemplate(TEMPLATES[0], { area: 160, floors: 1, plates: [160] }).adapted).toBe(false);
  });

  it('seeded demo plans are stable', () => {
    for (const t of TEMPLATES) expect(planSignature(templatePlan(t.id))).toEqual(planSignature(templatePlan(t.id)));
    expect(envelopeOf({ floors: demoEnvelope('townhouse').floors.map((f) => ({ ...f, walls: [], rooms: [], openings: [] })) }).floors).toBe(2);
  }, 120_000);

  it('every demo plan meets every design rule', () => {
    for (const t of TEMPLATES) expect(checkPlan(templatePlan(t.id)).hard).toBe(0);
  }, 120_000);
});
