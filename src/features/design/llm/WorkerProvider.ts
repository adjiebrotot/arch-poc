import {
  type LLMProvider, type ParseRequest, type ParseResult, type Essential,
  WorkerResponseSchema, WorkerErrorSchema, sanitizeRequirements, missingOf, TIMEOUT_MS, MAX_HISTORY, ESSENTIALS,
} from './types';

export class WorkerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Calls the firm's Cloudflare Worker (black box). The browser sends NO keys:
 * the Worker owns the API key, model choice, prompt, rate limits and CORS.
 */
export class WorkerProvider implements LLMProvider {
  readonly name = 'worker' as const;
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private timeoutMs = TIMEOUT_MS,
  ) {}

  async parse(req: ParseRequest, signal?: AbortSignal): Promise<ParseResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), this.timeoutMs);
    signal?.addEventListener('abort', () => ctrl.abort(signal.reason));
    try {
      const body: ParseRequest = { ...req, messages: req.messages.slice(-MAX_HISTORY) };
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/parse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        const timeout = ctrl.signal.aborted && !signal?.aborted;
        throw new WorkerError(0, timeout ? 'timeout' : 'network', timeout ? 'The assistant took too long to answer' : 'Network error');
      }
      if (!res.ok) {
        let code = res.status === 429 ? 'rate_limited' : 'http_' + res.status;
        let message = res.statusText;
        try {
          const err = WorkerErrorSchema.safeParse(await res.json());
          if (err.success) { code = err.data.error.code; message = err.data.error.message; }
        } catch { /* ignore body */ }
        throw new WorkerError(res.status, code, message);
      }
      let json: unknown;
      try { json = await res.json(); } catch { throw new WorkerError(res.status, 'invalid_json', 'Worker returned invalid JSON'); }
      const parsed = WorkerResponseSchema.safeParse(json);
      if (!parsed.success) throw new WorkerError(res.status, 'invalid_schema', 'Worker response failed validation');
      const requirements = sanitizeRequirements(parsed.data.requirements);
      // Recompute missing fields ourselves; only trust the Worker's list for known essentials.
      const missing = new Set<Essential>(missingOf(requirements));
      for (const f of parsed.data.missingFields) if ((ESSENTIALS as readonly string[]).includes(f) && requirements[f as Essential] === null) missing.add(f as Essential);
      const missingFields = ESSENTIALS.filter((k) => missing.has(k));
      return {
        status: missingFields.length ? 'needs_clarification' : parsed.data.status,
        requirements,
        assistantMessage: parsed.data.assistantMessage.trim().slice(0, 1200) || 'Thanks! Anything else?',
        missingFields,
        provider: 'worker',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
