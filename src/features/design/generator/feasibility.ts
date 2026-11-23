/**
 * Feasibility rules for the Template and Tell us modes. All numbers live here so the firm can tune
 * them without touching UI code.
 *
 * The envelope (lot, floors, footprints) is drawn by the client first, so the floor area and the
 * number of floors are facts, not choices: these checks say which briefs fit inside it.
 */
import type { PlanSpec } from '@shared/planspec/schema';
import { footprintArea } from '@shared/planspec/envelope';

export const FEASIBILITY = {
  /** Minimum net room areas in m². */
  minArea: {
    master: 12,
    bedroom: 9,
    bathroom: 4,
    kitchen: 6,
    living: 14,
    study: 7,
    garage: 18,
    laundry: 4,
    dining: 9,
    family: 12,
    powder: 2.2,
  },
  /** Hallways and circulation, as a share of the net room area. */
  circulation: 0.15,
  /** Allowance for wall thickness, as a share of the area incl. circulation. */
  wallAllowance: 0.12,
  /** Stairs footprint in m², added once per extra floor (2.25 × 3 m dog-leg stair). */
  stairsPerExtraFloor: 7,
  /** Open-plan living merges kitchen + living and saves a wall's worth of space. */
  openPlanSaving: 2,
  /** The ground floor must be at least this big to be buildable. */
  minFloorPlate: 28,
  /** Upper floors hold the stairs, a landing and at least one room. */
  minUpperPlate: 16,
  ranges: {
    area: { min: 30, max: 600 },
    floors: { min: 1, max: 3 },
    bedrooms: { min: 1, max: 6 },
    bathrooms: { min: 1, max: 4 },
  },
} as const;

/** Rooms you can add (`area` > 0) and preferences that only change the arrangement. */
export const EXTRAS = [
  { id: 'study', label: 'Study', icon: '📚', area: FEASIBILITY.minArea.study, kind: 'room' },
  { id: 'garage', label: 'Garage', icon: '🚗', area: FEASIBILITY.minArea.garage, kind: 'room' },
  { id: 'laundry', label: 'Laundry', icon: '🧺', area: FEASIBILITY.minArea.laundry, kind: 'room' },
  { id: 'dining', label: 'Separate dining', icon: '🍽️', area: FEASIBILITY.minArea.dining, kind: 'room' },
  { id: 'family', label: 'Family room', icon: '📺', area: FEASIBILITY.minArea.family, kind: 'room' },
  { id: 'powder', label: 'Powder room', icon: '🚽', area: FEASIBILITY.minArea.powder, kind: 'room' },
  { id: 'open-plan', label: 'Open-plan living', icon: '🛋️', area: -FEASIBILITY.openPlanSaving, kind: 'pref' },
  { id: 'master-ground', label: 'Main bedroom downstairs', icon: '🛏️', area: 0, kind: 'pref' },
  { id: 'living-back', label: 'Living faces the back garden', icon: '🌳', area: 0, kind: 'pref' },
] as const;
export type ExtraId = (typeof EXTRAS)[number]['id'];
export const EXTRA_IDS = EXTRAS.map((e) => e.id) as ExtraId[];

export const LAYOUTS = [
  { id: '1b1b', bedrooms: 1, bathrooms: 1 },
  { id: '2b1b', bedrooms: 2, bathrooms: 1 },
  { id: '2b2b', bedrooms: 2, bathrooms: 2 },
  { id: '3b1b', bedrooms: 3, bathrooms: 1 },
  { id: '3b2b', bedrooms: 3, bathrooms: 2 },
  { id: '4b2b', bedrooms: 4, bathrooms: 2 },
  { id: '4b3b', bedrooms: 4, bathrooms: 3 },
  { id: '5b3b', bedrooms: 5, bathrooms: 3 },
] as const;
export type LayoutId = (typeof LAYOUTS)[number]['id'];
export const layoutLabel = (b: number, ba: number) => `${b} bed · ${ba} bath`;

export interface ProgramInput {
  /** gross floor area in m² (all footprints together) */
  area: number;
  floors: number;
  bedrooms: number;
  bathrooms: number;
  extras: string[];
  /** footprint area of each floor, ground first (when the envelope is known) */
  plates?: number[];
}

export interface FeasibilityResult {
  ok: boolean;
  required: number;
  /** Friendly, non-technical reason when not ok. */
  reason?: string;
}

const roundUp5 = (v: number) => Math.ceil(v / 5) * 5;

/** The client's envelope as feasibility inputs: total footprint area, floors and each floor's area. */
export function envelopeOf(plan: Pick<PlanSpec, 'floors'>): { area: number; floors: number; plates: number[] } {
  const plates = plan.floors.map((f) => Math.round(footprintArea(f.footprint)));
  return { area: plates.reduce((a, b) => a + b, 0), floors: plates.length, plates };
}

