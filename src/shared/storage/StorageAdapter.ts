import type { PlanSpec } from '../planspec/schema';
import type { Comment } from '../comments/model';

export interface PlanRecord {
  id: string;
  title: string;
  mode: PlanSpec['meta']['mode'];
  updatedAt: string;
  /** where the plan is in the workflow (missing: older plans, open in the workspace) */
  stage?: PlanSpec['meta']['stage'];
}

/**
 * Persistence boundary. The POC ships `LocalStorageAdapter` (localStorage +
 * IndexedDB). A real backend (REST, Supabase, Firebase…) can implement this
 * same interface without touching the UI.
 */
export interface StorageAdapter {
  listPlans(): Promise<PlanRecord[]>;
  getPlan(id: string): Promise<PlanSpec | null>;
  savePlan(id: string, plan: PlanSpec): Promise<void>;
  deletePlan(id: string): Promise<void>;

  listComments(): Promise<Comment[]>;
  saveComments(all: Comment[]): Promise<void>;

  /** Large binary/structured caches (parsed IFC/GLB models). */
  getCache<T>(key: string): Promise<T | undefined>;
  putCache(key: string, value: unknown): Promise<void>;

  getPref<T>(key: string, fallback: T): T;
  setPref(key: string, value: unknown): void;
}
