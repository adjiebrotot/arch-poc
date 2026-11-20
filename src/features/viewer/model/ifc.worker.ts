/// <reference lib="webworker" />
import { IfcAPI } from 'web-ifc';
import { parseIfc } from './ifcParse';
import type { ModelData } from '@shared/model/types';

let api: IfcAPI | null = null;

self.onmessage = async (ev: MessageEvent<{ buffer: ArrayBuffer; wasmUrl: string; simplified: boolean; name: string }>) => {
  const { buffer, wasmUrl, simplified, name } = ev.data;
  try {
    if (!api) {
      api = new IfcAPI();
      // Single-threaded build only: no SharedArrayBuffer on GitHub Pages.
      await api.Init((path: string) => (path.endsWith('.wasm') ? wasmUrl : path), true);
    }
    const model: ModelData = parseIfc(api, new Uint8Array(buffer), {
      simplified, name,
      onProgress: (p, message) => self.postMessage({ type: 'progress', p, message }),
    });
    const transfer: Transferable[] = [];
    for (const e of model.elements) {
      transfer.push(e.positions.buffer, e.normals.buffer, e.indices.buffer);
      if (e.uvs) transfer.push(e.uvs.buffer);
    }
    for (const t of model.textures ?? []) {
      if (t.data && !transfer.includes(t.data.buffer)) transfer.push(t.data.buffer);
      if (t.rgba && !transfer.includes(t.rgba.buffer)) transfer.push(t.rgba.buffer);
    }
    self.postMessage({ type: 'done', model }, { transfer });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
