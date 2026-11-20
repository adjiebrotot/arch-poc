/**
 * IFC → ModelData using web-ifc (single-threaded WASM; GitHub Pages can't send
 * COOP/COEP headers so SharedArrayBuffer/multithreading is not available).
 * Runs inside a Web Worker in the browser, and in Node for tests/scripts.
 */
import {
  type IfcAPI, IFCBUILDINGSTOREY, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELAGGREGATES, IFCRELDEFINESBYPROPERTIES,
} from 'web-ifc';
import type { ModelData, ModelElement, Storey } from '@shared/model/types';
import { computeBBox, materialForIfc, SIMPLIFY_DROP } from '@shared/model/types';
import { indexIfcTextures, uvsForFaceSet } from './ifcTextures';

export interface ParseOptions {
  simplified?: boolean;
  onProgress?: (fraction: number, message: string) => void;
  name?: string;
}

const val = (x: unknown): unknown => (x && typeof x === 'object' && 'value' in (x as object) ? (x as { value: unknown }).value : x);
const str = (x: unknown) => { const v = val(x); return typeof v === 'string' ? v : v == null ? '' : String(v); };
const refs = (x: unknown): number[] => (Array.isArray(x) ? x.map((r) => Number(val(r))).filter(Number.isFinite) : []);

