import { describe, it, expect } from 'vitest';
import { mercator, inverseMercator, toMapMetres, fromMapMetres, detectFrontage, streetAtBottom, tilesFor, parseLatLon, mapToPlan, planToMap, type OsmRoad } from '../src/shared/geo/osm';
import { rotatePoint, type Vec2 } from '../src/shared/util/geometry';
import { bearingOf, outwardNormal, bearingName } from '../src/shared/planspec/site';

const O = { lat: -33.87, lon: 151.21 };
const lot: Vec2[] = [[-10, -15], [13, -15], [13, 15], [-10, 15]]; // map metres, north up

describe('OpenStreetMap helpers', () => {
  it('converts lat/lon to local metres and back', () => {
    const [u, v] = mercator(O.lat, O.lon);
    const back = inverseMercator(u, v);
    expect(back.lat).toBeCloseTo(O.lat, 9);
    expect(back.lon).toBeCloseTo(O.lon, 9);
    const p = toMapMetres(O, O.lat - 0.0009, O.lon + 0.0009); // ~100 m south, ~83 m east at this latitude
    expect(p[0]).toBeGreaterThan(80); expect(p[0]).toBeLessThan(86);
    expect(p[1]).toBeGreaterThan(98); expect(p[1]).toBeLessThan(102);
    const g = fromMapMetres(O, p);
    expect(g.lat).toBeCloseTo(O.lat - 0.0009, 8);
  });

  it('finds the side of a lot that faces a street, ignoring roads that are far or run the other way', () => {
    const roads: OsmRoad[] = [
      { name: 'Example Street', kind: 'residential', points: [[22, -80], [22, 80]] }, // 9 m east of the east side
      { kind: 'service', points: [[-60, -80], [-60, 80]] }, // 50 m west: too far
      { name: 'Cross Road', kind: 'tertiary', points: [[-60, 60], [60, 60]] }, // 45 m south: too far
    ];
    const f = detectFrontage(lot, roads);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ edge: 1, name: 'Example Street', distance: 9 });
  });

  it('turns the plan so the street is at the bottom, and north follows', () => {
    const r = streetAtBottom(lot, 1); // east side
    expect(r).toBe(90);
    const turned = lot.map((p) => rotatePoint(p, r));
    const n = outwardNormal(turned, 1);
    expect(n[0]).toBeCloseTo(0); expect(n[1]).toBeCloseTo(1); // faces down the screen
    // with north angle = rotation, the side still faces east in the real world
    expect(bearingName(bearingOf(n, r))).toBe('East');
    expect(planToMap(mapToPlan([3, 4], 33), 33)[0]).toBeCloseTo(3);
  });

  it('covers the view with tiles at a sensible zoom', () => {
    const { z, tiles } = tilesFor(O, 0, { x: -50, y: -40, w: 100, h: 80 }, 8);
    expect(z).toBeGreaterThanOrEqual(17);
    expect(z).toBeLessThanOrEqual(19);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(40);
    expect(tiles[0].url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
  });

  it('accepts typed coordinates instead of an address', () => {
    expect(parseLatLon('-33.8688, 151.2093')).toMatchObject({ lat: -33.8688, lon: 151.2093 });
    expect(parseLatLon('12 Example Street')).toBeNull();
  });
});
