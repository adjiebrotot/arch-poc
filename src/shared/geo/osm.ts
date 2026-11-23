/**
 * OpenStreetMap helpers for tracing a lot over a real map.
 *
 * The plan is a local metric frame: plan (0, 0) is the point the client searched for, x points
 * east and y south (Web-Mercator is conformal, so within a few hundred metres one scale factor
 * converts it to metres exactly enough for a house lot). The plan may afterwards be turned so the
 * street is at the bottom; `rotation` (degrees clockwise) is then also the plan's north angle,
 * which is how the real-world orientation is preserved.
 *
 * Services (all overridable at build time, see README):
 *   tiles     VITE_TILE_URL      default https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *   geocoder  VITE_GEOCODER_URL  default https://nominatim.openstreetmap.org/search  (Nominatim)
 *   roads     VITE_OVERPASS_URL  default overpass-api.de, then overpass.kumi.systems  (Overpass API)
 */
import type { Vec2 } from '@shared/util/geometry';
import { dist, rotatePoint } from '@shared/util/geometry';
import { outwardNormal, edgeOf } from '@shared/planspec/site';

const envVar = (k: string): string | undefined => {
  try { return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[k])?.trim() || undefined; } catch { return undefined; }
};

export const TILE_URL = envVar('VITE_TILE_URL') ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const GEOCODER_URL = envVar('VITE_GEOCODER_URL') ?? 'https://nominatim.openstreetmap.org/search';
export const OVERPASS_URLS = envVar('VITE_OVERPASS_URL') ? [envVar('VITE_OVERPASS_URL')!] : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const ATTRIBUTION = '© OpenStreetMap contributors';
export const MAX_ZOOM = 19;

const EARTH = 40075016.686; // equatorial circumference, m
const rad = (d: number) => (d * Math.PI) / 180;

export interface GeoOrigin { lat: number; lon: number }

/** Web-Mercator world coordinates, both 0–1 (v grows southwards). */
export function mercator(lat: number, lon: number): Vec2 {
  const s = Math.sin(rad(Math.max(-85.05, Math.min(85.05, lat))));
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}
export function inverseMercator(u: number, v: number): GeoOrigin {
  const n = Math.PI - 2 * Math.PI * v;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon: u * 360 - 180 };
}
/** Metres per Mercator world unit at a latitude. */
export const metresPerUnit = (lat: number) => EARTH * Math.cos(rad(lat));

/** Map metres (x east, y south) of a lat/lon, relative to the origin (north up). */
export function toMapMetres(o: GeoOrigin, lat: number, lon: number): Vec2 {
  const [u0, v0] = mercator(o.lat, o.lon), [u, v] = mercator(lat, lon);
  const E = metresPerUnit(o.lat);
  return [(u - u0) * E, (v - v0) * E];
}
export function fromMapMetres(o: GeoOrigin, p: Vec2): GeoOrigin {
  const [u0, v0] = mercator(o.lat, o.lon);
  const E = metresPerUnit(o.lat);
  return inverseMercator(u0 + p[0] / E, v0 + p[1] / E);
}

/** Plan point ↔ map point: the plan is the map turned `rotation` degrees clockwise about the origin. */
export const mapToPlan = (p: Vec2, rotation: number): Vec2 => rotatePoint(p, rotation);
export const planToMap = (p: Vec2, rotation: number): Vec2 => rotatePoint(p, -rotation);

export interface Tile { key: string; url: string; x: number; y: number; size: number }

/**
 * Tiles covering a plan-space view box at `scale` pixels per metre. Tile positions are in map
 * metres (north up): draw them inside a group rotated by `rotation`.
 */
export function tilesFor(o: GeoOrigin, rotation: number, view: { x: number; y: number; w: number; h: number }, scale: number, dpr = 1): { z: number; tiles: Tile[] } {
  const corners: Vec2[] = [[view.x, view.y], [view.x + view.w, view.y], [view.x + view.w, view.y + view.h], [view.x, view.y + view.h]].map((p) => planToMap(p as Vec2, rotation));
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const E = metresPerUnit(o.lat);
  let z = Math.max(3, Math.min(MAX_ZOOM, Math.round(Math.log2((E * scale * Math.min(2, dpr)) / 256))));
  const [u0, v0] = mercator(o.lat, o.lon);
  const range = (zz: number) => {
    const n = 2 ** zz;
    return {
      n,
      tx0: Math.floor((u0 + Math.min(...xs) / E) * n), tx1: Math.floor((u0 + Math.max(...xs) / E) * n),
      ty0: Math.max(0, Math.floor((v0 + Math.min(...ys) / E) * n)), ty1: Math.min(n - 1, Math.floor((v0 + Math.max(...ys) / E) * n)),
    };
  };
  let r = range(z);
  while (z > 3 && (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1) > 120) r = range(--z);
  const tiles: Tile[] = [];
  const size = E / r.n;
  for (let ty = r.ty0; ty <= r.ty1; ty++) {
    for (let tx = r.tx0; tx <= r.tx1; tx++) {
      const wx = ((tx % r.n) + r.n) % r.n;
      tiles.push({
        key: `${z}/${wx}/${ty}`,
        url: TILE_URL.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(ty)),
        x: (tx / r.n - u0) * E, y: (ty / r.n - v0) * E, size,
      });
    }
  }
  return { z, tiles };
}

