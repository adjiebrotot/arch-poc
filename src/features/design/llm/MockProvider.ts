import type { LLMProvider, ParseRequest, ParseResult } from './types';

/** Canned responses for local development and tests. */
export class MockProvider implements LLMProvider {
  readonly name = 'mock' as const;
  private i = 0;
  constructor(private script: Omit<ParseResult, 'provider'>[] = DEFAULT_SCRIPT, private delayMs = 400) {}
  async parse(_req: ParseRequest): Promise<ParseResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.script[Math.min(this.i++, this.script.length - 1)];
    return { ...step, provider: 'mock' };
  }
}

const DEFAULT_SCRIPT: Omit<ParseResult, 'provider'>[] = [
  {
    status: 'needs_clarification',
    requirements: { area: null, floors: null, bedrooms: 3, bathrooms: null, extras: ['study'], style: 'scandinavian', notes: 'Lots of light, a home office.' },
    assistantMessage: 'Lovely — a light-filled Scandinavian home with 3 bedrooms and a study. How many bathrooms would you like?',
    missingFields: ['bathrooms'],
  },
  {
    status: 'complete',
    requirements: { area: null, floors: null, bedrooms: 3, bathrooms: 2, extras: ['study', 'laundry', 'living-back'], style: 'scandinavian', notes: 'Lots of light, a home office, living facing the garden.' },
    assistantMessage: "Perfect: 3 bedrooms, 2 bathrooms, a study, and the living room facing the garden. I've added a laundry too — check the details and generate when ready.",
    missingFields: [],
  },
];
