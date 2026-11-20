import { type LLMProvider, type ParseRequest, type ParseResult, type ParsedRequirements, type Essential, emptyRequirements, missingOf, sanitizeRequirements } from './types';

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, double: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = '(\\d+|a|an|one|single|two|double|three|four|five|six|seven|eight)';
const toNum = (s: string) => (/^\d/.test(s) ? parseInt(s, 10) : WORDS[s.toLowerCase()] ?? NaN);

const STYLES = ['modern', 'contemporary', 'scandinavian', 'industrial', 'coastal', 'farmhouse', 'minimalist', 'minimal', 'mid-century', 'traditional', 'japandi', 'hamptons', 'rustic', 'mediterranean'];

const QUESTIONS: Record<Essential, string> = {
  bedrooms: 'How many bedrooms would you like?',
  bathrooms: 'And how many bathrooms?',
  area: 'Roughly how big should the home be? A floor area in m² is perfect (a typical family home is 120–180 m²).',
  floors: 'Would you like everything on one level, or two or three storeys?',
};
const ASK_HINT: Record<Essential, RegExp> = {
  bedrooms: /bedroom/i, bathrooms: /bathroom/i, area: /how big|floor area|m²/i, floors: /level|storey/i,
};

function parseText(t: string, r: ParsedRequirements, asked: Essential | null) {
  const s = t.toLowerCase().replace(/,/g, '');
  const area = s.match(/(\d{2,4}(?:\.\d+)?)\s*(?:m2|m²|sqm|sq\.?\s?m\b|square\s?met(?:re|er)s?|met(?:re|er)s?\s?squared)/);
  const ft = s.match(/(\d{3,5})\s*(?:sq\.?\s?ft|square\s?f(?:ee|oo)t|sqft|ft2)/);
  if (area) r.area = parseFloat(area[1]);
  else if (ft) r.area = Math.round(parseFloat(ft[1]) * 0.0929);

  const fl = s.match(new RegExp(`${NUM}[\\s-]*(?:storey|story|stories|storeys|level|levels|floor|floors)\\b`));
  if (fl) r.floors = toNum(fl[1]);
  if (/\b(single[\s-]?(?:storey|story|level)|one level|all on one|bungalow|ground floor only)\b/.test(s)) r.floors = 1;
  if (/\b(double[\s-]?storey|two[\s-]?storey|townhouse)\b/.test(s)) r.floors = 2;

  const bd = s.match(new RegExp(`${NUM}[\\s-]*(?:bed(?:room)?s?|br)\\b`));
  if (bd) r.bedrooms = toNum(bd[1]);
  const ba = s.match(new RegExp(`${NUM}[\\s-]*(?:bath(?:room)?s?|ba)\\b`));
  if (ba) r.bathrooms = toNum(ba[1]);

  const neg = (w: string) => new RegExp(`\\b(?:no|without|don'?t (?:need|want)(?: a| an)?|skip(?: the)?)\\s+(?:a |an |the )?${w}`).test(s);
  const extras: [string, RegExp][] = [
    ['study', /\b(study|home office|office|workspace|library)\b/],
    ['garage', /\b(garage|carport)\b/],
    ['laundry', /\b(laundry|utility room)\b/],
    ['open-plan', /\bopen[\s-]?plan\b/],
  ];
  for (const [id, re] of extras) {
    const word = re.source.replace(/\\b|\(|\)/g, '').split('|')[0];
    if (re.test(s)) {
      if (neg(word) || neg(id)) r.extras = r.extras.filter((e) => e !== id);
      else if (!r.extras.includes(id)) r.extras.push(id);
    }
  }
  const style = STYLES.find((st) => s.includes(st));
  if (style) r.style = style;

  // A bare answer to the question we just asked ("3", "about 150", "two").
  if (asked) {
    const bare = s.match(/^(?:about|around|maybe|roughly|~)?\s*(\d+(?:\.\d+)?|one|two|three|four|five|six)\b/);
    if (bare && r[asked] === null) {
      const n = toNum(bare[1]);
      if (Number.isFinite(n) && (asked !== 'area' || n >= 20)) r[asked] = n;
    }
  }
}

/** Offline fallback: regex/keyword parsing. Always available, deterministic. */
export class RuleBasedProvider implements LLMProvider {
  readonly name = 'rule-based' as const;

  async parse(req: ParseRequest): Promise<ParseResult> {
    const r = emptyRequirements();
    let asked: Essential | null = null;
    const notes: string[] = [];
    for (const m of req.messages) {
      if (m.role === 'assistant') {
        asked = (Object.keys(ASK_HINT) as Essential[]).find((k) => ASK_HINT[k].test(m.content.split('\n').pop() ?? '')) ?? null;
        continue;
      }
      parseText(m.content, r, asked);
      if (m.content.length > 25) notes.push(m.content.trim());
      asked = null;
    }
    r.notes = notes.join(' ').slice(0, 500);
    const requirements = sanitizeRequirements(r);
    const missingFields = missingOf(requirements);
    const got: string[] = [];
    if (requirements.bedrooms) got.push(`${requirements.bedrooms} bedroom${requirements.bedrooms > 1 ? 's' : ''}`);
    if (requirements.bathrooms) got.push(`${requirements.bathrooms} bathroom${requirements.bathrooms > 1 ? 's' : ''}`);
    if (requirements.area) got.push(`about ${requirements.area} m²`);
    if (requirements.floors) got.push(requirements.floors === 1 ? 'on one level' : `over ${requirements.floors} storeys`);
    const prefix = got.length ? `Got it — ${got.join(', ')}${requirements.extras.length ? ' plus ' + requirements.extras.join(', ') : ''}.` : "Thanks! Let's pin down the basics.";
    const assistantMessage = missingFields.length
      ? `${prefix}\n${QUESTIONS[missingFields[0]]}`
      : `${prefix} That's everything I need. Check the details below and tap "Generate layouts" when you're ready.`;
    return { status: missingFields.length ? 'needs_clarification' : 'complete', requirements, assistantMessage, missingFields, provider: 'rule-based' };
  }
}
