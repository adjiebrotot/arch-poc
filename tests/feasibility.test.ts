import { describe, it, expect } from 'vitest';
import { checkFeasibility, layoutOptions, extraOptions, nearestFeasible, requiredArea, envelopeOf } from '../src/features/design/generator/feasibility';

describe('feasibility rules', () => {
  it('60 m² on one floor allows 2 bed 1 bath but not 3 bed', () => {
    expect(checkFeasibility({ area: 60, floors: 1, bedrooms: 2, bathrooms: 1, extras: [] }).ok).toBe(true);
    const r = checkFeasibility({ area: 60, floors: 1, bedrooms: 3, bathrooms: 1, extras: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Needs ~\d+ m²\+/);
  });

  it('layout options are disabled (not hidden) with a reason', () => {
    const opts = layoutOptions(60, 1, []);
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
    const ex = extraOptions(60, 1, 2, 1, []);
    expect(ex.find((e) => e.id === 'garage')!.enabled).toBe(false);
  });

  it('stairs allowance is added per extra floor and tiny floor plates are rejected', () => {
    const one = requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: [] });
    const two = requiredArea({ floors: 2, bedrooms: 3, bathrooms: 2, extras: [] });
    expect(two - one).toBe(7);
    expect(checkFeasibility({ area: 70, floors: 3, bedrooms: 1, bathrooms: 1, extras: [] }).ok).toBe(false);
  });

  it('suggests the nearest feasible option', () => {
    const n = nearestFeasible({ area: 60, floors: 1, bedrooms: 3, bathrooms: 1, extras: [] });
    expect(n.suggestion).toEqual({ area: 60, floors: 1, bedrooms: 2, bathrooms: 1, extras: [] });
    expect(n.areaNeeded).toBeGreaterThan(60);
    expect(n.message).toMatch(/2 bed 1 bath/);
  });
});

describe('nearest feasible keeps as much as possible', () => {
  it('prefers dropping an extra over dropping bedrooms', () => {
    const n = nearestFeasible({ area: 60, floors: 1, bedrooms: 3, bathrooms: 2, extras: ['study'] });
    expect(n.suggestion?.bedrooms).toBe(2);
    expect(n.suggestion && checkFeasibility(n.suggestion).ok).toBe(true);
  });
});

describe('feasibility against the drawn envelope', () => {
  it('uses the footprints as the area and number of floors', () => {
    const env = envelopeOf({ floors: [
      { level: 0, height: 2.7, walls: [], rooms: [], openings: [], footprint: [[0, 0], [12, 0], [12, 10], [0, 10]] },
      { level: 1, height: 2.7, walls: [], rooms: [], openings: [], footprint: [[0, 0], [12, 0], [12, 7], [0, 7]] },
    ] });
    expect(env).toEqual({ area: 204, floors: 2, plates: [120, 84] });
    expect(checkFeasibility({ ...env, bedrooms: 4, bathrooms: 2, extras: [] }).ok).toBe(true);
  });

  it('rejects a tiny upper floor, whatever the total', () => {
    const r = checkFeasibility({ area: 160, floors: 2, plates: [148, 12], bedrooms: 2, bathrooms: 1, extras: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Level 2 is under/);
  });

  it('never suggests changing the number of floors', () => {
    const n = nearestFeasible({ area: 90, floors: 2, plates: [50, 40], bedrooms: 4, bathrooms: 2, extras: ['study'] });
    expect(n.suggestion?.floors).toBe(2);
    expect(n.message).toMatch(/footprints would need about/);
  });

  it('preferences cost no area; main bedroom downstairs is only offered with upper floors', () => {
    expect(requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: ['living-back'] })).toBe(requiredArea({ floors: 1, bedrooms: 3, bathrooms: 2, extras: [] }));
    expect(extraOptions(150, 1, 3, 2, []).some((e) => e.id === 'master-ground')).toBe(false);
    expect(extraOptions(150, 2, 3, 2, []).some((e) => e.id === 'master-ground')).toBe(true);
  });
});
