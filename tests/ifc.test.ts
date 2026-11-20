import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { parseIfc } from '../src/features/viewer/model/ifcParse';

describe('IFC parsing (web-ifc, single thread)', async () => {
  const api = new IfcAPI();
  await api.Init(undefined, true);
  const data = new Uint8Array(fs.readFileSync('public/samples/duplex.ifc'));

  it('extracts storeys, elements, expressIDs and metadata', () => {
    const m = parseIfc(api, data, { name: 'duplex' });
    expect(m.storeys.map((s) => s.name)).toEqual(expect.arrayContaining(['Level 1', 'Level 2']));
    expect(m.elements.length).toBeGreaterThan(150);
    const win = m.elements.find((e) => e.type === 'IfcWindow' && e.material === 'glass');
    expect(win?.expressId).toBeTypeOf('number');
    expect(m.elements.some((e) => e.props && Object.keys(e.props).length > 0)).toBe(true);
    // grouped by storey
    expect(new Set(m.elements.map((e) => e.storey)).size).toBeGreaterThanOrEqual(2);
    // re-centred horizontally
    expect(Math.abs(m.bbox.min[0] + m.bbox.max[0])).toBeLessThan(0.01);
    if (process.env.DUMP_IFC) {
      const pick = (t: string, s: string) => m.elements.filter((e) => e.type === t && e.storey === s).slice(0, 3).map((e) => {
        const p = e.positions; let x = 0, y = 0, z = 0; const n = p.length / 3;
        for (let i = 0; i < p.length; i += 3) { x += p[i]; y += p[i + 1]; z += p[i + 2]; }
        return { id: e.expressId, name: e.name, storey: e.storey, c: [x / n, y / n, z / n].map((v) => +v.toFixed(2)) };
      });
      fs.writeFileSync(process.env.DUMP_IFC, JSON.stringify({ storeys: m.storeys, bbox: m.bbox, win1: pick('IfcWindow', 'Level 1'), win2: pick('IfcWindow', 'Level 2'), door: pick('IfcDoor', 'Level 1'), stair: pick('IfcStairFlight', 'Level 1'), wall: pick('IfcWallStandardCase', 'Level 1'), furn: pick('IfcFurnishingElement', 'Level 1') }, null, 1));
    }
  });

  it('simplified mode drops furniture', () => {
    const full = parseIfc(api, data);
    const lite = parseIfc(api, data, { simplified: true });
    expect(lite.elements.length).toBeLessThan(full.elements.length);
    expect(lite.elements.some((e) => e.type === 'IfcFurnishingElement')).toBe(false);
  });
});

describe('storey elevations', async () => {
  const api = new IfcAPI();
  await api.Init(undefined, true);
  it('match the geometry for the bundled duplex', () => {
    const m = parseIfc(api, new Uint8Array(fs.readFileSync('public/samples/duplex.ifc')));
    expect(m.storeys.find((s) => s.name === 'Level 2')!.elevation).toBeCloseTo(3.1, 1);
  });
});
