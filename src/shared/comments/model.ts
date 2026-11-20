import { z } from 'zod';

export const CameraSnapshotSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  target: z.tuple([z.number(), z.number(), z.number()]),
  mode: z.enum(['walk', 'orbit', 'plan']).optional(),
});
export type CameraSnapshot = z.infer<typeof CameraSnapshotSchema>;

export const AnchorSchema = z.object({
  elementId: z.string().optional(),
  /** element kind in the design workspace: wall | room | door | window | space */
  elementKind: z.string().optional(),
  /** local coordinates relative to the element (workspace) */
  local: z.array(z.number()).optional(),
  ifcExpressId: z.number().optional(),
  elementLabel: z.string().optional(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  normal: z.tuple([z.number(), z.number(), z.number()]).optional(),
  storey: z.string().optional(),
  floor: z.number().optional(),
  view: CameraSnapshotSchema.optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const CATEGORIES = ['like', 'change', 'question'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { like: 'Like', change: 'Change', question: 'Question' };
export const CATEGORY_ICON: Record<Category, string> = { like: '👍', change: '✏️', question: '❓' };

export interface Comment {
  id: string;
  projectId: string;
  versionId?: string;
  source: 'design-workspace' | 'viewer-2d' | 'viewer-3d';
  anchor: Anchor;
  text: string;
  category?: Category;
  attachments?: string[];
  thumbnail?: string;
  author: string;
  role: 'client' | 'architect';
  createdAt: string;
  status: 'open' | 'resolved';
  replies: Comment[];
}

export const CommentSchema: z.ZodType<Comment> = z.lazy(() =>
  z.object({
    id: z.string(),
    projectId: z.string(),
    versionId: z.string().optional(),
    source: z.enum(['design-workspace', 'viewer-2d', 'viewer-3d']),
    anchor: AnchorSchema,
    text: z.string(),
    category: z.enum(CATEGORIES).optional(),
    attachments: z.array(z.string()).optional(),
    thumbnail: z.string().optional(),
    author: z.string(),
    role: z.enum(['client', 'architect']),
    createdAt: z.string(),
    status: z.enum(['open', 'resolved']),
    replies: z.array(CommentSchema),
  }),
);

export const CommentListSchema = z.array(CommentSchema);
