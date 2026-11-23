/**
 * Asks the layout worker for layouts and brief suggestions; falls back to the main thread where
 * workers aren't available (tests, very old browsers) or the worker fails.
 */
import { generateLayouts, suggestBriefs, type GeneratorInput, type Layouts, type BriefSuggestion } from './generator';

type Input = Omit<GeneratorInput, 'seed'>;
export type LayoutRequest =
  | { id: number; kind: 'layouts'; input: Input; count: number; baseSeed: number; tries: number }
  | { id: number; kind: 'suggest'; input: Input; max: number };
export type LayoutResponse = { id: number; ok: true; result: Layouts | BriefSuggestion[] } | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; fallback: () => unknown }>();

function getWorker(): Worker | null {
  if (worker || broken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      // the worker itself failed (not a generator error): finish what was asked on the main thread
      broken = true;
      worker?.terminate();
      worker = null;
      for (const [id, p] of pending) { pending.delete(id); try { p.resolve(p.fallback()); } catch (err) { p.reject(err as Error); } }
    };
  } catch {
    broken = true;
    worker = null;
  }
  return worker;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function ask<T>(req: WithoutId<LayoutRequest>, fallback: () => T): Promise<T> {
  const w = getWorker();
  if (!w) return new Promise((resolve, reject) => setTimeout(() => { try { resolve(fallback()); } catch (err) { reject(err); } }, 30));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, fallback });
    w.postMessage({ ...req, id });
  });
}

export function layoutsAsync(input: Input, count = 3, baseSeed = 1, tries = 24): Promise<Layouts> {
  return ask({ kind: 'layouts', input, count, baseSeed, tries }, () => generateLayouts(input, count, baseSeed, tries));
}

export function suggestAsync(input: Input, max = 3): Promise<BriefSuggestion[]> {
  return ask({ kind: 'suggest', input, max }, () => suggestBriefs(input, max));
}
