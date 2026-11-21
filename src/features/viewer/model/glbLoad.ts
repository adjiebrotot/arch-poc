import { NullEngine, Scene, Vector3, Matrix, VertexBuffer, SceneLoader, type Mesh } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/2.0';
import type { ModelData, ModelElement, MaterialKey } from '@shared/model/types';
import { computeBBox } from '@shared/model/types';

const KEYWORDS: [RegExp, MaterialKey][] = [
  [/glass|glaz|window_?pane/i, 'glass'], [/floor|timber|wood|oak/i, 'timber-floor'], [/tile|bath|wet/i, 'tile'],
  [/concrete|slab|found/i, 'concrete'], [/roof/i, 'roof'], [/metal|steel|alu|frame/i, 'metal'], [/grass|lawn|site/i, 'grass'],
  [/ext|facade|brick|render/i, 'exterior'], [/wall|plaster|ceiling/i, 'plaster'], [/door/i, 'timber'],
];

/** Load a .glb/.gltf with Babylon's loader and convert it to engine-agnostic ModelData (world-space baked). */
export async function loadGlb(data: ArrayBuffer, name: string, onProgress?: (p: number, m: string) => void): Promise<ModelData> {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true; // keep glTF's right-handed Y-up as-is (same frame as web-ifc)
  try {
    onProgress?.(0.1, 'Reading glTF…');
    const res = await SceneLoader.ImportMeshAsync('', '', new Uint8Array(data), scene, (e) => {
      if (e.lengthComputable) onProgress?.(0.1 + 0.6 * (e.loaded / e.total), 'Reading glTF…');
    }, name.toLowerCase().endsWith('.gltf') ? '.gltf' : '.glb');
    onProgress?.(0.75, 'Preparing geometry…');
    const elements: ModelElement[] = [];
    const storeySet = new Map<string, number>();
    for (const m of res.meshes as Mesh[]) {
      const pos = m.getVerticesData?.(VertexBuffer.PositionKind);
      if (!pos || !m.getIndices()) continue;
      const nrm = m.getVerticesData(VertexBuffer.NormalKind) ?? new Float32Array(pos.length);
      const idx = m.getIndices()!;
      m.computeWorldMatrix(true);
      const W = m.getWorldMatrix();
      const flip = W.determinant() < 0;
      const positions = new Float32Array(pos.length), normals = new Float32Array(pos.length);
      const v = new Vector3(), out = new Vector3();
      const N = Matrix.Identity();
      W.invertToRef(N); N.transposeToRef(N);
      for (let i = 0; i < pos.length; i += 3) {
        v.set(pos[i], pos[i + 1], pos[i + 2]);
        Vector3.TransformCoordinatesToRef(v, W, out);
        positions[i] = out.x; positions[i + 1] = out.y; positions[i + 2] = out.z;
        v.set(nrm[i], nrm[i + 1], nrm[i + 2]);
        Vector3.TransformNormalToRef(v, N, out);
        out.normalize();
        normals[i] = out.x; normals[i + 1] = out.y; normals[i + 2] = out.z;
      }
      const indices = new Uint32Array(idx);
      if (flip) for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
      const extras = (m.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;
      const matName = m.material?.name ?? '';
      const label = `${m.name} ${matName}`;
      const material = (extras.material as MaterialKey) ?? KEYWORDS.find(([re]) => re.test(label))?.[1] ?? 'default';
      const storey = (extras.storey as string) ?? (m.name.match(/(level|floor|storey)[ _-]?\d+/i)?.[0] ?? 'Ground floor');
      let minY = Infinity;
      for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
      if (typeof extras.storeyElevation === 'number') storeySet.set(storey, extras.storeyElevation);
      else if (!storeySet.has(storey) || minY < storeySet.get(storey)!) storeySet.set(storey, minY);
      const col = (m.material as { albedoColor?: { r: number; g: number; b: number } } | null)?.albedoColor;
      elements.push({
        id: `${elements.length}-${m.uniqueId}`,
        name: (extras.name as string) ?? m.name,
        type: (extras.type as string) ?? 'Mesh',
        storey,
        material,
        color: col ? [col.r, col.g, col.b, 1] : [0.85, 0.83, 0.8, 1],
        positions, normals, indices,
        props: (extras.props as ModelElement['props']) ?? undefined,
        ...(typeof extras.operation === 'string' ? { operation: extras.operation } : {}),
        ...(Array.isArray(extras.axes) && extras.axes.length === 6 ? { axes: extras.axes as ModelElement['axes'] } : {}),
        ...(extras.openingRole === 'leaf' || extras.openingRole === 'frame' ? { openingRole: extras.openingRole } : {}),
        ...(typeof extras.openingGroup === 'string' ? { openingGroup: extras.openingGroup } : {}),
      });
    }
    const storeys = [...storeySet.entries()].map(([n, y]) => ({ name: n, elevation: (n === 'Ground floor' ? Math.max(0, y) : y) })).sort((a, b) => a.elevation - b.elevation);
    onProgress?.(1, 'Done');
    return { id: name, name, source: 'glb', storeys, elements, bbox: computeBBox(elements) };
  } finally {
    scene.dispose();
    engine.dispose();
  }
}
