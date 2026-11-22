import type { Floor, Wall, Opening, Site } from '@shared/planspec/schema';
import { ROOM_COLORS } from '@shared/planspec/schema';
import { polygonCentroid } from '@shared/util/geometry';
import { roadShapes, entrancePoint, bounds } from '@shared/planspec/site';

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
export function floorToSvg(f: Floor, opts: { labels?: boolean; width?: number; areas?: boolean; site?: Site } = {}): string {
  let b = floorBounds(f);
  const parts: string[] = [];
  const pts = (p: [number, number][]) => p.map((q) => q.join(',')).join(' ');
  const st = opts.site?.boundary ? opts.site : undefined;
  if (st) {
    const roads = roadShapes(st);
    const all = [...st.boundary!, ...roads.flatMap((r) => r.asphalt), [b.x, b.y] as [number, number], [b.x + b.w, b.y + b.h] as [number, number]];
    const bb = bounds(all);
    b = { x: bb.x - 1, y: bb.y - 1, w: bb.w + 2, h: bb.h + 2 };
    for (const r of roads) {
      parts.push(`<polygon points="${pts(r.asphalt)}" fill="#C4C1BB"/><polygon points="${pts(r.verge)}" fill="#E6E2DA"/>`);
      parts.push(`<line x1="${r.centre[0][0]}" y1="${r.centre[0][1]}" x2="${r.centre[1][0]}" y2="${r.centre[1][1]}" stroke="#fff" stroke-width="0.12" stroke-dasharray="1.5 1.5"/>`);
      parts.push(`<text x="${r.label[0]}" y="${r.label[1]}" dy="0.2" transform="rotate(${r.labelAngle} ${r.label[0]} ${r.label[1]})" font-size="${Math.min(0.6, r.width * 0.3)}" text-anchor="middle" fill="#4A5055" font-weight="600" font-family="Inter Variable, system-ui, sans-serif">${esc(r.name.toUpperCase())}</text>`);
    }
    parts.push(`<polygon points="${pts(st.boundary!)}" fill="#EEF2E8" stroke="#7F9A6E" stroke-width="0.06" stroke-dasharray="0.4 0.25"/>`);
  }
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
  if (st) {
    const e = entrancePoint(st);
    if (e) {
      const ang = (Math.atan2(-e.n[1], -e.n[0]) * 180) / Math.PI;
      parts.push(`<g transform="translate(${e.p[0]} ${e.p[1]}) rotate(${ang})"><path d="M-1.4 -0.28 L-0.2 -0.28 L-0.2 -0.65 L0.65 0 L-0.2 0.65 L-0.2 0.28 L-1.4 0.28 Z" fill="#A4502F"/></g>`);
    }
    // north arrow, top-right
    const r = Math.max(0.8, Math.min(b.w, b.h) * 0.04);
    const ncx = b.x + b.w - r * 1.6, ncy = b.y + r * 1.6;
    parts.push(`<g transform="translate(${ncx} ${ncy}) rotate(${st.northAngle})"><circle r="${r}" fill="#fff" stroke="#B9B3A8" stroke-width="${r * 0.05}"/><path d="M0 ${-r * 0.8} L${r * 0.25} 0 L${-r * 0.25} 0 Z" fill="#A4502F"/><path d="M0 ${r * 0.8} L${r * 0.25} 0 L${-r * 0.25} 0 Z" fill="#CFC9BE"/><text y="${-r * 1.05}" font-size="${r * 0.5}" text-anchor="middle" font-weight="800" fill="#A4502F" font-family="Inter Variable, system-ui, sans-serif">N</text></g>`);
  }
  const width = opts.width ? ` width="${opts.width}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}"${width} role="img"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#FBFAF7"/>${parts.join('')}</svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
