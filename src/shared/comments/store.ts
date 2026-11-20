import { writable, get } from 'svelte/store';
import type { Comment } from './model';
import { CommentListSchema } from './model';
import { storage } from '../storage/localAdapter';
import { uid } from '../util/id';

export const comments = writable<Comment[]>([]);
let loaded = false;

export async function loadComments() {
  if (loaded) return;
  loaded = true;
  comments.set(await storage.listComments());
  comments.subscribe((all) => void storage.saveComments(all));
}

export function addComment(c: Omit<Comment, 'id' | 'createdAt' | 'status' | 'replies'> & Partial<Comment>): Comment {
  const full: Comment = { id: uid('c'), createdAt: new Date().toISOString(), status: 'open', replies: [], ...c };
  comments.update((all) => [...all, full]);
  return full;
}

export function updateComment(id: string, patch: Partial<Comment>) {
  comments.update((all) => all.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export function addReply(id: string, reply: Pick<Comment, 'text' | 'author' | 'role'>) {
  comments.update((all) =>
    all.map((c) =>
      c.id === id
        ? {
            ...c,
            replies: [
              ...c.replies,
              {
                ...reply,
                id: uid('r'),
                projectId: c.projectId,
                source: c.source,
                anchor: c.anchor,
                createdAt: new Date().toISOString(),
                status: 'open',
                replies: [],
              },
            ],
          }
        : c,
    ),
  );
}

export function deleteComment(id: string) {
  comments.update((all) => all.filter((c) => c.id !== id));
}

/** Merge comments (e.g. from an import or a published project) without duplicating IDs. */
export function mergeComments(incoming: Comment[]): number {
  const parsed = CommentListSchema.parse(incoming);
  const existing = new Set(get(comments).map((c) => c.id));
  const fresh = parsed.filter((c) => !existing.has(c.id));
  comments.update((all) => [...all, ...fresh]);
  return fresh.length;
}

export function commentsFor(projectId: string, all: Comment[]) {
  return all.filter((c) => c.projectId === projectId);
}
