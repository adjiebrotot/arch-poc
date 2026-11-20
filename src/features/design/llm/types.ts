import { z } from 'zod';
import { FEASIBILITY, EXTRA_IDS } from '../generator/feasibility';

export const SCHEMA_VERSION = 'requirements-1.0';
export const MAX_HISTORY = 20;
export const TIMEOUT_MS = 15_000;

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ParseRequest {
  sessionId: string;
  messages: ChatMessage[];
  schemaVersion: typeof SCHEMA_VERSION;
  locale: string;
}

export interface ParsedRequirements {
  area: number | null;
  floors: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  extras: string[];
  style: string | null;
  notes: string;
}

export const ESSENTIALS = ['bedrooms', 'bathrooms', 'area', 'floors'] as const;
export type Essential = (typeof ESSENTIALS)[number];

export interface ParseResult {
  status: 'complete' | 'needs_clarification';
  requirements: ParsedRequirements;
  assistantMessage: string;
  missingFields: Essential[];
  provider: 'worker' | 'rule-based' | 'mock';
  /** true when we fell back from the Worker to the local parser */
  degraded?: boolean;
  degradedReason?: string;
}

export interface LLMProvider {
  readonly name: ParseResult['provider'];
  parse(req: ParseRequest, signal?: AbortSignal): Promise<ParseResult>;
}

/** Exact shape the Worker must return (see docs/llm-worker-contract.md). */
export const WorkerResponseSchema = z.object({
  status: z.enum(['complete', 'needs_clarification']),
  requirements: z.object({
    area: z.number().nullable(),
    floors: z.number().nullable(),
    bedrooms: z.number().nullable(),
    bathrooms: z.number().nullable(),
    extras: z.array(z.string()),
    style: z.string().nullable(),
    notes: z.string(),
  }),
  assistantMessage: z.string(),
  missingFields: z.array(z.string()),
});

export const WorkerErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const EXTRA_SYNONYMS: Record<string, string> = {
  study: 'study', office: 'study', 'home office': 'study', 'home-office': 'study', library: 'study',
  garage: 'garage', carport: 'garage', 'car park': 'garage', parking: 'garage',
  laundry: 'laundry', 'utility room': 'laundry', utility: 'laundry',
  'open-plan': 'open-plan', 'open plan': 'open-plan', 'open_plan': 'open-plan', 'open-plan living': 'open-plan', 'open plan living': 'open-plan',
};

const clampInt = (v: number | null, lo: number, hi: number) =>
  v === null || !Number.isFinite(v) ? null : Math.min(hi, Math.max(lo, Math.round(v)));

/**
 * Never trust the model: clamp numbers into sensible ranges, map/whitelist
 * extras, and trim free text. Output is always plain text (rendered as text).
 */
export function sanitizeRequirements(r: z.infer<typeof WorkerResponseSchema>['requirements']): ParsedRequirements {
  const R = FEASIBILITY.ranges;
  const extras = [...new Set(r.extras.map((e) => EXTRA_SYNONYMS[e.trim().toLowerCase()] ?? '').filter((e) => (EXTRA_IDS as string[]).includes(e)))];
  const area = r.area === null || !Number.isFinite(r.area) ? null : Math.min(R.area.max, Math.max(R.area.min, Math.round(r.area / 5) * 5));
  return {
    area,
    floors: clampInt(r.floors, R.floors.min, R.floors.max),
    bedrooms: clampInt(r.bedrooms, R.bedrooms.min, R.bedrooms.max),
    bathrooms: clampInt(r.bathrooms, R.bathrooms.min, R.bathrooms.max),
    extras,
    style: r.style ? r.style.replace(/[<>]/g, '').trim().slice(0, 40) || null : null,
    notes: r.notes.replace(/[<>]/g, '').trim().slice(0, 500),
  };
}

export function missingOf(r: ParsedRequirements): Essential[] {
  return ESSENTIALS.filter((k) => r[k] === null);
}

export function emptyRequirements(): ParsedRequirements {
  return { area: null, floors: null, bedrooms: null, bathrooms: null, extras: [], style: null, notes: '' };
}
