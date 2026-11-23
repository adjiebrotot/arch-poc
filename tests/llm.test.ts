import { describe, it, expect, vi } from 'vitest';
import { WorkerProvider, RuleBasedProvider, MockProvider, FallbackProvider, SCHEMA_VERSION, type ParseRequest } from '../src/features/design/llm';

const req = (...msgs: string[]): ParseRequest => ({
  sessionId: '00000000-0000-4000-8000-000000000000',
  messages: msgs.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })),
  schemaVersion: SCHEMA_VERSION,
  locale: 'en-AU',
});

const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const good = {
  status: 'complete',
  requirements: { area: 152, floors: 1, bedrooms: 3, bathrooms: 2, extras: ['Home office', 'garage', 'pool'], style: 'modern', notes: 'north light' },
  assistantMessage: 'Great!',
  missingFields: [],
};

describe('WorkerProvider', () => {
  it('posts the contract body (no keys) and validates + clamps the response', async () => {
    const f = ok(good);
    const p = new WorkerProvider('https://w.example.com/', f as unknown as typeof fetch);
    const r = await p.parse(req('3 bed 2 bath modern'));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://w.example.com/parse');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['locale', 'messages', 'schemaVersion', 'sessionId']);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|api[-_]?key/i);
    expect(r.requirements.area).toBe(150); // rounded to 5
    expect(r.requirements.extras).toEqual(['study', 'garage']); // whitelisted & mapped
    expect(r.status).toBe('complete');
  });

  it('caps history at 20 messages', async () => {
    const f = ok(good);
    await new WorkerProvider('https://w', f as unknown as typeof fetch).parse(req(...Array.from({ length: 30 }, (_, i) => `m${i}`)));
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages).toHaveLength(20);
  });

  it('clamps out-of-range values and never trusts status when essentials are missing', async () => {
    const f = ok({ ...good, requirements: { ...good.requirements, area: 99999, bedrooms: 40, bathrooms: null }, status: 'complete' });
    const r = await new WorkerProvider('https://w', f as unknown as typeof fetch).parse(req('x'));
    expect(r.requirements.area).toBe(600);
    expect(r.requirements.bedrooms).toBe(6);
    expect(r.status).toBe('needs_clarification');
    expect(r.missingFields).toEqual(['bathrooms']);
  });

  it('rejects malformed responses', async () => {
    const f = ok({ hello: 'world' });
    await expect(new WorkerProvider('https://w', f as unknown as typeof fetch).parse(req('x'))).rejects.toMatchObject({ code: 'invalid_schema' });
  });

  it('maps 429 to rate_limited', async () => {
    const f = ok({ error: { code: 'rate_limited', message: 'slow down' } }, 429);
    await expect(new WorkerProvider('https://w', f as unknown as typeof fetch).parse(req('x'))).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('times out', async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    await expect(new WorkerProvider('https://w', f as unknown as typeof fetch, 30).parse(req('x'))).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('FallbackProvider', () => {
  it('falls back to rule-based parsing on 429 and flags degraded mode', async () => {
    const chain = new FallbackProvider(new WorkerProvider('https://w', ok({ error: { code: 'rate_limited', message: '' } }, 429) as unknown as typeof fetch));
    const r = await chain.parse(req('We need 3 bedrooms and 2 bathrooms, about 150 m2, single storey'));
    expect(r.provider).toBe('rule-based');
    expect(r.degraded).toBe(true);
    expect(r.requirements).toMatchObject({ bedrooms: 3, bathrooms: 2, area: 150, floors: 1 });
  });

  it('uses rule-based when no Worker URL is configured', async () => {
    const r = await new FallbackProvider(null).parse(req('2 bed'));
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe('not-configured');
  });
});

describe('RuleBasedProvider', () => {
  const p = new RuleBasedProvider();
  it('extracts requirements from free text', async () => {
    const r = await p.parse(req('Hi! We are a family of four. We want a modern two-storey home with four bedrooms, 3 bathrooms, a home office and a double garage. Around 2000 sq ft.'));
    expect(r.requirements).toMatchObject({ floors: 2, bedrooms: 4, bathrooms: 3, style: 'modern', area: 185 });
    expect(r.requirements.extras.sort()).toEqual(['garage', 'study']);
    expect(r.status).toBe('complete');
  });
  it('asks for missing essentials and understands bare answers', async () => {
    const r1 = await p.parse(req('3 bedroom house with a garage'));
    expect(r1.missingFields).toContain('bathrooms');
    const r2 = await p.parse(req('3 bedroom house with a garage', r1.assistantMessage, '2'));
    expect(r2.requirements[r1.missingFields[0]]).toBe(2);
  });
  it('handles negations', async () => {
    const r = await p.parse(req('2 bed 1 bath, 90m2, no garage, open plan please'));
    expect(r.requirements.extras).toEqual(['open-plan']);
  });
});

describe('MockProvider', () => {
  it('returns canned responses in order', async () => {
    const m = new MockProvider(undefined, 0);
    expect((await m.parse(req('a'))).status).toBe('needs_clarification');
    expect((await m.parse(req('a'))).status).toBe('complete');
  });
});

describe('rule-based parser: rooms and how they relate', async () => {
  const { RuleBasedProvider } = await import('../src/features/design/llm');
  const rb = new RuleBasedProvider();
  const ask = (text: string) => rb.parse({ sessionId: 's', messages: [{ role: 'user', content: text }], schemaVersion: 'requirements-1.0', locale: 'en-AU' });

  it('only needs bedrooms and bathrooms: size and storeys come from the drawn floors', async () => {
    const r = await ask('3 bedrooms and 2 bathrooms please');
    expect(r.status).toBe('complete');
    expect(r.missingFields).toEqual([]);
  });

  it('understands extra rooms and room relationships', async () => {
    const r = await ask('4 bed 2 bath with a family room and a powder room, main bedroom downstairs and the living room facing the back garden');
    expect(r.requirements.extras).toEqual(expect.arrayContaining(['family', 'powder', 'master-ground', 'living-back']));
  });
});
