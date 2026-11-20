import { writable } from 'svelte/store';
import { storage } from '../storage/localAdapter';

export type Role = 'client' | 'architect';

function persisted<T>(key: string, initial: T) {
  const store = writable<T>(storage.getPref(key, initial));
  store.subscribe((v) => storage.setPref(key, v));
  return store;
}

/** Demo-only role toggle (no auth). */
export const role = persisted<Role>('role', 'client');
export const authorName = persisted<string>('author', '');

export interface Toast {
  id: number;
  text: string;
  kind?: 'info' | 'error' | 'success';
}
export const toasts = writable<Toast[]>([]);
let tid = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3200) {
  const id = ++tid;
  toasts.update((t) => [...t, { id, text, kind }]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), ms);
}
