<script lang="ts">
  import { comments, mergeComments, updateComment } from '@shared/comments/store';
  import { CATEGORY_ICON, CATEGORY_LABEL, type Comment } from '@shared/comments/model';
  import { role, toast } from '@shared/stores/session';
  import { href } from '@shared/router';
  import { downloadJSON, pickFile } from '@shared/util/download';
  import BottomSheet from '@shared/ui/BottomSheet.svelte';
  import ThreadView from '@shared/comments/ThreadView.svelte';
  import StateBox from '@shared/ui/StateBox.svelte';

  let source = $state<'all' | Comment['source']>('all');
  let status = $state<'all' | 'open' | 'resolved'>('all');
  let category = $state<'all' | NonNullable<Comment['category']>>('all');
  let project = $state('all');
  let q = $state('');
  let threadId = $state<string | null>(null);

  const projects = $derived([...new Set($comments.map((c) => c.projectId))]);
  const filtered = $derived(
    $comments
      .filter((c) => (source === 'all' || c.source === source) && (status === 'all' || c.status === status) && (category === 'all' || c.category === category) && (project === 'all' || c.projectId === project))
      .filter((c) => !q || `${c.text} ${c.author} ${c.anchor.elementLabel}`.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  const thread = $derived($comments.find((c) => c.id === threadId));

  function projectLabel(id: string) {
    if (id.startsWith('plan:')) return 'Design plan';
    if (id.startsWith('sample:')) return `Demo · ${id.slice(7)}`;
    if (id.startsWith('project:')) return `Project · ${id.slice(8)}`;
    if (id.startsWith('upload:')) return `Upload · ${id.slice(7)}`;
    return id;
  }
  function openLink(c: Comment) {
    if (c.source === 'design-workspace') return href(`/design/workspace?id=${c.projectId.slice(5)}`);
    if (c.projectId.startsWith('project:')) return href(`/viewer?project=${c.projectId.slice(8)}`);
    return href(c.source === 'viewer-2d' ? '/viewer/plan' : `/viewer/walk?comment=${c.id}`);
  }
  function exportAll() {
    downloadJSON({ kind: 'atelier-linea/comments', version: 1, exportedAt: new Date().toISOString(), comments: filtered }, `comments-${new Date().toISOString().slice(0, 10)}.json`);
  }
  async function importFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.comments;
      const n = mergeComments(list);
      toast(`Imported ${n} new comment${n === 1 ? '' : 's'}`, 'success');
    } catch {
      toast("That file doesn't contain comments we recognise", 'error');
    }
  }
  const open = $derived($comments.filter((c) => c.status === 'open').length);
</script>

<div class="pt-8 md:pt-12 grid gap-6">
  <div class="flex items-end gap-3 flex-wrap">
    <div class="flex-1">
      <p class="eyebrow">All feedback</p>
      <h1 class="text-3xl md:text-4xl font-semibold tracking-tight">Comments</h1>
      <p class="text-ink-2 mt-1">{$comments.length} total · {open} open</p>
    </div>
    <button class="btn btn-ghost" onclick={importFile}>Import JSON</button>
    <button class="btn btn-primary" onclick={exportAll} disabled={!filtered.length}>Export {filtered.length} (.json)</button>
  </div>

  <div class="card p-3 grid gap-3 md:grid-cols-5">
    <label class="field md:col-span-1"><span>Search</span><input class="input" bind:value={q} placeholder="Text, name, element…" /></label>
    <label class="field"><span>Where</span><select class="input" bind:value={source}><option value="all">Everywhere</option><option value="design-workspace">Design workspace</option><option value="viewer-2d">2D drawings</option><option value="viewer-3d">3D walkthrough</option></select></label>
    <label class="field"><span>Status</span><select class="input" bind:value={status}><option value="all">Any</option><option value="open">Open</option><option value="resolved">Resolved</option></select></label>
    <label class="field"><span>Kind</span><select class="input" bind:value={category}><option value="all">Any</option><option value="like">👍 Like</option><option value="change">✏️ Change</option><option value="question">❓ Question</option></select></label>
    <label class="field"><span>Project</span><select class="input" bind:value={project}><option value="all">All</option>{#each projects as p}<option value={p}>{projectLabel(p)}</option>{/each}</select></label>
  </div>

  {#if $comments.length === 0}
    <StateBox title="No comments yet">Open the <a class="underline" href={href('/design')}>design workspace</a> or a <a class="underline" href={href('/viewer')}>model</a> and tap 💬 to leave your first comment.</StateBox>
  {:else if filtered.length === 0}
    <StateBox title="Nothing matches these filters">Try clearing the search or choosing “Any”.</StateBox>
  {:else}
    <ul class="grid gap-3">
      {#each filtered as c (c.id)}
        <li class="card p-4 flex gap-4 items-start">
          {#if c.thumbnail}<img src={c.thumbnail} alt="" class="w-24 h-16 object-cover rounded-xl hidden sm:block" />{/if}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap text-xs text-muted">
              <span class="badge">{c.source === 'design-workspace' ? 'Design' : c.source === 'viewer-2d' ? '2D drawing' : '3D walk'}</span>
              <span>{projectLabel(c.projectId)}</span>
              {#if c.category}<span>{CATEGORY_ICON[c.category]} {CATEGORY_LABEL[c.category]}</span>{/if}
              <span class="badge {c.status === 'resolved' ? '!bg-[#DDEFE5] !text-ok' : ''}">{c.status === 'resolved' ? '✓ Resolved' : 'Open'}</span>
            </div>
            <p class="mt-1.5">{c.text}</p>
            <p class="text-xs text-muted mt-1">{c.author} ({c.role}) · {c.anchor.elementLabel ?? 'Location'}{c.anchor.storey ? ` · ${c.anchor.storey}` : ''} · {new Date(c.createdAt).toLocaleString()}{c.replies.length ? ` · ${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}` : ''}</p>
          </div>
          <div class="flex flex-col gap-2 shrink-0">
            <button class="btn btn-soft btn-sm" onclick={() => (threadId = c.id)}>Open</button>
            <a class="btn btn-ghost btn-sm" href={openLink(c)}>Show</a>
            {#if $role === 'architect'}<button class="btn btn-ghost btn-sm" onclick={() => updateComment(c.id, { status: c.status === 'open' ? 'resolved' : 'open' })}>{c.status === 'open' ? 'Resolve' : 'Reopen'}</button>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<BottomSheet open={!!thread} title="Comment" onclose={() => (threadId = null)}>
  {#if thread}<ThreadView comment={thread} onclose={() => (threadId = null)} />{/if}
</BottomSheet>
