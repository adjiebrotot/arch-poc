import { describe, it, expect } from 'vitest';
import { checkFeasibility, layoutOptions, extraOptions, nearestFeasible, requiredArea } from '../src/features/design/generator/feasibility';

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
    expect(two - one).toBe(6);
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
