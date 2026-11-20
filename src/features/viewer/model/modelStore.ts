import { writable, get } from 'svelte/store';
import type { ModelData } from '@shared/model/types';
import { storage } from '@shared/storage/localAdapter';
import { mergeComments } from '@shared/comments/store';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

export interface LoadedModel {
  model: ModelData;
  projectId: string;
  versionId?: string;
  versionLabel?: string;
  previousVersion?: string;
  title: string;
  fileName: string;
  cacheKey: string;
}
export interface LoadState { active: boolean; progress: number; message: string; error?: string }

export const current = writable<LoadedModel | null>(null);
export const loading = writable<LoadState>({ active: false, progress: 0, message: '' });

const BASE = import.meta.env.BASE_URL;
export const SAMPLES = [
  { id: 'duplex', title: 'Duplex townhouses', file: 'samples/duplex.ifc', blurb: 'IFC 2x3 from Revit · two mirrored homes over two levels', kind: 'IFC' },
  { id: 'family-home', title: 'Family home (template)', file: 'samples/family-home.glb', blurb: 'glTF/GLB generated from the “Family Home” template', kind: 'GLB' },
];

export const MOBILE_LIMIT_MB = 25;
export const DESKTOP_LIMIT_MB = 150;

function parseIfcInWorker(buffer: ArrayBuffer, name: string, simplified: boolean): Promise<ModelData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ifc.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'progress') loading.set({ active: true, progress: 0.1 + d.p * 0.85, message: d.message });
      if (d.type === 'done') { worker.terminate(); resolve(d.model); }
      if (d.type === 'error') { worker.terminate(); reject(new Error(d.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'IFC worker failed')); };
    const abs = new URL(wasmUrl, location.href).href;
    worker.postMessage({ buffer, wasmUrl: abs, simplified, name }, [buffer]);
  });
}

async function parse(buffer: ArrayBuffer, fileName: string, simplified: boolean): Promise<ModelData> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ifc')) return parseIfcInWorker(buffer, fileName, simplified);
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
    const { loadGlb } = await import('./glbLoad');
    return loadGlb(buffer, fileName, (p, m) => loading.set({ active: true, progress: 0.1 + p * 0.85, message: m }));
  }
  throw new Error('Please choose an .ifc, .glb or .gltf file.');
}

/** Load from bytes with an IndexedDB cache of the parsed model. */
export async function loadModel(opts: {
  fileName: string; cacheKey: string; projectId: string; title: string; simplified?: boolean;
  fetchBytes: () => Promise<ArrayBuffer>; versionId?: string; versionLabel?: string; previousVersion?: string;
}): Promise<LoadedModel> {
  const key = `model:v3:${opts.cacheKey}:${opts.simplified ? 'lite' : 'full'}`;
  loading.set({ active: true, progress: 0.02, message: 'Checking saved copy…' });
  try {
    let model = await storage.getCache<ModelData>(key);
    if (!model) {
      loading.set({ active: true, progress: 0.05, message: 'Downloading…' });
      const buf = await opts.fetchBytes();
      model = await parse(buf, opts.fileName, !!opts.simplified);
      loading.set({ active: true, progress: 0.97, message: 'Saving for next time…' });
      await storage.putCache(key, model);
    }
    const lm: LoadedModel = { model, projectId: opts.projectId, title: opts.title, fileName: opts.fileName, cacheKey: key, versionId: opts.versionId, versionLabel: opts.versionLabel, previousVersion: opts.previousVersion };
    current.set(lm);
    storage.setPref('last-model', { ...lm, model: undefined, fetchUrl: (opts as { fetchUrl?: string }).fetchUrl });
    loading.set({ active: false, progress: 1, message: '' });
    return lm;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    loading.set({ active: false, progress: 0, message: '', error: msg });
    throw e;
  }
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${label} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    loading.set({ active: true, progress: 0.05 + 0.1 * (got / total), message: `Downloading… ${(got / 1e6).toFixed(1)} MB` });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

export function loadSample(id: string, simplified = false) {
  const s = SAMPLES.find((x) => x.id === id) ?? SAMPLES[0];
  const url = BASE + s.file;
  return loadModel({ fileName: s.file.split('/').pop()!, cacheKey: `sample:${s.id}`, projectId: `sample:${s.id}`, title: s.title, simplified, fetchBytes: () => fetchBytes(url, s.title), ...({ fetchUrl: url } as object) });
}

export function loadFile(file: File, simplified = false) {
  return loadModel({ fileName: file.name, cacheKey: `upload:${file.name}:${file.size}:${file.lastModified}`, projectId: `upload:${file.name}`, title: file.name.replace(/\.(ifc|glb|gltf)$/i, ''), simplified, fetchBytes: () => file.arrayBuffer() });
}

export interface PublishedProject {
  id: string; title: string; versionId: string; versionLabel: string; previousVersion?: string; model: string; comments?: string; publishedAt?: string; notes?: string;
}

/** Architect-published version: /public/projects/<id>/project.json (+ model + comments.json). */
export async function loadProject(id: string, simplified = false) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid project id');
  const base = `${BASE}projects/${id}/`;
  loading.set({ active: true, progress: 0.02, message: 'Opening project…' });
  const res = await fetch(base + 'project.json');
  if (!res.ok) { loading.set({ active: false, progress: 0, message: '', error: `Project “${id}” wasn't found.` }); throw new Error('not found'); }
  const p = (await res.json()) as PublishedProject;
  const modelUrl = new URL(p.model, new URL(base, location.href)).href;
  const lm = await loadModel({
    fileName: p.model.split('/').pop()!, cacheKey: `project:${id}:${p.versionId}`, projectId: `project:${id}`, title: p.title, simplified,
    versionId: p.versionId, versionLabel: p.versionLabel, previousVersion: p.previousVersion,
    fetchBytes: () => fetchBytes(modelUrl, p.title),
  });
  if (p.comments) {
    try {
      const cr = await fetch(new URL(p.comments, new URL(base, location.href)).href);
      if (cr.ok) mergeComments(await cr.json());
    } catch (e) { console.warn('Could not load published comments', e); }
  }
  storage.setPref('last-project', id);
  return lm;
}

/** After a page refresh on /viewer/plan or /viewer/walk: restore the last model from cache. */
export async function restoreLast(): Promise<LoadedModel | null> {
  if (get(current)) return get(current);
  const last = storage.getPref<(Omit<LoadedModel, 'model'> & { fetchUrl?: string }) | null>('last-model', null);
  if (!last) return null;
  const model = await storage.getCache<ModelData>(last.cacheKey);
  if (model) {
    const lm = { ...last, model } as LoadedModel;
    current.set(lm);
    return lm;
  }
  if (last.projectId.startsWith('project:')) return loadProject(last.projectId.slice(8));
  if (last.projectId.startsWith('sample:')) return loadSample(last.projectId.slice(7));
  return null;
}
