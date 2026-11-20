/**
 * Engine-agnostic building model used by the viewer (IFC, GLB and generated
 * plans all convert to this). Coordinates: metres, right-handed, Y up.
 */
export type MaterialKey =
  | 'plaster' | 'exterior' | 'concrete' | 'timber-floor' | 'timber' | 'tile' | 'glass'
  | 'metal' | 'roof' | 'grass' | 'fabric' | 'dark' | 'default';

export interface ModelElement {
  id: string;
  expressId?: number;
  globalId?: string;
  name: string;
  /** IFC class (IfcWall…) or a friendly type for non-IFC sources */
  type: string;
  storey: string;
  material: MaterialKey;
  color: [number, number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  props?: Record<string, string | number | boolean>;
}

export interface Storey { name: string; elevation: number }

export interface ModelData {
  id: string;
  name: string;
  source: 'ifc' | 'glb' | 'plan';
  storeys: Storey[];
  elements: ModelElement[];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** true when furniture/small parts were dropped to keep mobile happy */
  simplified?: boolean;
}

export function computeBBox(elements: ModelElement[]): ModelData['bbox'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const e of elements) {
    const p = e.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}

/** Classify an IFC entity (and its colour) into the curated material library. */
export function materialForIfc(type: string, color: [number, number, number, number], name = ''): MaterialKey {
  const t = type.toUpperCase();
  const n = name.toLowerCase();
  if (color[3] < 0.9 || /glass|glaz/.test(n)) return 'glass';
  if (t.includes('WINDOW')) return 'timber';
  if (t.includes('DOOR')) return 'timber';
  if (t.includes('RAILING') || t.includes('MEMBER') && /metal|steel|alum/.test(n)) return 'metal';
  if (t.includes('RAILING')) return 'metal';
  if (t.includes('ROOF')) return 'roof';
  if (t.includes('SLAB')) return color[1] > color[0] + 0.2 && color[1] > color[2] + 0.2 ? 'grass' : /roof/.test(n) ? 'roof' : 'timber-floor';
  if (t.includes('STAIR')) return 'timber';
  if (t.includes('FOOTING') || t.includes('COLUMN') || t.includes('BEAM') || t.includes('PILE')) return 'concrete';
  if (t.includes('COVERING')) return /ceiling|clg/.test(n) ? 'plaster' : 'tile';
  if (t.includes('CURTAIN')) return 'glass';
  if (t.includes('WALL')) return /ext|brick|masonry|cmu|siding/.test(n) ? 'exterior' : 'plaster';
  if (t.includes('FURNISH') || t.includes('FURNITURE')) return color[0] + color[1] + color[2] < 0.6 ? 'dark' : color[0] > 0.8 && color[1] > 0.8 ? 'fabric' : 'timber';
  if (t.includes('MEMBER')) return 'timber';
  return 'default';
}

/** Types that can be dropped for the "simplified" mobile load. */
export const SIMPLIFY_DROP = ['IFCFURNISHINGELEMENT', 'IFCFURNITURE', 'IFCFLOWTERMINAL', 'IFCSANITARYTERMINAL', 'IFCBUILDINGELEMENTPROXY', 'IFCFOOTING', 'IFCMEMBER'];
