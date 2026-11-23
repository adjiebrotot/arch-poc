/**
 * Bakes the demo content from the seeded "Family Home" template, generated inside its demo
 * envelope (an L-shaped single-storey footprint on a 24 × 34 m lot, see templates.ts):
 *   npx tsx scripts/build-samples.ts
 *   → public/samples/family-home.glb             (sample GLB for the viewer)
 *   → public/samples/example-design-bundle.json  (plan + pinned comments for the workspace)
 * Minimal glTF 2.0 binary writer (positions, normals, indices, PBR base colour)
 * with per-node extras (storey, IFC-like type, material key) that the viewer reads.
 */
import fs from 'node:fs';
import { templatePlan } from '../src/features/design/generator/templates';
import { planToModel } from '../src/features/design/engine/plan3d';
import type { ModelData } from '../src/shared/model/types';
import type { Comment } from '../src/shared/comments/model';
import { polygonCentroid } from '../src/shared/util/geometry';
import { recomputeRooms } from '../src/features/design/engine/openplan3dAdapter';

const PBR: Record<string, { c: [number, number, number, number]; m: number; r: number }> = {
  plaster: { c: [0.95, 0.94, 0.92, 1], m: 0, r: 0.9 }, exterior: { c: [0.9, 0.87, 0.82, 1], m: 0, r: 0.9 },
  'timber-floor': { c: [0.72, 0.54, 0.37, 1], m: 0, r: 0.55 }, timber: { c: [0.6, 0.43, 0.28, 1], m: 0, r: 0.6 },
  tile: { c: [0.91, 0.9, 0.88, 1], m: 0, r: 0.3 }, concrete: { c: [0.66, 0.65, 0.63, 1], m: 0, r: 0.85 },
  glass: { c: [0.75, 0.84, 0.89, 0.25], m: 0, r: 0.05 }, metal: { c: [0.2, 0.2, 0.21, 1], m: 0.8, r: 0.35 },
  roof: { c: [0.29, 0.3, 0.31, 1], m: 0.2, r: 0.6 }, grass: { c: [0.43, 0.56, 0.3, 1], m: 0, r: 0.95 },
};

export function modelToGlb(model: ModelData): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: object[] = [], accessors: object[] = [], meshes: object[] = [], nodes: object[] = [];
  const matIndex = new Map<string, number>();
  const materials: object[] = [];
  const push = (data: Buffer, target: number) => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  const storeyElev = new Map(model.storeys.map((s) => [s.name, s.elevation]));
  for (const e of model.elements) {
    if (!matIndex.has(e.material)) {
      const p = PBR[e.material] ?? { c: e.color, m: 0, r: 0.8 };
      matIndex.set(e.material, materials.length);
      materials.push({ name: e.material, pbrMetallicRoughness: { baseColorFactor: p.c, metallicFactor: p.m, roughnessFactor: p.r }, ...(p.c[3] < 1 ? { alphaMode: 'BLEND', doubleSided: true } : {}) });
    }
    const pos = Buffer.from(e.positions.buffer, e.positions.byteOffset, e.positions.byteLength);
    const nrm = Buffer.from(e.normals.buffer, e.normals.byteOffset, e.normals.byteLength);
    const idx = Buffer.from(e.indices.buffer, e.indices.byteOffset, e.indices.byteLength);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < e.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], e.positions[i + k]); max[k] = Math.max(max[k], e.positions[i + k]); }
    const vp = push(pos, 34962), vn = push(nrm, 34962), vi = push(idx, 34963);
    accessors.push({ bufferView: vp, componentType: 5126, count: e.positions.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: vn, componentType: 5126, count: e.normals.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: vi, componentType: 5125, count: e.indices.length, type: 'SCALAR' });
    const a = accessors.length;
    meshes.push({ name: e.name, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: matIndex.get(e.material) }] });
    nodes.push({ name: `${e.storey} / ${e.name}`, mesh: meshes.length - 1, extras: { storey: e.storey, storeyElevation: storeyElev.get(e.storey), type: e.type, material: e.material, name: e.name, props: e.props, operation: e.operation, axes: e.axes, openingRole: e.openingRole, openingGroup: e.openingGroup } });
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'architect-tool-poc sample baker' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

