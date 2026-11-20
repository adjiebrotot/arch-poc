<script lang="ts">
  import { CATEGORY_ICON, CATEGORY_LABEL, type Comment } from './model';
  import { addReply, updateComment, deleteComment } from './store';
  import { role, authorName } from '../stores/session';

  let { comment, ongoto, onclose }: { comment: Comment; ongoto?: () => void; onclose?: () => void } = $props();
  let reply = $state('');
  const when = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function send(e: Event) {
    e.preventDefault();
    if (!reply.trim()) return;
    addReply(comment.id, { text: reply.trim(), author: $authorName || ($role === 'architect' ? 'Architect' : 'Client'), role: $role });
    reply = '';
  }
</script>

<article class="grid gap-4">
  <header class="flex items-start gap-3">
    <div class="w-10 h-10 rounded-full grid place-items-center text-white font-semibold shrink-0 {comment.role === 'architect' ? 'bg-ink' : 'bg-accent'}" aria-hidden="true">{comment.author.slice(0, 1).toUpperCase()}</div>
    <div class="flex-1 min-w-0">
      <div class="font-semibold">{comment.author} <span class="badge ml-1">{comment.role === 'architect' ? 'Architect' : 'Client'}</span></div>
      <div class="text-xs text-muted">{when(comment.createdAt)} · {comment.anchor.elementLabel ?? 'Location'}{comment.anchor.storey ? ` · ${comment.anchor.storey}` : ''}</div>
    </div>
    <span class="badge {comment.status === 'resolved' ? '!bg-[#DDEFE5] !text-ok' : ''}">{comment.status === 'resolved' ? '✓ Resolved' : 'Open'}</span>
  </header>
  {#if comment.category}<div class="text-sm">{CATEGORY_ICON[comment.category]} {CATEGORY_LABEL[comment.category]}</div>{/if}
  <p class="whitespace-pre-line">{comment.text}</p>
  {#if comment.thumbnail || comment.attachments?.length}
    <div class="flex gap-2 flex-wrap">
      {#if comment.thumbnail}<img src={comment.thumbnail} alt="Snapshot of the view" class="h-24 rounded-xl" />{/if}
      {#each comment.attachments ?? [] as a}<img src={a} alt="Attached reference" class="h-24 rounded-xl" />{/each}
    </div>
  {/if}
  <div class="flex gap-2 flex-wrap">
    {#if ongoto}<button class="btn btn-primary btn-sm" onclick={ongoto}>👁 Go to view</button>{/if}
    {#if $role === 'architect'}
      <button class="btn btn-soft btn-sm" onclick={() => updateComment(comment.id, { status: comment.status === 'open' ? 'resolved' : 'open' })}>{comment.status === 'open' ? '✓ Mark resolved' : '↺ Reopen'}</button>
    {/if}
    {#if $role === 'architect' || comment.role === $role}
      <button class="btn btn-ghost btn-sm" onclick={() => { deleteComment(comment.id); onclose?.(); }}>Delete</button>
    {/if}
  </div>
  {#if comment.replies.length}
    <ul class="grid gap-3 border-l-2 border-line pl-4" aria-label="Replies">
      {#each comment.replies as r}
        <li><div class="text-sm"><strong>{r.author}</strong> <span class="text-xs text-muted">· {r.role === 'architect' ? 'Architect' : 'Client'} · {when(r.createdAt)}</span></div><p class="text-sm mt-0.5 whitespace-pre-line">{r.text}</p></li>
      {/each}
    </ul>
  {/if}
  <form class="flex gap-2" onsubmit={send}>
    <label class="sr-only" for="reply-{comment.id}">Reply</label>
    <input id="reply-{comment.id}" class="input !rounded-full" placeholder="Write a reply…" bind:value={reply} />
    <button class="btn btn-primary" disabled={!reply.trim()}>Reply</button>
  </form>
</article>
