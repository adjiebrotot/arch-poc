import { describe, it, expect } from 'vitest';
import { checkFeasibility, layoutOptions, extraOptions, nearestFeasible, requiredArea, envelopeOf } from '../src/features/design/generator/feasibility';

describe('feasibility rules', () => {
  it('90 m² on one floor allows 2 bed 1 bath but not 3 bed', () => {
    expect(checkFeasibility({ area: 90, floors: 1, bedrooms: 2, bathrooms: 1, extras: [] }).ok).toBe(true);
    const r = checkFeasibility({ area: 90, floors: 1, bedrooms: 3, bathrooms: 1, extras: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Needs ~\d+ m²\+/);
  });

  it('layout options are disabled (not hidden) with a reason', () => {
    const opts = layoutOptions(90, 1, []);
    expect(opts.length).toBeGreaterThan(4);
    const three = opts.find((o) => o.bedrooms === 3)!;
    expect(three.enabled).toBe(false);
    expect(three.reason).toBeTruthy();
    expect(opts.find((o) => o.id === '2b1b')!.enabled).toBe(true);
  });

  it('extras push the requirement up', () => {
    expect(requiredArea({ floors: 1, bedrooms: 2, bathrooms: 1, extras: ['garage'] })).toBeGreaterThan(
      requiredArea({ floors: 1, bedrooms: 2, bathrooms: 1, extras: [] }),
    );
    const ex = extraOptions(90, 1, 2, 1, []);
    expect(ex.find((e) => e.id === 'garage')!.enabled).toBe(false);
  });

  it('the minimums are the design rules\' minimums, with slack that grows with the brief', () => {
    expect(requiredArea({ floors: 1, bedrooms: 1, bathrooms: 1, extras: [] })).toBeGreaterThan(55);
    expect(requiredArea({ floors: 1, bedrooms: 1, bathrooms: 1, extras: [] })).toBeLessThan(75);
    const small = requiredArea({ floors: 1, bedrooms: 2, bathrooms: 1, extras: [] }), big = requiredArea({ floors: 1, bedrooms: 5, bathrooms: 3, extras: ['garage'] });
    expect(big / small).toBeGreaterThan(2);
  });

  it('stairs allowance is added per extra floor and tiny floor plates are rejected', () => {
    const one = requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: [] });
    const two = requiredArea({ floors: 2, bedrooms: 3, bathrooms: 2, extras: [] });
    expect(two - one).toBe(7);
    expect(checkFeasibility({ area: 70, floors: 3, bedrooms: 1, bathrooms: 1, extras: [] }).ok).toBe(false);
  });

  it('suggests the nearest feasible option', () => {
    const n = nearestFeasible({ area: 90, floors: 1, bedrooms: 3, bathrooms: 1, extras: [] });
    expect(n.suggestion).toEqual({ area: 90, floors: 1, bedrooms: 2, bathrooms: 1, extras: [] });
    expect(n.areaNeeded).toBeGreaterThan(90);
    expect(n.message).toMatch(/2 bed 1 bath/);
  });
});

describe('nearest feasible keeps as much as possible', () => {
  it('prefers dropping an extra over dropping bedrooms', () => {
    const n = nearestFeasible({ area: 120, floors: 1, bedrooms: 3, bathrooms: 2, extras: ['study'] });
    expect(n.suggestion).toMatchObject({ bedrooms: 3, bathrooms: 2, extras: [] });
    expect(n.suggestion && checkFeasibility(n.suggestion).ok).toBe(true);
  });
});

describe('feasibility against the drawn envelope', () => {
  it('uses the footprints as the area and number of floors', () => {
    const env = envelopeOf({ floors: [
      { level: 0, height: 2.7, walls: [], rooms: [], openings: [], footprint: [[0, 0], [14, 0], [14, 10], [0, 10]] },
      { level: 1, height: 2.7, walls: [], rooms: [], openings: [], footprint: [[0, 0], [14, 0], [14, 7], [0, 7]] },
    ] });
    expect(env).toEqual({ area: 238, floors: 2, plates: [140, 98] });
    expect(checkFeasibility({ ...env, bedrooms: 3, bathrooms: 2, extras: [] }).ok).toBe(true);
  });

  it('checks each floor: the bedrooms that go up must fit on the upper floor', () => {
    // plenty of area in total, but a 4-bed upper floor of 84 m² can't hold them
    const r = checkFeasibility({ area: 204, floors: 2, plates: [120, 84], bedrooms: 4, bathrooms: 2, extras: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Level 2 needs ~\d+ m²\+/);
  });

  it('rejects a tiny upper floor, whatever the total', () => {
    const r = checkFeasibility({ area: 160, floors: 2, plates: [148, 12], bedrooms: 2, bathrooms: 1, extras: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Level 2 is under/);
  });

  it('never suggests changing the number of floors', () => {
    const n = nearestFeasible({ area: 150, floors: 2, plates: [80, 70], bedrooms: 4, bathrooms: 2, extras: ['study'] });
    expect(n.suggestion?.floors).toBe(2);
    expect(n.message).toMatch(/footprints would need about/);
  });

  it('preferences cost no area; main bedroom downstairs is only offered with upper floors', () => {
    expect(requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: ['living-back'] })).toBe(requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: [] }));
    expect(extraOptions(150, 1, 3, 2, []).some((e) => e.id === 'master-ground')).toBe(false);
    expect(extraOptions(150, 2, 3, 2, []).some((e) => e.id === 'master-ground')).toBe(true);
  });
});
