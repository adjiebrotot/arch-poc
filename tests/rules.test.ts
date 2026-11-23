import { describe, it, expect } from 'vitest';
import { generatePlan, generateVariants, type Envelope } from '../src/features/design/generator/generator';
import { checkPlan, kindOf, containsRect, RULES, ROOM_RULES, type Report } from '../src/features/design/generator/rules';
import { normalizeSite, rectBoundary } from '../src/shared/planspec/site';
import type { PlanSpec, Room } from '../src/shared/planspec/schema';
import type { Vec2 } from '../src/shared/util/geometry';

const lot = (w: number, d: number, edge = 2) => normalizeSite({ width: w, depth: d, northAngle: 0, boundary: rectBoundary(0, 0, w, d), roads: [{ edge }], entrance: { edge, t: 0.5 } });
const envelope = (site: ReturnType<typeof lot>, ...fps: Vec2[][]): Envelope => ({ site, floors: fps.map((footprint, level) => ({ level, height: 2.7, footprint })) });
const failed = (r: Report, id: string) => r.results.find((x) => x.id === id)!;
const clone = (p: PlanSpec): PlanSpec => JSON.parse(JSON.stringify(p));
const rooms = (p: PlanSpec) => p.floors.flatMap((f) => f.rooms);
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('design rules: the checker', () => {
  it('names room kinds from their type and name', () => {
    expect(kindOf({ type: 'living', name: 'Living, kitchen & dining' })).toBe('livingKitchen');
    expect(kindOf({ type: 'living', name: 'Family room' })).toBe('family');
    expect(kindOf({ type: 'other', name: 'Walk-in robe' })).toBe('robe');
    expect(kindOf({ type: 'other', name: 'Storage 2' })).toBe('storage');
    expect(kindOf({ type: 'bedroom', name: 'Bedroom 3' })).toBe('bedroom');
  });

  it('finds a clear rectangle either way round, and not in an L that is too thin', () => {
    expect(containsRect(rect(0, 0, 3, 4), 3, 3.4)).toBe(true);
    expect(containsRect(rect(0, 0, 4, 3), 3, 3.4)).toBe(true);
    expect(containsRect([[0, 0], [5, 0], [5, 1.5], [1.5, 1.5], [1.5, 5], [0, 5]], 2.7, 3)).toBe(false);
  });

  it('every rule says what it checks and why, in four families', () => {
    expect(new Set(RULES.map((r) => r.kind))).toEqual(new Set(['shape', 'size', 'proportion', 'placement']));
    for (const r of RULES) { expect(r.title.length).toBeGreaterThan(10); expect(r.why.length).toBeGreaterThan(20); }
    expect(RULES.filter((r) => r.severity === 'hard').length).toBeGreaterThanOrEqual(14);
  });

  // a generated plan that meets every rule, then broken one way at a time
  const base = generateVariants({ envelope: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 21], [3, 21]]), bedrooms: 4, bathrooms: 2, extras: ['garage', 'laundry', 'study'] }, 1, 1, 12)[0];

  it('passes a good plan', () => {
    const r = checkPlan(base);
    expect(r.hard, JSON.stringify(r.results.filter((x) => !x.ok && x.severity === 'hard'))).toBe(0);
    expect(r.results.length).toBe(RULES.length);
  });

  it('a garage too small for a car breaks the garage rule', () => {
    const p = clone(base);
    const g = rooms(p).find((r) => r.type === 'garage')!;
    const xs = g.polygon.map((q) => q[0]), ys = g.polygon.map((q) => q[1]);
    g.polygon = rect(Math.min(...xs), Math.min(...ys), Math.min(...xs) + 2.8, Math.min(...ys) + 5);
    const r = failed(checkPlan(p), 'garage-rect');
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toMatch(/too small for a car/);
  });

  it('a bathroom bigger than a bedroom breaks the proportion rule', () => {
    const p = clone(base);
    const bath = rooms(p).find((r) => kindOf(r) === 'bathroom')!;
    bath.area = 30;
    expect(failed(checkPlan(p), 'bath-vs-bed').ok).toBe(false);
  });

  it('a bedroom bigger than the main bedroom breaks the proportion rule', () => {
    const p = clone(base);
    const master = rooms(p).find((r) => r.type === 'master')!;
    master.area = 9.5;
    expect(failed(checkPlan(p), 'master-largest').ok).toBe(false);
  });

  it('a room under its minimum size, or an L-shaped bathroom, breaks the size and shape rules', () => {
    const p = clone(base);
    const bed = rooms(p).find((r) => r.type === 'bedroom')!;
    bed.area = ROOM_RULES.bedroom!.min - 1;
    expect(failed(checkPlan(p), 'min-size').issues.some((i) => i.roomId === bed.id)).toBe(true);
    const bath = rooms(p).find((r) => kindOf(r) === 'bathroom') as Room;
    const xs = bath.polygon.map((q) => q[0]), ys = bath.polygon.map((q) => q[1]);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    bath.polygon = [[x0, y0], [x1, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, y1]];
    expect(failed(checkPlan(p), 'rect-rooms').issues.some((i) => i.roomId === bath.id)).toBe(true);
  });

  it('no front door, or no window in a bedroom, breaks the placement rules', () => {
    const p = clone(base);
    const f = p.floors[0];
    const ext = new Set(f.walls.filter((w) => w.id.includes('-e')).map((w) => w.id));
    f.openings = f.openings.filter((o) => !(o.type === 'door' && ext.has(o.wallId) && o.width < 2));
    expect(failed(checkPlan(p), 'front-door').ok).toBe(false);
    const q = clone(base);
    const bedWalls = new Set(q.floors[0].walls.filter((w) => w.id.includes('-e')).map((w) => w.id));
    q.floors[0].openings = q.floors[0].openings.filter((o) => o.type !== 'window' || !bedWalls.has(o.wallId));
    expect(failed(checkPlan(q), 'daylight').ok).toBe(false);
  });
});