// ---- address search (Nominatim) ---------------------------------------------------------------

export interface Place { label: string; lat: number; lon: number }

/** "-33.86, 151.21" style input. */
export function parseLatLon(q: string): Place | null {
  const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
}

/** Search an address (one request per search: Nominatim's usage policy forbids autocomplete). */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const ll = parseLatLon(q);
  if (ll) return [ll];
  const url = `${GEOCODER_URL}?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return data.map((d) => ({ label: d.display_name, lat: +d.lat, lon: +d.lon })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// ---- roads (Overpass) and which lot sides face them ---------------------------------------------

export interface OsmRoad { name?: string; kind: string; points: Vec2[] }

const ROAD_KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road', 'pedestrian'];
/** Lower is a more likely street frontage. */
const KIND_RANK: Record<string, number> = { residential: 0, living_street: 0, unclassified: 1, tertiary: 1, secondary: 2, primary: 2, road: 2, trunk: 4, motorway: 9, pedestrian: 5, service: 6 };

/** Roads within `radius` metres of the origin, in map metres. Tries each Overpass endpoint in turn. */
export async function fetchRoads(o: GeoOrigin, radius = 80, signal?: AbortSignal): Promise<OsmRoad[]> {
  const q = `[out:json][timeout:20];way(around:${Math.round(radius)},${o.lat.toFixed(7)},${o.lon.toFixed(7)})["highway"~"^(${ROAD_KINDS.join('|')})$"];out geom tags;`;
  let last: unknown = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = (await res.json()) as { elements: { tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] };
      return data.elements.filter((e) => e.geometry?.length).map((e) => ({
        name: e.tags?.name, kind: e.tags?.highway ?? 'road',
        points: e.geometry!.map((g) => toMapMetres(o, g.lat, g.lon)),
      }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('Road lookup failed');
}

export interface Frontage { edge: number; name?: string; kind: string; distance: number; score: number }

/**
 * Which sides of a lot face a street: a side faces a road when a road runs roughly parallel to it
 * and is crossed by a line from the side's middle straight out of the lot within `maxDist` metres
 * (centre line of the road; service lanes only when very close). Best (main) frontage first.
 */
export function detectFrontage(boundary: Vec2[], roads: OsmRoad[], maxDist = 28): Frontage[] {
  const out: Frontage[] = [];
  boundary.forEach((_, i) => {
    const [a, b] = edgeOf(boundary, i);
    const len = dist(a, b);
    if (len < 2) return;
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = outwardNormal(boundary, i);
    let best: Frontage | null = null;
    for (const r of roads) {
      const rank = KIND_RANK[r.kind] ?? 3;
      const limit = r.kind === 'service' ? Math.min(12, maxDist) : maxDist;
      for (let k = 0; k + 1 < r.points.length; k++) {
        const p = r.points[k], q = r.points[k + 1];
        const L = dist(p, q);
        if (L < 0.5) continue;
        const rv: Vec2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
        if (Math.abs(u[0] * rv[0] + u[1] * rv[1]) < 0.7) continue; // not running along this side
        // the road must be in front of the side: cast from a few points along it
        for (const t of [0.5, 0.25, 0.75]) {
          const m: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const d = raySegment(m, n, p, q);
          if (d === null || d > limit) continue;
          const score = d + rank * 4 - Math.min(len, 30) * 0.2;
          if (!best || score < best.score) best = { edge: i, name: r.name, kind: r.kind, distance: Math.round(d * 10) / 10, score };
          break;
        }
      }
    }
    if (best) out.push(best);
  });
  return out.sort((x, y) => x.score - y.score);
}

/** Distance along the ray o + t·d (t ≥ 0) to segment pq, or null. */
function raySegment(o: Vec2, d: Vec2, p: Vec2, q: Vec2): number | null {
  const ex = q[0] - p[0], ey = q[1] - p[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p[0] - o[0]) * ey - (p[1] - o[1]) * ex) / den;
  const s = ((p[0] - o[0]) * d[1] - (p[1] - o[1]) * d[0]) / den;
  return t >= 0 && s >= -1e-9 && s <= 1 + 1e-9 ? t : null;
}

/**
 * Rotation (degrees clockwise) that puts lot side `edge` at the bottom of the plan, facing down.
 * The plan's north angle becomes this rotation.
 */
export function streetAtBottom(boundary: Vec2[], edge: number): number {
  const n = outwardNormal(boundary, edge);
  const facing = (Math.atan2(n[0], -n[1]) * 180) / Math.PI; // clockwise from up
  let r = 180 - facing;
  r = ((r % 360) + 540) % 360 - 180;
  return Math.round(r * 10) / 10;
}
