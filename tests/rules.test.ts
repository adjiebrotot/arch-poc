import { describe, it, expect } from 'vitest';
import { generatePlan, generateLayouts, suggestBriefs, type Envelope } from '../src/features/design/generator/generator';
import { checkPlan, kindOf, containsRect, RULES, ROOM_RULES, HALL_MAX, type Report } from '../src/features/design/generator/rules';
import { checkFeasibility } from '../src/features/design/generator/feasibility';
import { footprintArea } from '../src/shared/planspec/envelope';
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
    expect(RULES.filter((r) => r.severity === 'hard').length).toBeGreaterThanOrEqual(18);
  });

  // a generated plan that meets every rule, then broken one way at a time
  const base = generateLayouts({ envelope: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 21], [3, 21]]), bedrooms: 4, bathrooms: 2, extras: ['garage', 'laundry', 'study'] }, 1, 1, 12).plans[0];

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

  it('a grossly oversized room, a room with too many corners or a hallway blob breaks the rules', () => {
    const p = clone(base);
    const bed = rooms(p).find((r) => r.type === 'bedroom')!;
    bed.area = ROOM_RULES.bedroom!.max * 1.6;
    expect(failed(checkPlan(p), 'way-oversized').issues.some((i) => i.roomId === bed.id)).toBe(true);
    // a comb: 12 corners
    const q = clone(base);
    const st = rooms(q).find((r) => r.type === 'study')!;
    const [x0, y0] = [Math.min(...st.polygon.map((v) => v[0])), Math.min(...st.polygon.map((v) => v[1]))];
    st.polygon = [[x0, y0], [x0 + 4, y0], [x0 + 4, y0 + 3], [x0 + 3, y0 + 3], [x0 + 3, y0 + 1], [x0 + 2.5, y0 + 1], [x0 + 2.5, y0 + 3], [x0 + 1.5, y0 + 3], [x0 + 1.5, y0 + 1], [x0 + 1, y0 + 1], [x0 + 1, y0 + 3], [x0, y0 + 3]];
    expect(failed(checkPlan(q), 'room-corners').issues.some((i) => i.roomId === st.id)).toBe(true);
    // a hallway with a room-sized blob in it
    const h = clone(base);
    const hall = rooms(h).find((r) => r.type === 'hallway')!;
    const [hx, hy] = [Math.min(...hall.polygon.map((v) => v[0])), Math.min(...hall.polygon.map((v) => v[1]))];
    hall.polygon = rect(hx, hy, hx + HALL_MAX + 1, hy + HALL_MAX + 1);
    expect(failed(checkPlan(h), 'hall-corridor').ok).toBe(false);
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
  // the first layout offered meets every rule on these (generateLayouts never offers one that doesn't)
  const CASES: { name: string; env: Envelope; brief: { bedrooms: number; bathrooms: number; extras: string[] } }[] = [
    { name: 'L', env: envelope(lot(24, 34), [[3, 6], [21, 6], [21, 20], [12, 20], [12, 26], [3, 26]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'study', 'laundry'] } },
    { name: 'U', env: envelope(lot(30, 30), [[3, 5], [27, 5], [27, 21], [19, 21], [19, 13], [11, 13], [11, 21], [3, 21]]), brief: { bedrooms: 4, bathrooms: 2, extras: ['laundry', 'dining'] } },
    { name: 'T', env: envelope(lot(30, 30), [[3, 4], [27, 4], [27, 12], [19, 12], [19, 24], [11, 24], [11, 12], [3, 12]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['laundry'] } },
    { name: 'chamfered', env: envelope(lot(24, 30), [[3, 8], [15, 8], [21, 14], [21, 22], [3, 22]]), brief: { bedrooms: 3, bathrooms: 1, extras: ['open-plan', 'laundry'] } },
    { name: 'trapezoid', env: envelope(lot(26, 30), [[5, 6], [19, 6], [23, 20], [3, 20]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage'] } },
    { name: 'narrow', env: envelope(lot(10, 36), [[1, 6], [8, 6], [8, 26], [1, 26]]), brief: { bedrooms: 2, bathrooms: 1, extras: ['laundry'] } },
    { name: 'turned 30°', env: envelope(lot(30, 30), [[6, 10], [18.12, 3], [24.12, 13.39], [12, 20.39]]), brief: { bedrooms: 2, bathrooms: 1, extras: [] } },
    { name: 'two storeys', env: envelope(lot(18, 30), [[3, 8], [15, 8], [15, 22], [3, 22]], [[3, 8], [15, 8], [15, 18], [3, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] } },
    { name: 'narrow townhouse (open plan)', env: envelope(lot(10, 34), [[1, 6], [9, 6], [9, 22], [1, 22]], [[1, 6], [9, 6], [9, 18], [1, 18]]), brief: { bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry', 'powder'] } },
  ];
  for (const c of CASES) {
    it(`${c.name}: compliant layouts are offered, and every one breaks no design rule`, () => {
      const r = generateLayouts({ envelope: c.env, ...c.brief }, 2, 1, 16);
      expect(r.plans.length, JSON.stringify(r.closest?.report.results.filter((x) => !x.ok && x.severity === 'hard').map((x) => x.issues[0].message))).toBeGreaterThan(0);
      for (const p of r.plans) expect(checkPlan(p).hard).toBe(0);
    }, 60_000);
  }

  it('never offers a layout that breaks a hard rule, whatever the envelope and brief', () => {
    // footprints a client might draw, with briefs the feasibility check allows
    const envs: Envelope[] = [
      envelope(lot(20, 30), [[2, 6], [16, 6], [16, 17], [2, 17]]),
      envelope(lot(26, 30), [[2, 5], [22, 5], [22, 13], [16, 13], [16, 21], [8, 21], [8, 13], [2, 13]]),
      envelope(lot(20, 30), [[2, 6], [15, 6], [18, 9], [18, 19], [2, 19]]),
      envelope(lot(18, 32), [[2, 6], [14, 6], [14, 18], [2, 18]], [[2, 6], [14, 6], [14, 14], [2, 14]]),
    ];
    const briefs = [{ bedrooms: 2, bathrooms: 1, extras: [] }, { bedrooms: 3, bathrooms: 2, extras: ['laundry'] }, { bedrooms: 4, bathrooms: 2, extras: ['study'] }];
    let offered = 0;
    for (const env of envs) for (const b of briefs) {
      const plates = env.floors.map((f) => Math.round(footprintArea(f.footprint)));
      if (!checkFeasibility({ area: plates.reduce((x, y) => x + y, 0), floors: plates.length, plates, ...b }).ok) continue;
      const r = generateLayouts({ envelope: env, ...b }, 4, 1, 12);
      offered += r.plans.length;
      for (const p of r.plans) expect(checkPlan(p).hard).toBe(0);
      if (!r.plans.length) expect(r.closest!.report.hard).toBeGreaterThan(0);
    }
    expect(offered).toBeGreaterThan(10);
  }, 120_000);

  it('every generated garage is a rectangle a car fits in, with its door on the street', () => {
    for (const seed of [1, 2, 3]) {
      const p = generatePlan({ envelope: CASES[0].env, ...CASES[0].brief, seed });
      const rep = checkPlan(p);
      expect(failed(rep, 'garage-rect').ok).toBe(true);
      expect(failed(rep, 'garage-street').ok).toBe(true);
    }
  });

  it('a narrow townhouse gets living spaces with real proportions, open-plan when they can\'t be separate', () => {
    const c = CASES[CASES.length - 1];
    const [p] = generateLayouts({ envelope: c.env, ...c.brief }, 1, 1, 16).plans;
    const living = p.floors[0].rooms.filter((r) => ['living', 'livingKitchen', 'kitchen', 'dining'].includes(kindOf(r)));
    expect(living.length).toBeGreaterThan(0);
    for (const r of living) expect(Math.min(...[0, 1].map((ax) => Math.max(...r.polygon.map((v) => v[ax])) - Math.min(...r.polygon.map((v) => v[ax]))))).toBeGreaterThanOrEqual(2.4);
    expect(failed(checkPlan(p), 'clear-rect').ok).toBe(true);
  });

  it('when floors are too tight for the brief, offers nothing unsound and suggests briefs that fit', () => {
    const tight = envelope(lot(22, 30), [[4, 8], [18, 8], [18, 18], [4, 18]]);
    const input = { envelope: tight, bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry'] };
    // 140 m² with a garage, 3 bedrooms and 2 bathrooms: the feasibility check already says so…
    expect(checkFeasibility({ area: 140, floors: 1, plates: [140], ...input }).ok).toBe(false);
    // …and no layout is offered: the closest attempt says what had to give
    const r = generateLayouts(input, 4, 1, 16);
    expect(r.plans).toEqual([]);
    expect(r.closest!.report.hard).toBeGreaterThan(0);
    // the closest briefs that do fit, each one checked by generating it
    const sg = suggestBriefs(input, 2);
    expect(sg.length).toBeGreaterThan(0);
    for (const x of sg) {
      expect(x.change.length).toBeGreaterThan(3);
      expect(generateLayouts({ ...input, ...x.brief }, 1, 1, 12).plans.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