/** Net minimum area of the rooms themselves. */
export function netProgramArea(p: Omit<ProgramInput, 'area'>): number {
  const m = FEASIBILITY.minArea;
  let net = m.living + m.kitchen + m.bathroom * Math.max(1, p.bathrooms);
  if (p.bedrooms >= 1) net += m.master + m.bedroom * (p.bedrooms - 1);
  for (const e of p.extras) {
    const ex = EXTRAS.find((x) => x.id === e);
    if (ex) net += ex.area;
  }
  return net;
}

/** Gross area required: rooms + circulation + walls + stairs. */
export function requiredArea(p: Omit<ProgramInput, 'area'>): number {
  const net = netProgramArea(p);
  const gross = net * (1 + FEASIBILITY.circulation) * (1 + FEASIBILITY.wallAllowance);
  return Math.round(gross + FEASIBILITY.stairsPerExtraFloor * Math.max(0, p.floors - 1));
}

export function checkFeasibility(p: ProgramInput): FeasibilityResult {
  const r = FEASIBILITY.ranges;
  const required = requiredArea(p);
  if (p.bathrooms > p.bedrooms + 1)
    return { ok: false, required, reason: 'More bathrooms than bedrooms + 1 is unusual — try fewer bathrooms.' };
  if (p.area < r.area.min) return { ok: false, required, reason: `Homes start at about ${r.area.min} m².` };
  if (p.plates?.length) {
    if (p.plates[0] < FEASIBILITY.minFloorPlate) return { ok: false, required, reason: `The ground floor is under ${FEASIBILITY.minFloorPlate} m² — make its footprint bigger.` };
    const small = p.plates.findIndex((a, i) => i > 0 && a < FEASIBILITY.minUpperPlate);
    if (small > 0) return { ok: false, required, reason: `Level ${small + 1} is under ${FEASIBILITY.minUpperPlate} m², too small for the stairs and a room.` };
  } else if (p.area / p.floors < FEASIBILITY.minFloorPlate) {
    return { ok: false, required, reason: `Each floor would be under ${FEASIBILITY.minFloorPlate} m² — try fewer floors.` };
  }
  if (required > p.area) return { ok: false, required, reason: `Needs ~${roundUp5(required)} m²+` };
  return { ok: true, required };
}

export function layoutOptions(area: number, floors: number, extras: string[], plates?: number[]) {
  return LAYOUTS.map((l) => {
    const f = checkFeasibility({ area, floors, bedrooms: l.bedrooms, bathrooms: l.bathrooms, extras, plates });
    return { ...l, label: layoutLabel(l.bedrooms, l.bathrooms), enabled: f.ok, reason: f.reason, required: f.required };
  });
}

export function extraOptions(area: number, floors: number, bedrooms: number, bathrooms: number, extras: string[], plates?: number[]) {
  return EXTRAS.filter((e) => e.id !== 'master-ground' || floors > 1).map((e) => {
    const selected = extras.includes(e.id);
    const withIt = selected ? extras : [...extras, e.id];
    const f = checkFeasibility({ area, floors, bedrooms, bathrooms, extras: withIt, plates });
    return { ...e, selected, enabled: selected || f.ok, reason: f.ok ? undefined : `${f.reason?.replace('+', '')}+ with this layout` };
  });
}

/**
 * Suggest the closest brief that fits the envelope: keep as many bedrooms, then bathrooms, then
 * extras as possible. The area and floors are the client's footprints, so they never change here;
 * the message says how much area the original brief would need instead.
 */
export function nearestFeasible(p: ProgramInput): { suggestion: ProgramInput | null; areaNeeded: number; message: string } {
  const areaNeeded = roundUp5(requiredArea(p));
  const extras = p.extras;
  let best: ProgramInput | null = null, bestScore = -1;
  for (let b = p.bedrooms; b >= 1; b--) {
    for (let ba = Math.min(p.bathrooms, b + 1); ba >= 1; ba--) {
      for (let mask = (1 << extras.length) - 1; mask >= 0; mask--) {
        const ex = extras.filter((_, i) => mask & (1 << i));
        const q = { ...p, bedrooms: b, bathrooms: ba, extras: ex };
        if (!checkFeasibility(q).ok) continue;
        const score = b * 1000 + ba * 100 + ex.length * 10;
        if (score > bestScore) { bestScore = score; best = q; }
      }
    }
  }
  const parts: string[] = [];
  if (best) parts.push(`In ${p.area} m², ${describe(best)} fits comfortably.`);
  parts.push(`To keep ${describe(p)}, the footprints would need about ${areaNeeded} m² in total.`);
  return { suggestion: best, areaNeeded, message: parts.join(' ') };
}

export function describe(p: Omit<ProgramInput, 'area'>): string {
  const ex = p.extras.map((e) => EXTRAS.find((x) => x.id === e)).filter((e) => e && e.kind === 'room').map((e) => e!.label.toLowerCase());
  return `${p.bedrooms} bed ${p.bathrooms} bath${p.floors > 1 ? ` over ${p.floors} floors` : ''}${ex.length ? ' + ' + ex.join(', ') : ''}`;
}
