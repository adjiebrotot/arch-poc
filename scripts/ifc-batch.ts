/**
 * Robustness check: parse every .ifc in a folder with the same code the browser worker uses.
 *   npx tsx scripts/ifc-batch.ts <folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { IfcAPI } from 'web-ifc';
import { parseIfc } from '../src/features/viewer/model/ifcParse';

const dir = process.argv[2];
const api = new IfcAPI();
await api.Init(undefined, true);
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.ifc')).sort()) {
  const data = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const t0 = performance.now();
  try {
    const m = parseIfc(api, data, { name: f });
    const tris = m.elements.reduce((s, e) => s + e.indices.length / 3, 0);
    const mats = [...new Set(m.elements.map((e) => e.material))].join(',');
    const sz = m.bbox.max.map((v, i) => (v - m.bbox.min[i]).toFixed(0)).join('×');
    const tex = m.textures?.length ?? 0;
    console.log(`${f.padEnd(40)} ${(data.length / 1e6).toFixed(1).padStart(5)}MB ${String(Math.round(performance.now() - t0)).padStart(6)}ms el=${String(m.elements.length).padStart(5)} tris=${String(Math.round(tris / 1000)).padStart(4)}k storeys=[${m.storeys.map((s) => `${s.name}@${s.elevation.toFixed(1)}`).join('; ')}] size=${sz} tex=${tex} mats=${mats}`);
  } catch (e) {
    console.log(`${f.padEnd(40)} FAILED: ${(e as Error).message}`);
  }
}
