/// <reference lib="webworker" />
/**
 * Layout generation off the main thread: generating and judging dozens of candidates takes a
 * few seconds on complex footprints, and the page must stay responsive meanwhile.
 */
import { generateLayouts, suggestBriefs } from './generator';
import type { LayoutRequest, LayoutResponse } from './layoutClient';

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const m = e.data;
  let out: LayoutResponse;
  try {
    out = m.kind === 'layouts'
      ? { id: m.id, ok: true, result: generateLayouts(m.input, m.count, m.baseSeed, m.tries) }
      : { id: m.id, ok: true, result: suggestBriefs(m.input, m.max) };
  } catch (err) {
    out = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(out);
};
