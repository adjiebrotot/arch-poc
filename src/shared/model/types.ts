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
  /** id of a TextureInfo in ModelData.textures */
  texture?: string;
  /** explicit texture coordinates (IfcIndexedTriangleTextureMap / glTF); otherwise box-mapped */
  uvs?: Float32Array;
  /**
   * Doors/windows: how it opens, as the IFC enum text (SINGLE_SWING_LEFT, SLIDING_TO_RIGHT,
   * DOUBLE_DOOR_SINGLE_SWING, SIDEHUNGLEFTHAND, TOPHUNG, FIXEDCASEMENT…).
   */
  operation?: string;
  /** Doors/windows: world unit vectors of the local X (width) and Y (swing side) axes. */
  axes?: [number, number, number, number, number, number];
  /** Doors/windows split into explicit parts (generated plans): moving leaf vs fixed frame. */
  openingRole?: 'leaf' | 'frame';
  /** Parts sharing this key belong to one door/window (defaults to expressId). */
  openingGroup?: string;
}

/** An image texture carried by the model (IFC IfcImageTexture/IfcBlobTexture/IfcPixelTexture). */
export interface TextureInfo {
  id: string;
  name: string;
  source: 'url' | 'blob' | 'pixel' | 'gltf';
  /** IfcImageTexture URLReference (relative to the model file) */
  url?: string;
  /** encoded image bytes (jpg/png) */
  data?: Uint8Array;
  mime?: string;
  /** raw RGBA pixels (IfcPixelTexture) */
  rgba?: Uint8Array;
  width?: number;
  height?: number;
  /** repeats per metre when the element has no explicit UVs (from TextureTransform scale) */
  scale?: number;
  /** URL texture whose image couldn't be found */
  missing?: boolean;
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
  textures?: TextureInfo[];
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

/**
 * Bounds of the building itself, ignoring site/terrain geometry (lawns, topography),
 * which can be many times larger and would otherwise dominate camera framing and drawings.
 */
export function focusBBox(model: ModelData): ModelData['bbox'] {
  const site = (e: ModelElement) => /Site|Geographic|Terrain|Topograph/i.test(e.type) || /topograph|terrain|lawn|landscape/i.test(e.name) || e.storey === 'Site';
  const core = model.elements.filter((e) => !site(e));
  return core.length ? computeBBox(core) : model.bbox;
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
  const green = color[1] > color[0] + 0.2 && color[1] > color[2] + 0.2;
  const siteLike = /grass|lawn|gras|turf|garden|garten|site|terrain|topo|landscap|green ?roof|gr[üu]ndach/.test(n);
  if (t.includes('SITE') || t.includes('GEOGRAPHIC')) return 'grass';
  if (t.includes('SLAB')) return green && siteLike ? 'grass' : green ? 'default' : /roof/.test(n) ? 'roof' : 'timber-floor';
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