const plan = templatePlan('family');
const model = planToModel(plan, { roof: true });
// centre horizontally like the IFC loader does
const cx = (model.bbox.min[0] + model.bbox.max[0]) / 2, cz = (model.bbox.min[2] + model.bbox.max[2]) / 2;
for (const e of model.elements) for (let i = 0; i < e.positions.length; i += 3) { e.positions[i] -= cx; e.positions[i + 2] -= cz; }
const out = modelToGlb(model);
fs.writeFileSync('public/samples/family-home.glb', out);
console.log(`wrote public/samples/family-home.glb (${(out.length / 1024).toFixed(0)} KB, ${model.elements.length} nodes)`);

// ---- example design bundle (Feature 1 demo with comments) ----------------------
const ex = templatePlan('family');
ex.meta = { ...ex.meta, id: 'example-family', title: 'Example: Family Home (with comments)', createdAt: '2026-11-18T09:00:00.000Z' };
ex.floors = ex.floors.map((f) => recomputeRooms(f));
const f0 = ex.floors[0];
const room = (t: string) => f0.rooms.find((r) => r.type === t)!;
const pid = 'plan:example-family';
const at = (r: { polygon: [number, number][] }) => polygonCentroid(r.polygon);
const mk = (id: string, anchor: Comment['anchor'], text: string, category: Comment['category'], author: string, role: Comment['role'], createdAt: string, status: Comment['status'] = 'open', replies: Comment[] = []): Comment =>
  ({ id, projectId: pid, source: 'design-workspace', anchor, text, category, author, role, createdAt, status, replies });
const living = f0.rooms.find((r) => r.name === 'Living') ?? room('living'), master = room('master'), garage = room('garage');
const ext = f0.walls.filter((w) => w.exterior).sort((a, b) => Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]))[0];
const wallMid: [number, number] = [(ext.a[0] + ext.b[0]) / 2, (ext.a[1] + ext.b[1]) / 2];
const comments: Comment[] = [
  mk('ex-c1', { elementId: living.id, elementKind: 'room', local: [0.4, 0.2], elementLabel: living.name, floor: 0, position: [at(living)[0] + 0.4, 0, at(living)[1] + 0.2] },
    'Love this size for the living room. Can it open to the garden with big sliding doors?', 'like', 'Priya (client)', 'client', '2026-11-18T09:20:00.000Z', 'open',
    [{ id: 'ex-r1', projectId: pid, source: 'design-workspace', anchor: { position: [0, 0, 0] }, text: 'Yes — we will show a 3.6 m stacking slider on the north side.', author: 'Architect Tool POC', role: 'architect', createdAt: '2026-11-18T13:00:00.000Z', status: 'open', replies: [] }]),
  mk('ex-c2', { elementId: master.id, elementKind: 'room', local: [-0.5, 0.3], elementLabel: master.name, floor: 0, position: [at(master)[0] - 0.5, 0, at(master)[1] + 0.3] },
    'Could the main bedroom be a little wider so a king bed fits with bedside tables?', 'change', 'Sam (client)', 'client', '2026-11-18T09:31:00.000Z'),
  mk('ex-c3', { elementId: ext.id, elementKind: 'wall', local: [0.5, -0.4], elementLabel: 'Outside wall', floor: 0, position: [wallMid[0], 0, wallMid[1]] },
    'Which way is north? We would like morning sun in the kitchen.', 'question', 'Priya (client)', 'client', '2026-11-18T10:02:00.000Z'),
  mk('ex-c4', { elementId: garage.id, elementKind: 'room', local: [0, 0], elementLabel: garage.name, floor: 0, position: [at(garage)[0], 0, at(garage)[1]] },
    'Garage fits two cars side by side with 600 mm storage at the back.', 'like', 'Architect Tool POC', 'architect', '2026-11-18T12:45:00.000Z', 'resolved'),
];
const bundle = { kind: 'atelier-linea/design-bundle', version: 1, exportedAt: '2026-11-18T13:05:00.000Z', plan: ex, comments, requirements: ex.requirements };
fs.writeFileSync('public/samples/example-design-bundle.json', JSON.stringify(bundle, null, 1));
console.log('wrote public/samples/example-design-bundle.json');
