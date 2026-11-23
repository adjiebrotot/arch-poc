import { storage } from '@shared/storage/localAdapter';
import type { PlanSpec } from '@shared/planspec/schema';
import { PlanSpecSchema, emptyPlan } from '@shared/planspec/schema';
import { uid } from '@shared/util/id';
import { navigate } from '@shared/router';
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { Comment } from '@shared/comments/model';
import { CommentListSchema } from '@shared/comments/model';
import { z } from 'zod';

/** Where a plan opens: the setup flow while its envelope / brief is being defined, else the workspace. */
export const planPath = (id: string, stage?: PlanSpec['meta']['stage']) => (stage && stage !== 'design' ? `/design/setup?id=${id}` : `/design/workspace?id=${id}`);

export async function savePlanAndOpen(plan: PlanSpec) {
  const id = plan.meta.id ?? uid('plan');
  const p = { ...plan, meta: { ...plan.meta, id, createdAt: new Date().toISOString() } };
  await storage.savePlan(id, p);
  navigate(planPath(id, p.meta.stage));
}

const TITLES: Record<PlanSpec['meta']['mode'], string> = { pro: 'My sketch', creative: 'My home', chat: 'My home' };

/** Start a new plan in a mode: every mode begins with the lot. */
export async function startPlan(mode: PlanSpec['meta']['mode'], opts: { replace?: boolean } = {}) {
  const plan = emptyPlan(mode, TITLES[mode]);
  const id = uid('plan');
  plan.meta.id = id;
  await storage.savePlan(id, plan);
  navigate(`/design/setup?id=${id}`, opts);
}

export const projectIdForPlan = (id: string) => `plan:${id}`;

/** "Send to architect" bundle: PlanSpec + comments + requirements. */
export const BundleSchema = z.object({
  kind: z.literal('atelier-linea/design-bundle'),
  version: z.literal(1),
  exportedAt: z.string(),
  plan: PlanSpecSchema,
  comments: CommentListSchema,
  requirements: z.unknown().optional(),
});
export type Bundle = z.infer<typeof BundleSchema>;

export function makeBundle(plan: PlanSpec, comments: Comment[]): Bundle {
  return {
    kind: 'atelier-linea/design-bundle', version: 1, exportedAt: new Date().toISOString(),
    plan, comments, requirements: plan.requirements,
  };
}

/** Small plans can travel in the URL hash (lz-string compressed). */
export const MAX_SHARE_URL = 7000;
export function bundleToShareUrl(b: Bundle): { url: string; tooLarge: boolean } {
  // Strip photo attachments: they don't fit in a URL.
  const slim = { ...b, comments: b.comments.map((c) => ({ ...c, attachments: undefined, thumbnail: undefined })) };
  const code = compressToEncodedURIComponent(JSON.stringify(slim));
  const url = `${location.origin}${location.pathname}#/design/workspace?share=${code}`;
  return { url, tooLarge: url.length > MAX_SHARE_URL };
}

export function shareCodeToBundle(code: string): Bundle | null {
  try {
    const json = decompressFromEncodedURIComponent(code);
    if (!json) return null;
    return BundleSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}
