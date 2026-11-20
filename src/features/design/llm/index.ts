import type { LLMProvider, ParseRequest, ParseResult } from './types';
import { WorkerProvider } from './WorkerProvider';
import { RuleBasedProvider } from './RuleBasedProvider';
import { MockProvider } from './MockProvider';

export * from './types';
export { WorkerProvider, RuleBasedProvider, MockProvider };

/**
 * Default chain: Worker (if VITE_LLM_WORKER_URL was set at build time) →
 * RuleBased on missing URL, network error, timeout (15 s), 429 or invalid output.
 */
export class FallbackProvider {
  constructor(private primary: LLMProvider | null, private fallback: LLMProvider = new RuleBasedProvider()) {}
  get online() { return !!this.primary; }
  async parse(req: ParseRequest, signal?: AbortSignal): Promise<ParseResult> {
    if (!this.primary) return { ...(await this.fallback.parse(req, signal)), degraded: true, degradedReason: 'not-configured' };
    try {
      return await this.primary.parse(req, signal);
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'error';
      console.warn('[llm] falling back to rule-based parser:', code);
      return { ...(await this.fallback.parse(req, signal)), degraded: true, degradedReason: code };
    }
  }
}

export function createChatProvider(): FallbackProvider {
  const url = (import.meta.env.VITE_LLM_WORKER_URL as string | undefined)?.trim();
  if (typeof location !== 'undefined' && /[?&]llm=mock/.test(location.hash)) return new FallbackProvider(new MockProvider());
  return new FallbackProvider(url ? new WorkerProvider(url) : null);
}