describe('design rules: the generator follows them', () => {
  const CASES: { name: string; env: Envelope; brief: { bedrooms: number; bathrooms: number; extras: string[] } }[] = [
    { name: 'L', env: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 20], [12, 20], [12, 26], [3, 26]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'study', 'laundry'] } },
    { name: 'U', env: envelope(lot(30, 30), [[3, 5], [27, 5], [27, 21], [19, 21], [19, 13], [11, 13], [11, 21], [3, 21]]), brief: { bedrooms: 4, bathrooms: 2, extras: ['laundry', 'dining'] } },
    { name: 'T', env: envelope(lot(30, 30), [[3, 4], [27, 4], [27, 12], [19, 12], [19, 24], [11, 24], [11, 12], [3, 12]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['laundry'] } },
    { name: 'chamfered', env: envelope(lot(24, 30), [[3, 8], [15, 8], [21, 14], [21, 22], [3, 22]]), brief: { bedrooms: 3, bathrooms: 1, extras: ['open-plan', 'laundry'] } },
    { name: 'trapezoid', env: envelope(lot(26, 30), [[5, 6], [19, 6], [23, 20], [3, 20]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage'] } },
    { name: 'narrow', env: envelope(lot(10, 36), [[1, 6], [8, 6], [8, 26], [1, 26]]), brief: { bedrooms: 2, bathrooms: 1, extras: ['laundry'] } },
    { name: 'turned 30°', env: envelope(lot(30, 30), [[6, 10], [18.12, 3], [24.12, 13.39], [12, 20.39]]), brief: { bedrooms: 2, bathrooms: 1, extras: [] } },
    { name: 'two storeys', env: envelope(lot(18, 30), [[3, 8], [15, 8], [15, 22], [3, 22]], [[3, 8], [15, 8], [15, 18], [3, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] } },
    { name: 'three storeys', env: envelope(lot(14, 30), [[2, 6], [12, 6], [12, 20], [2, 20]], [[2, 6], [12, 6], [12, 18], [2, 18]], [[2, 8], [10, 8], [10, 16], [2, 16]]), brief: { bedrooms: 4, bathrooms: 3, extras: ['laundry'] } },
    { name: 'narrow townhouse (open plan)', env: envelope(lot(10, 34), [[1, 6], [9, 6], [9, 22], [1, 22]], [[1, 6], [9, 6], [9, 18], [1, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry', 'powder'] } },
  ];
  for (const c of CASES) {
    it(`${c.name}: the first layout offered breaks no design rule`, () => {
      const [best] = generateVariants({ envelope: c.env, ...c.brief }, 1, 1, 16);
      const r = checkPlan(best);
      expect(r.hard, r.results.filter((x) => !x.ok && x.severity === 'hard').flatMap((x) => x.issues.map((i) => `${x.id}: ${i.message}`)).join('\n')).toBe(0);
    });
  }

  it('every generated garage is a rectangle a car fits in, with its door on the street', () => {
    for (const seed of [1, 2, 3]) {
      const p = generatePlan({ envelope: CASES[0].env, ...CASES[0].brief, seed });
      const rep = checkPlan(p);
      expect(failed(rep, 'garage-rect').ok).toBe(true);
      expect(failed(rep, 'garage-street').ok).toBe(true);
    }
  });

  it('a narrow ground floor gets one open-plan living space instead of three slivers', () => {
    const c = CASES[CASES.length - 1];
    const p = generatePlan({ envelope: c.env, ...c.brief, seed: 1 });
    expect(p.floors[0].rooms.some((r) => kindOf(r) === 'livingKitchen')).toBe(true);
  });

  it('says honestly when floors are too tight for the brief', () => {
    const tight = envelope(lot(22, 30), [[4, 8], [18, 8], [18, 18], [4, 18]]);
    const [best] = generateVariants({ envelope: tight, bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] }, 1, 1, 16);
    const r = checkPlan(best);
    // 140 m² with a garage, 3 bedrooms and 2 bathrooms: something has to give, and the report says what
    expect(r.hard).toBeGreaterThan(0);
    expect(r.results.filter((x) => !x.ok && x.severity === 'hard').every((x) => x.issues.every((i) => i.message.length > 5))).toBe(true);
  });
});
