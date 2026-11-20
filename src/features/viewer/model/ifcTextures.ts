/**
 * IFC texture support on top of web-ifc (which only outputs colours).
 *
 * Handles the three IfcSurfaceTexture kinds and both ways they are attached:
 *   - IfcStyledItem → IfcSurfaceStyle → IfcSurfaceStyleWithTextures (per representation item)
 *   - IfcMaterialDefinitionRepresentation (per material, via IfcRelAssociatesMaterial)
 *   - IfcIndexedTriangleTextureMap (explicit UVs on IfcTriangulatedFaceSet)
 * IFC2x3 (IfcPresentationStyleAssignment, UrlReference) and IFC4 (URLReference) spellings are both read.
 */
import {
  type IfcAPI, IFCSTYLEDITEM, IFCIMAGETEXTURE, IFCBLOBTEXTURE, IFCPIXELTEXTURE, IFCINDEXEDTRIANGLETEXTUREMAP,
  IFCMATERIALDEFINITIONREPRESENTATION, IFCRELASSOCIATESMATERIAL,
} from 'web-ifc';
import type { TextureInfo } from '@shared/model/types';

const val = (x: unknown): unknown => {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if ('value' in o) return o.value;
    if ('_representationValue' in o) return o._representationValue;
    if ('_internalValue' in o) return o._internalValue;
  }
  return x;
};
const ref = (x: unknown) => { const v = val(x); const n = v === null || v === undefined ? NaN : Number(v); return n > 0 ? n : NaN; };
const refs = (x: unknown): number[] => (Array.isArray(x) ? x.map(ref).filter(Number.isFinite) : []);
const typeName = (api: IfcAPI, m: number, id: number) => api.GetNameFromTypeCode(api.GetLineType(m, id)).toUpperCase();
const ids = (api: IfcAPI, m: number, t: number) => { const v = api.GetLineIDsWithType(m, t); return Array.from({ length: v.size() }, (_, i) => v.get(i)); };