export function parseIfc(api: IfcAPI, data: Uint8Array, opts: ParseOptions = {}): ModelData {
  const progress = opts.onProgress ?? (() => {});
  progress(0.02, 'Reading file…');
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 12 });
  try {
    // ---- spatial structure ---------------------------------------------------
    const storeyName = new Map<number, string>();
    const storeyElev = new Map<string, number>();
    const ids = api.GetLineIDsWithType(modelID, IFCBUILDINGSTOREY);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const l = api.GetLine(modelID, id);
      const name = str(l.Name) || str(l.LongName) || `Storey ${i + 1}`;
      storeyName.set(id, name);
      storeyElev.set(name, Number(val(l.Elevation)) || 0);
    }
    const containedIn = new Map<number, number>();
    const rels = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      const l = api.GetLine(modelID, rels.get(i));
      const s = Number(val(l.RelatingStructure));
      for (const e of refs(l.RelatedElements)) containedIn.set(e, s);
    }
    const parentOf = new Map<number, number>();
    const aggs = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
    for (let i = 0; i < aggs.size(); i++) {
      const l = api.GetLine(modelID, aggs.get(i));
      const p = Number(val(l.RelatingObject));
      for (const c of refs(l.RelatedObjects)) parentOf.set(c, p);
    }
    const storeyOf = (id: number): string => {
      let cur: number | undefined = id;
      for (let guard = 0; cur !== undefined && guard < 10; guard++) {
        if (storeyName.has(cur)) return storeyName.get(cur)!;
        const s = containedIn.get(cur);
        if (s !== undefined && storeyName.has(s)) return storeyName.get(s)!;
        cur = s ?? parentOf.get(cur);
      }
      return '';
    };

    progress(0.1, 'Reading properties…');
    // ---- property sets (flattened, capped) -------------------------------------
    const props = new Map<number, Record<string, string | number | boolean>>();
    const pr = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < pr.size(); i++) {
      try {
        const rel = api.GetLine(modelID, pr.get(i));
        const pset = api.GetLine(modelID, Number(val(rel.RelatingPropertyDefinition)));
        const hasProps = refs(pset?.HasProperties);
        if (!hasProps.length) continue;
        const psetName = str(pset.Name);
        const flat: Record<string, string | number | boolean> = {};
        for (const pid of hasProps.slice(0, 25)) {
          const p = api.GetLine(modelID, pid);
          const v = val(p?.NominalValue);
          if (v === undefined || v === null || v === '') continue;
          flat[`${psetName}.${str(p.Name)}`] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : typeof v === 'boolean' ? v : String(v).slice(0, 80);
        }
        for (const obj of refs(rel.RelatedObjects)) {
          const cur = props.get(obj) ?? {};
          if (Object.keys(cur).length < 40) props.set(obj, Object.assign(cur, flat));
        }
      } catch { /* malformed pset: skip */ }
    }

    progress(0.13, 'Reading materials and textures…');
    let tex: ReturnType<typeof indexIfcTextures> | null = null;
    try { tex = indexIfcTextures(api, modelID); } catch (e) { console.warn('texture index failed', e); }
    const usedTextures = new Set<number>();

    // ---- geometry -----------------------------------------------------------------
    const elements: ModelElement[] = [];
    const lineInfo = new Map<number, { type: string; name: string; gid: string }>();
    const lineInfo2 = new Map<number, string>();
    const info = (id: number) => {
      let r = lineInfo.get(id);
      if (!r) {
        const type = api.GetNameFromTypeCode(api.GetLineType(modelID, id));
        let name = '', gid = '', predefined = '';
        try { const l = api.GetLine(modelID, id); name = str(l.Name); gid = str(l.GlobalId); predefined = str(l.PredefinedType); } catch { /* noop */ }
        r = { type, name, gid };
        lineInfo.set(id, r);
        lineInfo2.set(id, predefined);
      }
      return r;
    };
    /** Slabs that are really roofs: PredefinedType ROOF, part of an IfcRoof, or named so (en/de/fr/nl/it/es). */
    const isRoofSlab = (id: number, name: string) => {
      if (lineInfo2.get(id)?.toUpperCase() === 'ROOF') return true;
      const parent = parentOf.get(id);
      if (parent !== undefined) { try { if (api.GetNameFromTypeCode(api.GetLineType(modelID, parent)).toUpperCase() === 'IFCROOF') return true; } catch { /* noop */ } }
      return /roof|dach|toit|dak|tetto|cubierta/i.test(name);
    };
    let lastReport = 0;
    api.StreamAllMeshes(modelID, (mesh, index, total) => {
      const id = mesh.expressID;
      const { type, name, gid } = info(id);
      const T = type.toUpperCase();
      if (T === 'IFCSPACE' || T === 'IFCOPENINGELEMENT' || T === 'IFCANNOTATION') return;
      if (opts.simplified && SIMPLIFY_DROP.includes(T)) return;
      // group this product's geometries by colour (e.g. window glass vs frame)
      const groups = new Map<string, { color: [number, number, number, number]; p: number[]; n: number[]; i: number[]; uv: number[] | null; tex: number | null }>();
      const g = mesh.geometries;
      for (let k = 0; k < g.size(); k++) {
        const pg = g.get(k);
        const c = pg.color;
        const color: [number, number, number, number] = [c.x, c.y, c.z, c.w];
        const geom = api.GetGeometry(modelID, pg.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const texId = tex ? (tex.itemTexture.get(pg.geometryExpressID) ?? tex.productTexture.get(id) ?? null) : null;
        const fsMap = tex?.faceSetMaps.get(pg.geometryExpressID);
        const uvs = fsMap ? uvsForFaceSet(verts, 6, idx, fsMap) : null;
        if (texId !== null) usedTextures.add(texId);
        const key = color.map((v) => v.toFixed(2)).join(',') + `|${texId ?? ''}|${uvs ? 'uv' : ''}`;
        if (!groups.has(key)) groups.set(key, { color, p: [], n: [], i: [], uv: uvs ? [] : null, tex: texId });
        const grp = groups.get(key)!;
        if (grp.uv && uvs) for (let u = 0; u < uvs.length; u++) grp.uv.push(uvs[u]);
        const M = pg.flatTransformation;
        const base = grp.p.length / 3;
        for (let v = 0; v < verts.length; v += 6) {
          const x = verts[v], y = verts[v + 1], z = verts[v + 2];
          grp.p.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
          const nx = verts[v + 3], ny = verts[v + 4], nz = verts[v + 5];
          const tx = M[0] * nx + M[4] * ny + M[8] * nz, ty = M[1] * nx + M[5] * ny + M[9] * nz, tz = M[2] * nx + M[6] * ny + M[10] * nz;
          const len = Math.hypot(tx, ty, tz) || 1;
          grp.n.push(tx / len, ty / len, tz / len);
        }
        for (let t = 0; t < idx.length; t++) grp.i.push(idx[t] + base);
        (geom as { delete?: () => void }).delete?.();
      }
      let gi = 0;
      const roofSlab = T === 'IFCSLAB' && isRoofSlab(id, name);
      for (const grp of groups.values()) {
        if (!grp.i.length) continue;
        let material = materialForIfc(type, grp.color, name);
        if (material === 'timber-floor' && (roofSlab || mostlyTilted(grp.n))) material = 'roof';
        elements.push({
          id: `${id}-${gi++}`,
          expressId: id,
          globalId: gid,
          name: name || type.replace(/^Ifc/i, ''),
          type: prettyType(type),
          storey: storeyOf(id),
          material,
          color: grp.color,
          positions: new Float32Array(grp.p),
          normals: new Float32Array(grp.n),
          indices: new Uint32Array(grp.i),
          props: props.get(id),
          ...(grp.tex !== null ? { texture: `tex-${grp.tex}` } : {}),
          ...(grp.uv ? { uvs: new Float32Array(grp.uv) } : {}),
        });
      }
      if (index - lastReport > total / 50) { lastReport = index; progress(0.15 + 0.8 * (index / Math.max(1, total)), `Building geometry… ${index}/${total}`); }
    });

    progress(0.96, 'Finishing…');
    // Re-centre horizontally (keep heights so storey elevations stay meaningful).
    const bb0 = computeBBox(elements);
    const ox = (bb0.min[0] + bb0.max[0]) / 2, oz = (bb0.min[2] + bb0.max[2]) / 2;
    for (const e of elements) for (let i = 0; i < e.positions.length; i += 3) { e.positions[i] -= ox; e.positions[i + 2] -= oz; }

    // Storeys sorted by elevation. IfcBuildingStorey.Elevation is often relative to the
    // building while geometry is placed at absolute height (e.g. 500 m above sea level),
    // so estimate that offset from the storeys' own slabs/walls and apply it.
    const raw = [...storeyElev.entries()].map(([name, elevation]) => {
      let minY = Infinity;
      for (const e of elements) {
        if (e.storey !== name || !/Slab|Wall/i.test(e.type)) continue;
        for (let i = 1; i < e.positions.length; i += 3) if (e.positions[i] < minY) minY = e.positions[i];
      }
      return { name, scaled: Math.abs(elevation) > 200 && Math.abs(elevation) > 20 * (bb0.max[1] - bb0.min[1]) ? elevation / 1000 : elevation, minY };
    });
    const diffs = raw.filter((r) => Number.isFinite(r.minY)).map((r) => r.minY - r.scaled).sort((a, b) => a - b);
    const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
    const agree = diffs.filter((d) => Math.abs(d - median) < 1.5).length >= Math.ceil(diffs.length / 2);
    const offset = Math.abs(median) > 5 && agree ? Math.round(median * 100) / 100 : 0;
    const storeys: Storey[] = raw.map((r) => {
      const e = r.scaled + offset;
      return { name: r.name, elevation: Number.isFinite(r.minY) && Math.abs(r.minY - e) < 1.5 ? Math.max(r.minY, e) : e };
    }).sort((a, b) => a.elevation - b.elevation);
    // Infrastructure / site-only files may have no IfcBuildingStorey at all.
    if (!storeys.length) storeys.push({ name: 'Model', elevation: computeBBox(elements).min[1] });
    for (const e of elements) if (!e.storey || !storeys.some((s) => s.name === e.storey)) e.storey = storeys.find((s) => s.name === e.storey)?.name ?? storeys[0].name;
    const textures = tex ? [...usedTextures].map((t) => tex!.textures.get(t)!).filter(Boolean) : [];
    progress(1, 'Done');
    return { id: opts.name ?? 'ifc', name: opts.name ?? 'IFC model', source: 'ifc', storeys, elements, bbox: computeBBox(elements), simplified: !!opts.simplified, textures };
  } finally {
    api.CloseModel(modelID);
  }
}

