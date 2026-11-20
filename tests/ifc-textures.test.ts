import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { parseIfc } from '../src/features/viewer/model/ifcParse';
import { stepBinaryToBytes } from '../src/features/viewer/model/ifcTextures';
import { focusBBox } from '../src/shared/model/types';

describe('IFC textures', async () => {
  const api = new IfcAPI();
  await api.Init(undefined, true);
  const m = parseIfc(api, new Uint8Array(fs.readFileSync('public/samples/textured-cottage/textured-cottage.ifc')), { name: 'cottage' });
  const byName = (n: string) => m.elements.filter((e) => e.name === n);

  it('decodes STEP binary', () => {
    expect([...stepBinaryToBytes('0FFD8FF')]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('reads IfcImageTexture, IfcBlobTexture and IfcPixelTexture', () => {
    const kinds = m.textures!.map((t) => t.source).sort();
    expect(kinds).toEqual(['blob', 'pixel', 'url', 'url', 'url', 'url', 'url']);
    const blob = m.textures!.find((t) => t.source === 'blob')!;
    expect([...blob.data!.slice(0, 2)]).toEqual([0xff, 0xd8]); // JPEG magic
    const px = m.textures!.find((t) => t.source === 'pixel')!;
    expect(px.rgba!.length).toBe(4 * 4 * 4);
    const brick = m.textures!.find((t) => t.url === 'textures/bricks.jpg')!;
    expect(brick.scale).toBeCloseTo(1 / 1.2); // TextureTransform → repeats per metre
  });

  it('attaches textures via styled items and explicit UVs via IfcIndexedTriangleTextureMap', () => {
    const wall = byName('South wall')[0];
    expect(wall.texture).toBeTruthy();
    expect(wall.uvs).toBeUndefined(); // default mapping → box UVs in the viewer
    const roof = byName('Gable roof')[0];
    expect(roof.uvs?.length).toBe((roof.positions.length / 3) * 2);
    expect(Math.max(...roof.uvs!)).toBeGreaterThan(5); // tiles repeat along the 11 m ridge
    expect(byName('Garden path')[0].texture).toBe(m.textures!.find((t) => t.source === 'blob')!.id);
    expect(byName('Front door')[0].texture).toBe(m.textures!.find((t) => t.source === 'pixel')!.id);
  });

  it('frames the building, not the 44 m lawn', () => {
    const b = focusBBox(m);
    expect(b.max[0] - b.min[0]).toBeLessThan(13);
    expect(m.bbox.max[0] - m.bbox.min[0]).toBeGreaterThan(40);
  });
});