/** STEP binary "0FFD8…" → bytes (first hex digit = number of unused bits, always 0 for whole bytes). */
export function stepBinaryToBytes(s: string): Uint8Array {
  const hex = s.slice(1);
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export interface IfcTextureIndex {
  textures: Map<number, TextureInfo>;
  /** representation item id → texture id */
  itemTexture: Map<number, number>;
  /** product id → texture id (from its material) */
  productTexture: Map<number, number>;
  /** IfcTriangulatedFaceSet id → explicit texture map */
  faceSetMaps: Map<number, { texture: number; coords: number[][]; tris: number[][]; uv: number[][]; uvIndex: number[][] | null }>;
}

export function indexIfcTextures(api: IfcAPI, m: number): IfcTextureIndex {
  const textures = new Map<number, TextureInfo>();
  const readTexture = (id: number): TextureInfo | null => {
    if (textures.has(id)) return textures.get(id)!;
    let l: Record<string, unknown>;
    try { l = api.GetLine(m, id); } catch { return null; }
    const t = typeName(api, m, id);
    let scale: number | undefined;
    const tt = ref(l.TextureTransform);
    if (Number.isFinite(tt)) {
      try { const op = api.GetLine(m, tt); const sc = Number(val(op.Scale)); if (sc > 0) scale = sc; } catch { /* ignore */ }
    }
    let info: TextureInfo | null = null;
    if (t === 'IFCIMAGETEXTURE') {
      const url = String(val(l.URLReference ?? l.UrlReference) ?? '');
      info = { id: `tex-${id}`, name: url.split('/').pop() || `texture ${id}`, source: 'url', url, scale };
    } else if (t === 'IFCBLOBTEXTURE') {
      const fmt = String(val(l.RasterFormat) ?? 'PNG').toUpperCase();
      const raw = String(val(l.RasterCode) ?? '');
      info = { id: `tex-${id}`, name: `embedded ${fmt.toLowerCase()} #${id}`, source: 'blob', data: stepBinaryToBytes(raw), mime: fmt.startsWith('J') ? 'image/jpeg' : 'image/png', scale };
    } else if (t === 'IFCPIXELTEXTURE') {
      const w = Number(val(l.Width)), h = Number(val(l.Height)), comps = Number(val(l.ColourComponents));
      const pixels = Array.isArray(l.Pixel) ? l.Pixel.map((p) => String(val(p))) : [];
      const rgba = new Uint8Array(w * h * 4);
      pixels.slice(0, w * h).forEach((p, i) => {
        const b = stepBinaryToBytes(p);
        const g = comps <= 2 ? [b[0], b[0], b[0], comps === 2 ? b[1] : 255] : [b[0], b[1], b[2], comps === 4 ? b[3] : 255];
        rgba.set(g, i * 4);
      });
      info = { id: `tex-${id}`, name: `pixel texture #${id}`, source: 'pixel', rgba, width: w, height: h, scale };
    }
    if (info) textures.set(id, info);
    return info;
  };
  void IFCIMAGETEXTURE; void IFCBLOBTEXTURE; void IFCPIXELTEXTURE;

  /** First texture found in a list of styles (IfcSurfaceStyle / IfcPresentationStyleAssignment). */
  const textureOfStyles = (styleIds: number[], depth = 0): number | null => {
    for (const sid of styleIds) {
      try {
        const t = typeName(api, m, sid);
        const s = api.GetLine(m, sid);
        if (t === 'IFCPRESENTATIONSTYLEASSIGNMENT' && depth < 2) { const r = textureOfStyles(refs(s.Styles), depth + 1); if (r) return r; }
        if (t === 'IFCSURFACESTYLE') {
          for (const el of refs(s.Styles)) {
            if (typeName(api, m, el) !== 'IFCSURFACESTYLEWITHTEXTURES') continue;
            for (const tid of refs(api.GetLine(m, el).Textures)) if (readTexture(tid)) return tid;
          }
        }
      } catch { /* skip malformed */ }
    }
    return null;
  };

  const itemTexture = new Map<number, number>();
  for (const id of ids(api, m, IFCSTYLEDITEM)) {
    try {
      const l = api.GetLine(m, id);
      const item = ref(l.Item);
      if (!Number.isFinite(item)) continue;
      const tex = textureOfStyles(refs(l.Styles));
      if (tex) itemTexture.set(item, tex);
    } catch { /* skip */ }
  }

  // Material-level textures
  const materialTexture = new Map<number, number>();
  for (const id of ids(api, m, IFCMATERIALDEFINITIONREPRESENTATION)) {
    try {
      const l = api.GetLine(m, id);
      const mat = ref(l.RepresentedMaterial);
      for (const rep of refs(l.Representations)) {
        for (const si of refs(api.GetLine(m, rep).Items)) {
          const tex = textureOfStyles(refs(api.GetLine(m, si).Styles));
          if (tex) materialTexture.set(mat, tex);
        }
      }
    } catch { /* skip */ }
  }
  const productTexture = new Map<number, number>();
  if (materialTexture.size) {
    const firstMaterial = (id: number, depth = 0): number | null => {
      if (depth > 4) return null;
      try {
        const t = typeName(api, m, id), l = api.GetLine(m, id);
        if (t === 'IFCMATERIAL') return id;
        if (t === 'IFCMATERIALLAYERSETUSAGE') return firstMaterial(ref(l.ForLayerSet), depth + 1);
        if (t === 'IFCMATERIALLAYERSET') return firstMaterial(refs(l.MaterialLayers)[0], depth + 1);
        if (t === 'IFCMATERIALLAYER' || t === 'IFCMATERIALPROFILE' || t === 'IFCMATERIALCONSTITUENT') return firstMaterial(ref(l.Material), depth + 1);
        if (t === 'IFCMATERIALLIST') return firstMaterial(refs(l.Materials)[0], depth + 1);
        if (t === 'IFCMATERIALCONSTITUENTSET') return firstMaterial(refs(l.MaterialConstituents)[0], depth + 1);
        if (t === 'IFCMATERIALPROFILESETUSAGE') return firstMaterial(ref(l.ForProfileSet), depth + 1);
        if (t === 'IFCMATERIALPROFILESET') return firstMaterial(refs(l.MaterialProfiles)[0], depth + 1);
      } catch { /* ignore */ }
      return null;
    };
    for (const id of ids(api, m, IFCRELASSOCIATESMATERIAL)) {
      try {
        const l = api.GetLine(m, id);
        const mat = firstMaterial(ref(l.RelatingMaterial));
        const tex = mat !== null ? materialTexture.get(mat) : undefined;
        if (tex) for (const o of refs(l.RelatedObjects)) productTexture.set(o, tex);
      } catch { /* skip */ }
    }
  }

  // Explicit UV maps on triangulated face sets
  const faceSetMaps: IfcTextureIndex['faceSetMaps'] = new Map();
  for (const id of ids(api, m, IFCINDEXEDTRIANGLETEXTUREMAP)) {
    try {
      const l = api.GetLine(m, id);
      const texId = refs(l.Maps).find((t) => readTexture(t));
      if (!texId) continue;
      const fsId = ref(l.MappedTo);
      const fsl = api.GetLine(m, fsId);
      const coords = (api.GetLine(m, ref(fsl.Coordinates)).CoordList as unknown[][]).map((p) => p.map((c) => Number(val(c))));
      const tris = (fsl.CoordIndex as unknown[][]).map((t) => t.map((c) => Number(val(c)) - 1));
      const uv = (api.GetLine(m, ref(l.TexCoords)).TexCoordsList as unknown[][]).map((p) => p.map((c) => Number(val(c))));
      const uvIndex = Array.isArray(l.TexCoordIndex) ? (l.TexCoordIndex as unknown[][]).map((t) => t.map((c) => Number(val(c)) - 1)) : null;
      faceSetMaps.set(fsId, { texture: texId, coords, tris, uv, uvIndex });
      itemTexture.set(fsId, texId);
    } catch { /* skip */ }
  }
  return { textures, itemTexture, productTexture, faceSetMaps };
}

/**
 * Assign UVs to web-ifc's output vertices for a textured face set. web-ifc re-centres
 * (and may unit-scale) item geometry, so we match triangles by shape, not by index.
 * Returns null if the triangles can't be matched (caller falls back to box mapping).
 */
export function uvsForFaceSet(
  local: Float32Array | number[], stride: number, indices: ArrayLike<number>,
  map: IfcTextureIndex['faceSetMaps'] extends Map<number, infer V> ? V : never,
): Float32Array | null {
  const n = local.length / stride;
  const bb = (get: (i: number) => number[], count: number) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) { const p = get(i); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } }
    return { lo, hi, c: lo.map((v, k) => (v + hi[k]) / 2), size: Math.max(...hi.map((v, k) => v - lo[k])) };
  };
  const outBB = bb((i) => [local[i * stride], local[i * stride + 1], local[i * stride + 2]], n);
  const rawBB = bb((i) => map.coords[i], map.coords.length);
  const scale = rawBB.size > 0 ? outBB.size / rawBB.size : 1;
  const tol = Math.max(1e-4, outBB.size * 1e-4);
  // raw point → transformed into web-ifc's local frame
  const key = (x: number, y: number, z: number) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
  const lookup = new Map<string, number>();
  map.coords.forEach((p, i) => {
    const q = p.map((v, k) => (v - rawBB.c[k]) * scale + outBB.c[k]);
    lookup.set(key(q[0], q[1], q[2]), i);
  });
  const triKey = (t: number[]) => [...t].sort((a, b) => a - b).join(',');
  const triIndex = new Map(map.tris.map((t, i) => [triKey(t), i]));
  const uvs = new Float32Array(n * 2);
  let matched = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const vs = [indices[t], indices[t + 1], indices[t + 2]];
    const pi = vs.map((v) => {
      const x = local[v * stride], y = local[v * stride + 1], z = local[v * stride + 2];
      for (const dx of [0, -1, 1]) for (const dy of [0, -1, 1]) for (const dz of [0, -1, 1]) {
        const hit = lookup.get(`${Math.round(x / tol) + dx},${Math.round(y / tol) + dy},${Math.round(z / tol) + dz}`);
        if (hit !== undefined) return hit;
      }
      return -1;
    });
    if (pi.includes(-1)) continue;
    const ti = triIndex.get(triKey(pi));
    if (ti === undefined) continue;
    const tri = map.tris[ti];
    pi.forEach((p, corner) => {
      const pos = tri.indexOf(p);
      const uvi = map.uvIndex ? map.uvIndex[ti][pos] : p;
      const uv = map.uv[uvi] ?? [0, 0];
      uvs[vs[corner] * 2] = uv[0];
      uvs[vs[corner] * 2 + 1] = uv[1];
    });
    matched++;
  }
  return matched >= Math.max(1, Math.floor(indices.length / 3) * 0.8) ? uvs : null;
}