/** True when most upward-facing normals are pitched (a sloped slab is a roof, not a floor). */
function mostlyTilted(n: number[]): boolean {
  let up = 0, tilted = 0;
  for (let i = 1; i < n.length; i += 3) {
    if (n[i] > 0.2) { up++; if (n[i] < 0.97) tilted++; }
  }
  return up > 0 && tilted / up > 0.5;
}

function prettyType(t: string): string {
  // IFCWALLSTANDARDCASE → IfcWallStandardCase (web-ifc returns upper-case names)
  const known: Record<string, string> = {
    IFCWALLSTANDARDCASE: 'IfcWallStandardCase', IFCWALL: 'IfcWall', IFCSLAB: 'IfcSlab', IFCWINDOW: 'IfcWindow', IFCDOOR: 'IfcDoor',
    IFCROOF: 'IfcRoof', IFCSTAIR: 'IfcStair', IFCSTAIRFLIGHT: 'IfcStairFlight', IFCRAILING: 'IfcRailing', IFCBEAM: 'IfcBeam',
    IFCCOLUMN: 'IfcColumn', IFCFOOTING: 'IfcFooting', IFCFURNISHINGELEMENT: 'IfcFurnishingElement', IFCCOVERING: 'IfcCovering',
    IFCMEMBER: 'IfcMember', IFCPLATE: 'IfcPlate', IFCCURTAINWALL: 'IfcCurtainWall', IFCBUILDINGELEMENTPROXY: 'IfcBuildingElementProxy',
  };
  return known[t.toUpperCase()] ?? t;
}

