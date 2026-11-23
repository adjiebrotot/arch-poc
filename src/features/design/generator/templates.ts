/**
 * Templates are programmes, not buildings: each one is a brief (bedrooms, bathrooms, extras,
 * preferences) that the generator fits into whatever envelope the client drew. A template that
 * needs more space than the footprints offer is adapted down (fewer rooms) rather than forcing
 * the footprints to change.
 */
import type { PlanSpec, Site } from '@shared/planspec/schema';
import { normalizeSite, rectBoundary } from '@shared/planspec/site';
import type { Vec2 } from '@shared/util/geometry';
import { checkFeasibility, nearestFeasible, type ProgramInput } from './feasibility';
import { generatePlan, type Envelope } from './generator';

export interface Template {
  id: string;
  title: string;
  blurb: string;
  bedrooms: number;
  bathrooms: number;
  extras: string[];
}

export const TEMPLATES: Template[] = [
  { id: 'cottage', title: 'The Cottage', blurb: 'Open-plan living, 2 bed 1 bath', bedrooms: 2, bathrooms: 1, extras: ['open-plan', 'laundry'] },
  { id: 'family', title: 'The Family Home', blurb: '3 bed 2 bath with study, garage and laundry', bedrooms: 3, bathrooms: 2, extras: ['garage', 'study', 'laundry'] },
  { id: 'entertainer', title: 'The Entertainer', blurb: '4 bed 2 bath, separate dining and a family room facing the garden', bedrooms: 4, bathrooms: 2, extras: ['dining', 'family', 'laundry', 'living-back'] },
  { id: 'townhouse', title: 'The Townhouse', blurb: '3 bed 2 bath, garage and powder room, bedrooms upstairs', bedrooms: 3, bathrooms: 2, extras: ['garage', 'laundry', 'powder'] },
];

/** How a template fits an envelope: as is, adapted to fewer rooms, or not at all. */
export function fitTemplate(t: Template, env: Pick<ProgramInput, 'area' | 'floors' | 'plates'>): { brief: Pick<Template, 'bedrooms' | 'bathrooms' | 'extras'>; adapted: boolean; ok: boolean; reason?: string } {
  const p: ProgramInput = { ...env, bedrooms: t.bedrooms, bathrooms: t.bathrooms, extras: t.extras };
  const f = checkFeasibility(p);
  if (f.ok) return { brief: { bedrooms: t.bedrooms, bathrooms: t.bathrooms, extras: t.extras }, adapted: false, ok: true };
  const n = nearestFeasible(p);
  if (n.suggestion) return { brief: { bedrooms: n.suggestion.bedrooms, bathrooms: n.suggestion.bathrooms, extras: n.suggestion.extras }, adapted: true, ok: true, reason: f.reason };
  return { brief: { bedrooms: t.bedrooms, bathrooms: t.bathrooms, extras: t.extras }, adapted: false, ok: false, reason: f.reason };
}

// ---- demo envelopes (sample content and tests) -------------------------------------------------

const lot = (w: number, d: number): Site => normalizeSite({ width: w, depth: d, northAngle: 0, boundary: rectBoundary(0, 0, w, d), roads: [{ edge: 2 }], entrance: { edge: 2, t: 0.5 }, source: 'grid' });

/** An L-shaped single-storey home on a 24 × 34 m lot (street at the bottom). */
export function demoEnvelope(kind: 'family' | 'townhouse' | 'cottage' = 'family'): Envelope {
  if (kind === 'townhouse') {
    const g: Vec2[] = [[3, 8], [15, 8], [15, 22], [3, 22]];
    const u: Vec2[] = [[3, 8], [15, 8], [15, 18], [3, 18]];
    return { site: lot(18, 30), floors: [{ level: 0, height: 2.7, footprint: g }, { level: 1, height: 2.7, footprint: u }] };
  }
  if (kind === 'cottage') {
    return { site: lot(16, 26), floors: [{ level: 0, height: 2.7, footprint: [[3, 7], [13, 7], [13, 16], [3, 16]] }] };
  }
  return { site: lot(24, 34), floors: [{ level: 0, height: 2.7, footprint: [[3, 6], [21, 6], [21, 20], [12, 20], [12, 26], [3, 26]] }] };
}

/** A ready-made plan for a template on its demo envelope (samples, tests). */
export function templatePlan(id: string, seed = 7): PlanSpec {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  const env = demoEnvelope(id === 'townhouse' ? 'townhouse' : id === 'cottage' ? 'cottage' : 'family');
  return generatePlan({ envelope: env, bedrooms: t.bedrooms, bathrooms: t.bathrooms, extras: t.extras, seed, title: t.title });
}
