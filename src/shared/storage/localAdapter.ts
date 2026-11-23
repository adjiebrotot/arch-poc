import type { StorageAdapter, PlanRecord } from './StorageAdapter';
import type { PlanSpec } from '../planspec/schema';
import type { Comment } from '../comments/model';
import { idbGet, idbSet } from './idb';

const P = 'al:';
const memory = new Map<string, string>();

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}
function safeDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    memory.delete(key);
  }
}
const readJSON = <T>(key: string, fallback: T): T => {
  const raw = safeGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class LocalStorageAdapter implements StorageAdapter {
  async listPlans(): Promise<PlanRecord[]> {
    return readJSON<PlanRecord[]>(P + 'plans', []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getPlan(id: string): Promise<PlanSpec | null> {
    return readJSON<PlanSpec | null>(P + 'plan:' + id, null);
  }
  async savePlan(id: string, plan: PlanSpec): Promise<void> {
    safeSet(P + 'plan:' + id, JSON.stringify(plan));
    const list = readJSON<PlanRecord[]>(P + 'plans', []).filter((p) => p.id !== id);
    list.push({ id, title: plan.meta.title, mode: plan.meta.mode, updatedAt: new Date().toISOString(), ...(plan.meta.stage ? { stage: plan.meta.stage } : {}) });
    safeSet(P + 'plans', JSON.stringify(list));
  }
  async deletePlan(id: string): Promise<void> {
    safeDel(P + 'plan:' + id);
    safeSet(P + 'plans', JSON.stringify(readJSON<PlanRecord[]>(P + 'plans', []).filter((p) => p.id !== id)));
  }
  async listComments(): Promise<Comment[]> {
    return readJSON<Comment[]>(P + 'comments', []);
  }
  async saveComments(all: Comment[]): Promise<void> {
    safeSet(P + 'comments', JSON.stringify(all));
  }
  async getCache<T>(key: string): Promise<T | undefined> {
    try {
      return await idbGet<T>(key);
    } catch {
      return undefined;
    }
  }
  async putCache(key: string, value: unknown): Promise<void> {
    try {
      await idbSet(key, value);
    } catch (e) {
      console.warn('Model cache unavailable', e);
    }
  }
  getPref<T>(key: string, fallback: T): T {
    return readJSON<T>(P + 'pref:' + key, fallback);
  }
  setPref(key: string, value: unknown): void {
    safeSet(P + 'pref:' + key, JSON.stringify(value));
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();
