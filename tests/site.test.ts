import { describe, it, expect } from 'vitest';
import * as site from '../src/shared/planspec/site';
import { PlanSpecSchema, emptyPlan, type Site } from '../src/shared/planspec/schema';
import { generatePlan } from '../src/features/design/generator/generator';
import { planToModel } from '../src/features/design/engine/plan3d';
import { floorToSvg } from '../src/features/design/engine/planSvg';

const rect = (): Site => site.normalizeSite({ width: 20, depth: 30, northAngle: 0, boundary: site.rectBoundary(0, 0, 20, 30), roads: [{ edge: 2 }] });

describe('lot polygon, roads and compass', () => {
  it('upgrades a legacy width × depth lot to an outline with one road and an entrance', () => {
    const s = site.normalizeSite({ width: 20, depth: 30, northAngle: 0 });
    expect(s.boundary).toEqual([[-4, -6], [16, -6], [16, 24], [-4, 24]]);
    expect(s.roads).toEqual([{ edge: 2 }]);
    expect(s.entrance).toEqual({ edge: 2, t: 0.5 });
    expect(site.edgeFacing(s, 2)).toBe('South');
  });

  it('outward normals point out of the lot whichever way the outline runs', () => {
    const cw = site.rectBoundary(0, 0, 10, 10);
    const ccw = [...cw].reverse();
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]));
    close(site.outwardNormal(cw, 0), [0, -1]); // top side → out is up
    close(site.outwardNormal(ccw, 0), [0, 1]); // reversed: edge 0 is the bottom side → out is down
  });

  it('applies the one-road, corner and front-and-back presets', () => {
    const s = rect();
    expect(site.detectPreset(s).preset).toBe('single');
    const corner = site.applyPreset(s, 'corner', 'right');
    // standing on the south road looking north, "right" is the east side (edge 1)
    expect(corner.roads!.map((r) => r.edge).sort()).toEqual([1, 2]);
    expect(site.detectPreset(corner)).toEqual({ preset: 'corner', side: 'right' });
    const left = site.applyPreset(s, 'corner', 'left');
    expect(left.roads!.map((r) => r.edge).sort()).toEqual([2, 3]);
    const both = site.applyPreset(s, 'double');
    expect(both.roads!.map((r) => r.edge).sort()).toEqual([0, 2]);
    expect(site.detectPreset(both).preset).toBe('double');
    expect(site.frontEdge(both)).toBe(2);
  });

  it('keeps roads and the entrance on the right sides when corners are added or removed', () => {
    let s = site.applyPreset(rect(), 'double');
    s = { ...s, entrance: { edge: 2, t: 0.25 } };
    // add a corner in the middle of the front side → it splits in two road halves
    const ins = site.insertVertex(s, 2, [10, 32]);
    expect(ins.boundary).toHaveLength(5);
    expect(ins.roads!.map((r) => r.edge).sort()).toEqual([0, 2, 3]);
    expect(ins.entrance).toEqual({ edge: 2, t: 0.5 });
    // removing it again merges the halves
    const rem = site.removeVertex(ins, 3);
    expect(rem.boundary).toEqual(s.boundary);
    expect(rem.roads!.map((r) => r.edge).sort()).toEqual([0, 2]);
    expect(rem.entrance!.edge).toBe(2);
    expect(site.lotArea(rem)).toBeCloseTo(600);
  });

  it('turning north changes which way the road faces, and northForFacing inverts it', () => {
    const s = rect();
    const n = site.outwardNormal(s.boundary!, 2);
    expect(site.bearingName(site.bearingOf(n, 0))).toBe('South');
    expect(site.bearingName(site.bearingOf(n, 90))).toBe('East'); // north to the right → bottom faces east
    for (const b of [0, 45, 135, 270]) expect(site.bearingOf(n, site.northForFacing(n, b))).toBeCloseTo(b);
  });

  it('toggling roads moves the entrance off a removed road', () => {
    let s = site.toggleRoad(rect(), 1);
    expect(s.roads!.map((r) => r.edge)).toEqual([1, 2]);
    s = site.toggleRoad(s, 2);
    expect(s.entrance!.edge).toBe(1);
    expect(site.entranceNear(s, [25, 3])).toEqual({ edge: 1, t: 0.1 });
  });

  it('builds road strips outside the lot', () => {
    const r = site.roadShapes(rect())[0];
    expect(r.main).toBe(true);
    for (const p of r.asphalt) expect(p[1]).toBeGreaterThanOrEqual(30 + site.VERGE - 1e-9);
  });

  it('generated plans get a lot, a front road and an entrance in front of the front door', () => {
    const p = generatePlan({ area: 120, floors: 1, bedrooms: 3, bathrooms: 1, extras: [], seed: 4 });
    expect(() => PlanSpecSchema.parse(p)).not.toThrow();
    expect(p.site!.boundary).toHaveLength(4);
    expect(p.site!.roads).toEqual([{ edge: 2 }]);
    const e = site.entrancePoint(p.site!)!;
    const f = p.floors[0];
    const door = f.openings.find((o) => o.type === 'door' && f.walls.find((w) => w.id === o.wallId)?.exterior && o.width < 1.5)!;
    const w = f.walls.find((x) => x.id === door.wallId)!;
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    expect(e.p[0]).toBeCloseTo(w.a[0] + ((w.b[0] - w.a[0]) * door.offset) / len, 1);
    expect(emptyPlan('pro').site!.roads).toHaveLength(1);
  });

  it('exports the lot to SVG and 3D', () => {
    const p = generatePlan({ area: 100, floors: 1, bedrooms: 2, bathrooms: 1, extras: [], seed: 2 });
    const svg = floorToSvg(p.floors[0], { site: p.site });
    expect(svg).toContain('MAIN ROAD');
    const m = planToModel(p, { site: true });
    expect(m.elements.filter((e) => e.storey === 'Site').map((e) => e.id)).toEqual(['site-kerb', 'road-2', 'footpath-2']);
  });
});
