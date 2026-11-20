import type { Floor, Wall, Opening } from '@shared/planspec/schema';
import { ROOM_COLORS } from '@shared/planspec/schema';
import { polygonCentroid } from '@shared/util/geometry';

export function floorBounds(f: Floor, pad = 0.6) {
  const xs: number[] = [], ys: number[] = [];
  for (const w of f.walls) { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); }
  for (const r of f.rooms) for (const p of r.polygon) { xs.push(p[0]); ys.push(p[1]); }
  if (!xs.length) return { x: -5, y: -5, w: 10, h: 10 };
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
}

export function openingGeometry(w: Wall, o: Opening) {
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
  const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
  const c = Math.min(Math.max(o.offset, o.width / 2), len - o.width / 2);
  const p0: [number, number] = [w.a[0] + ux * (c - o.width / 2), w.a[1] + uy * (c - o.width / 2)];
  const p1: [number, number] = [w.a[0] + ux * (c + o.width / 2), w.a[1] + uy * (c + o.width / 2)];
  return { p0, p1, ux, uy, nx: -uy, ny: ux, center: [w.a[0] + ux * c, w.a[1] + uy * c] as [number, number] };
}

/** Static SVG for thumbnails, exports and tests. */
export function floorToSvg(f: Floor, opts: { labels?: boolean; width?: number; areas?: boolean } = {}): string {
  const b = floorBounds(f);
  const parts: string[] = [];
  for (const r of f.rooms) {
    parts.push(`<polygon points="${r.polygon.map((p) => p.join(',')).join(' ')}" fill="${ROOM_COLORS[r.type] ?? '#eee'}"/>`);
  }
  for (const w of f.walls) {
    parts.push(`<line x1="${w.a[0]}" y1="${w.a[1]}" x2="${w.b[0]}" y2="${w.b[1]}" stroke="#1F2326" stroke-width="${w.thickness}" stroke-linecap="square"/>`);
  }
  const wallById = new Map(f.walls.map((w) => [w.id, w]));
  for (const o of f.openings) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const g = openingGeometry(w, o);
    const t = w.thickness + 0.02;
    if (o.type === 'door') {
      parts.push(`<line x1="${g.p0[0]}" y1="${g.p0[1]}" x2="${g.p1[0]}" y2="${g.p1[1]}" stroke="#FBFAF7" stroke-width="${t}"/>`);
      if (o.width < 1.3) {
        const r = o.width;
        const tip = [g.p0[0] + g.nx * r, g.p0[1] + g.ny * r];
        parts.push(`<path d="M${g.p1[0]},${g.p1[1]} A${r},${r} 0 0 0 ${tip[0]},${tip[1]} L${g.p0[0]},${g.p0[1]}" fill="none" stroke="#8A8F93" stroke-width="0.03"/>`);
      }
    } else {
      parts.push(`<line x1="${g.p0[0]}" y1="${g.p0[1]}" x2="${g.p1[0]}" y2="${g.p1[1]}" stroke="#FBFAF7" stroke-width="${t}"/>`);
      parts.push(`<line x1="${g.p0[0]}" y1="${g.p0[1]}" x2="${g.p1[0]}" y2="${g.p1[1]}" stroke="#4E8FB0" stroke-width="0.06"/>`);
    }
  }
  if (opts.labels) {
    for (const r of f.rooms) {
      const c = polygonCentroid(r.polygon);
      const fs = Math.min(0.42, Math.max(0.22, Math.sqrt(r.area) * 0.09));
      parts.push(`<text x="${c[0]}" y="${c[1]}" font-size="${fs}" text-anchor="middle" fill="#1F2326" font-family="Inter Variable, system-ui, sans-serif">${esc(r.name)}</text>`);
      if (opts.areas) parts.push(`<text x="${c[0]}" y="${c[1] + fs * 1.2}" font-size="${fs * 0.8}" text-anchor="middle" fill="#5B6166" font-family="Inter Variable, system-ui, sans-serif">${r.area.toFixed(1)} m²</text>`);
    }
  }
  const width = opts.width ? ` width="${opts.width}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}"${width} role="img"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#FBFAF7"/>${parts.join('')}</svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
