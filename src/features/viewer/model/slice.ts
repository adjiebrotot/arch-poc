import type { ModelData } from '@shared/model/types';

/** Horizontal section through walls/windows/doors at height y → 2D segments [x1,z1,x2,z2]. */
export function sliceModel(model: ModelData, y: number, filter = /Wall|Window|Door|Column|Railing|Stair|Curtain|Plate/): number[][] {
  const segs: number[][] = [];
  for (const e of model.elements) {
    if (!filter.test(e.type)) continue;
    const p = e.positions, idx = e.indices;
    // quick reject on Y range
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < p.length; i += 3) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    if (y < lo || y > hi) continue;
    for (let t = 0; t < idx.length; t += 3) {
      const pts: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const a = idx[t + k] * 3, b = idx[t + ((k + 1) % 3)] * 3;
        const ya = p[a + 1] - y, yb = p[b + 1] - y;
        if ((ya < 0) !== (yb < 0)) {
          const s = ya / (ya - yb);
          pts.push([p[a] + (p[b] - p[a]) * s, p[a + 2] + (p[b + 2] - p[a + 2]) * s]);
        }
      }
      if (pts.length === 2) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
    }
  }
  return segs;
}
