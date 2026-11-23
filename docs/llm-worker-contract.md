# LLM Worker contract (`/parse`)

The “Just tell us” mode turns a client's free-text wishes into a structured
brief. By the time the chat starts the client has already drawn their lot and the
footprint of every floor, so the floor area and number of floors are known: the
brief is about what goes **inside** (rooms and how they relate). The browser **never** talks to an LLM provider directly and **never holds
keys**. It calls a Cloudflare Worker that the firm builds and runs separately.
This document is the contract that Worker must implement. The client side is in
`src/features/design/llm/WorkerProvider.ts`.

## Configuration

| Where | What |
|---|---|
| Build-time env var | `VITE_LLM_WORKER_URL`, the Worker's base URL with no trailing slash, e.g. `https://linea-llm.example.workers.dev` |
| GitHub Actions | Repository **variable** (not a secret) `VITE_LLM_WORKER_URL`, read by `.github/workflows/deploy.yml` |
| Not configured | The site uses the built-in rule-based parser and shows “Offline mode – simplified parsing” |

The URL is public: it ends up in the JavaScript bundle. Everything sensitive,
such as API keys, model choice (a Gemma-family model or similar), the system
prompt, JSON-schema enforcement and rate limiting, lives **inside the Worker**.

## Request

```http
POST {VITE_LLM_WORKER_URL}/parse
Content-Type: application/json
```

```json
{
  "sessionId": "8f6c1d1e-2f0e-4a59-9a0b-6f1d8c2b7e11",
  "messages": [
    { "role": "user", "content": "We'd like 3 bedrooms and a study, about 150 m2" },
    { "role": "assistant", "content": "Lovely! Would you like everything on one level?" },
    { "role": "user", "content": "Yes, single storey please" }
  ],
  "schemaVersion": "requirements-1.0",
  "locale": "en-AU"
}
```

* `messages` holds the conversation, oldest first. The client caps it at the **last 20 messages**.
* `sessionId` is a UUID that stays the same for one browser tab session. Use it for rate limiting and logs, not for auth.
* The client sends no `Authorization` header, cookies or keys.

## Response 200

```json
{
  "status": "needs_clarification",
  "requirements": {
    "area": 150,
    "floors": 1,
    "bedrooms": 3,
    "bathrooms": null,
    "extras": ["study"],
    "style": "scandinavian",
    "notes": "Lots of natural light; works from home."
  },
  "assistantMessage": "Great — and how many bathrooms would you like?",
  "missingFields": ["bathrooms"]
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | `"complete" \| "needs_clarification"` | `complete` once bedrooms and bathrooms are known |
| `requirements.area` | `number \| null` | Gross floor area in m², if the client mentions one. Informational only: the drawn footprints set the size, and the client says so when they differ |
| `requirements.floors` | `number \| null` | 1–3, if mentioned. Informational only, like `area` |
| `requirements.bedrooms` | `number \| null` | 1–6 |
| `requirements.bathrooms` | `number \| null` | 1–4 |
| `requirements.extras` | `string[]` | Known ids. Rooms: `study`, `garage`, `laundry`, `dining`, `family`, `powder`. Preferences (how rooms relate): `open-plan`, `master-ground` (main bedroom downstairs), `living-back` (living areas face the back garden). Synonyms such as “home office”, “carport”, “rumpus” or “master downstairs” are mapped on the client; anything else is dropped |
| `requirements.style` | `string \| null` | Short label, e.g. `modern` |
| `requirements.notes` | `string` | Free-text summary (≤ 500 chars) |
| `assistantMessage` | `string` | Friendly reply or **one** clarifying question. Plain text only, never HTML |
| `missingFields` | `string[]` | Any of `bedrooms`, `bathrooms` (the client recomputes it; `area` / `floors` are ignored) |

### What the client does with it (it never trusts the Worker)

1. Validates the body with Zod (`WorkerResponseSchema`). If validation fails, it falls back to the rule-based parser.
2. Clamps values into range: area 30–600 (rounded to 5), floors 1–3, bedrooms 1–6, bathrooms 1–4. It whitelists extras and strips `<` and `>` from text.
3. Recomputes `missingFields` and `status` from the sanitised values.
4. Runs the brief through `feasibility.ts` against the drawn footprints before generating. If the brief can't fit (e.g. 3 bedrooms in a 60 m² footprint), the chat explains why and offers the nearest brief that fits, or going back to make the floors bigger.

## Errors

On any error, return a 4xx/5xx status with this body:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests, try again in a minute." } }
```

| Status | `code` (suggested) | When | Client behaviour |
|---|---|---|---|
| 400 | `bad_request` | Malformed body, unknown `schemaVersion`, too many or too long messages | Falls back to rule-based parsing |
| 429 | `rate_limited` | Per-session or per-IP limit hit | Falls back to rule-based parsing and shows the offline badge |
| 500 | `upstream_error` / `internal` | LLM provider failed or produced invalid JSON | Falls back to rule-based parsing |

The client also falls back on a network error or a **15 s timeout**, using `AbortController`.

## CORS (required)

The site runs on GitHub Pages, so the Worker must answer the preflight and the
real request with CORS headers for the Pages origin:

```
Access-Control-Allow-Origin: https://<owner>.github.io
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
Vary: Origin
```

Allow `http://localhost:5173` as well during development. Keep an allow-list
rather than `*`. The origin has no path, so it's the same for every repository
under that account.

## Minimal Worker sketch (for orientation only, not part of this repo)

```ts
export default {
  async fetch(req: Request, env: Env) {
    const origin = req.headers.get('Origin') ?? '';
    const cors = corsHeadersFor(origin); // allow-list check
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (new URL(req.url).pathname !== '/parse' || req.method !== 'POST')
      return json({ error: { code: 'not_found', message: 'Not found' } }, 404, cors);
    const body = await req.json().catch(() => null);
    if (!valid(body)) return json({ error: { code: 'bad_request', message: 'Invalid body' } }, 400, cors);
    if (await rateLimited(env, body.sessionId, req)) return json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, cors);
    const result = await callModelWithJsonSchema(env, body.messages); // system prompt + schema live here
    return json(result, 200, cors);
  },
};
```
