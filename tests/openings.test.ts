import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { parseIfc } from '../src/features/viewer/model/ifcParse';
import { extractOpenings, type Motion } from '../src/features/viewer/engine/openings';
import { planToModel } from '../src/features/design/engine/plan3d';
import { templatePlan } from '../src/features/design/generator/templates';

type Rot = Extract<Motion, { type: 'rotate' }>;

describe('doors & windows', async () => {
  const api = new IfcAPI();
  await api.Init(undefined, true);

  it('reads IFC operation types and local axes (Revit duplex)', () => {
    const m = parseIfc(api, new Uint8Array(fs.readFileSync('public/samples/duplex.ifc')));
    const door = m.elements.find((e) => e.type === 'IfcDoor');
    expect(door?.operation).toMatch(/^SINGLE_SWING_(LEFT|RIGHT)$/);
    expect(door?.axes).toHaveLength(6);
    const { openings, statics } = extractOpenings(m);
    const doors = openings.filter((o) => o.kind === 'door');
    expect(doors.length).toBe(14);
    // fixed windows stay put; casements open
    expect(openings.filter((o) => o.kind === 'window').every((o) => /Casement/i.test(o.name))).toBe(true);
    for (const d of doors) {
      // the leaf moves, the lining stays
      expect(d.leaves).toHaveLength(1);
      expect(statics.some((e) => `x${e.expressId}` === d.id)).toBe(true);
      const mo = d.leaves[0].motion as Rot;
      expect(mo.type).toBe('rotate');
      // IFC: swings towards local +Y
      expect(mo.toward).toEqual([d.ay[0], 0, d.ay[1]]);
      // hinge on the left (−X) or right (+X) end as seen looking along +Y
      const u = (mo.probe[0] - mo.pivot[0]) * d.ax[0] + (mo.probe[2] - mo.pivot[2]) * d.ax[1];
      expect(Math.sign(u)).toBe(d.operation === 'SINGLE_SWING_LEFT' ? 1 : -1);
    }
  });

  it('falls back to geometry when an exporter rotates geometry, not placement (IFC4 cottage)', () => {
    const m = parseIfc(api, new Uint8Array(fs.readFileSync('public/samples/textured-cottage/textured-cottage.ifc')));
    const { openings } = extractOpenings(m);
    expect(openings.map((o) => o.name)).toEqual(expect.arrayContaining(['Front door', 'Bedroom door', 'West window', 'Garden slider']));
    const slider = openings.find((o) => o.name === 'Garden slider')!;
    expect(slider.leaves[0].motion.type).toBe('slide');
    // no direction in the file: swings away from whoever opens it
    const front = openings.find((o) => o.name === 'Front door')!;
    expect((front.leaves[0].motion as Rot).toward).toBeNull();
  });

  it('generated plans: closed leaves hinged at the wall start, swinging to +v', () => {
    const model = planToModel(templatePlan('family')!, { roof: false });
    const { openings } = extractOpenings(model);
    const doors = openings.filter((o) => o.kind === 'door');
    expect(doors.length).toBeGreaterThan(3);
    for (const d of doors) expect(d.operation).toBe('SINGLE_SWING_LEFT');
    expect(openings.some((o) => o.kind === 'window')).toBe(true);
  });
});
