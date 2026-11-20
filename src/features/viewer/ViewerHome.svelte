<script lang="ts">
  import { route, href, navigate } from '@shared/router';
  import { role, toast } from '@shared/stores/session';
  import { comments } from '@shared/comments/store';
  import StateBox from '@shared/ui/StateBox.svelte';
  import LoadingBar from './LoadingBar.svelte';
  import { current, loading, SAMPLES, loadSample, loadFile, loadProject, MOBILE_LIMIT_MB, DESKTOP_LIMIT_MB, type PublishedProject } from './model/modelStore';
  import { isMobile } from '@shared/util/download';

  let dragging = $state(false);
  let bigFile = $state<File | null>(null);
  let projects = $state<PublishedProject[]>([]);
  let error = $state('');

  fetch(`${import.meta.env.BASE_URL}projects/index.json`).then((r) => (r.ok ? r.json() : [])).then((p) => (projects = p)).catch(() => {});

  const projectParam = $route.query.get('project');
  if (projectParam && $current?.projectId !== `project:${projectParam}`) {
    loadProject(projectParam, false).catch((e) => (error = e.message === 'not found' ? `We couldn't find the project “${projectParam}”.` : e.message));
  }

  async function run(p: Promise<unknown>) {
    error = '';
    try { await p; toast('Model ready', 'success'); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  function accept(file: File) {
    if (!/\.(ifc|glb|gltf)$/i.test(file.name)) { error = 'Please choose an .ifc, .glb or .gltf file.'; return; }
    const mb = file.size / 1e6;
    if (mb > (isMobile() ? MOBILE_LIMIT_MB : DESKTOP_LIMIT_MB)) { bigFile = file; return; }
    run(loadFile(file));
  }
  function onDrop(e: DragEvent) {
    e.preventDefault(); dragging = false;
    if ($role !== 'architect') { toast('Switch to Architect (top right) to upload models', 'error'); return; }
    const f = e.dataTransfer?.files?.[0];
    if (f) accept(f);
  }
  const count = $derived($current ? $comments.filter((c) => c.projectId === $current!.projectId).length : 0);
</script>

<div class="pt-8 md:pt-12 grid gap-8">
  <section class="grid gap-3 max-w-2xl">
    <p class="eyebrow">Walk &amp; comment</p>
    <h1 class="text-3xl md:text-5xl font-semibold tracking-tight">See your home before it's built.</h1>
    <p class="text-ink-2 text-lg">Open the drawings or take a lifelike walk through the model — and leave comments exactly where you mean.</p>
  </section>

  <LoadingBar />
  {#if error || $loading.error}
    <StateBox kind="error" title="That didn't work">{error || $loading.error}</StateBox>
  {/if}

  {#if $current && !$loading.active}
    <section class="card p-5 md:p-6 grid md:grid-cols-[1fr_auto] gap-4 items-center" aria-label="Loaded model">
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <h2 class="text-xl font-semibold">{$current.title}</h2>
          {#if $current.versionLabel}<span class="badge">{$current.versionLabel}</span>{/if}
          {#if $current.model.simplified}<span class="badge badge-poc">Simplified</span>{/if}
        </div>
        <p class="text-sm text-muted mt-1">{$current.model.elements.length} building elements · {$current.model.storeys.length} levels · {count} comment{count === 1 ? '' : 's'} · {$current.fileName}</p>
        {#if $current.previousVersion}
          <button class="btn btn-ghost btn-sm mt-3" disabled title="POC: simulated">⇆ Compare with previous version ({$current.previousVersion}) · coming soon</button>
        {/if}
      </div>
      <div class="flex gap-2 flex-wrap">
        <a class="btn btn-ghost" href={href('/viewer/plan')}>📐 Drawings</a>
        <a class="btn btn-accent" href={href('/viewer/walk')}>🚶 Walk through</a>
      </div>
    </section>
  {/if}

  {#if projects.length}
    <section aria-labelledby="pub-h">
      <h2 id="pub-h" class="font-semibold text-lg">Shared by your architect</h2>
      <div class="grid sm:grid-cols-2 gap-3 mt-3">
        {#each projects as p}
          <button class="card p-4 text-left hover:border-ink flex gap-3 items-center" onclick={() => { navigate(`/viewer?project=${p.id}`, { replace: true }); run(loadProject(p.id)); }}>
            <div class="w-12 h-12 rounded-2xl bg-ink text-white grid place-items-center text-xl" aria-hidden="true">🏠</div>
            <div class="flex-1"><div class="font-semibold">{p.title}</div><div class="text-xs text-muted">{p.versionLabel}{p.publishedAt ? ` · ${new Date(p.publishedAt).toLocaleDateString()}` : ''}</div></div>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section aria-labelledby="sample-h">
    <h2 id="sample-h" class="font-semibold text-lg">Try a demo model</h2>
    <div class="grid sm:grid-cols-2 gap-3 mt-3">
      {#each SAMPLES as s}
        <button class="card p-4 text-left hover:border-ink flex gap-3 items-center" onclick={() => run(loadSample(s.id))} disabled={$loading.active}>
          <div class="w-12 h-12 rounded-2xl bg-paper-2 grid place-items-center text-xs font-bold" aria-hidden="true">{s.kind}</div>
          <div class="flex-1"><div class="font-semibold">{s.title}</div><div class="text-xs text-muted">{s.blurb}</div></div>
        </button>
      {/each}
    </div>
  </section>

  <section aria-labelledby="up-h">
    <h2 id="up-h" class="font-semibold text-lg">Upload a model</h2>
    {#if $role === 'architect'}
      <label class="mt-3 card border-dashed border-2 p-8 grid place-items-center text-center gap-2 cursor-pointer {dragging ? 'border-accent bg-accent-soft' : ''}"
        ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={() => (dragging = false)} ondrop={onDrop}>
        <span class="text-3xl" aria-hidden="true">📦</span>
        <span class="font-semibold">Drop an .ifc or .glb file here, or tap to choose</span>
        <span class="text-sm text-muted">Parsed in your browser — nothing is uploaded to a server.</span>
        <input type="file" accept=".ifc,.glb,.gltf" class="sr-only" onchange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) accept(f); }} />
      </label>
      <p class="text-sm text-muted mt-3">To share a version with a client, publish it under <code>public/projects/&lt;id&gt;/</code> — see the README.</p>
    {:else}
      <p class="text-muted mt-2">Your architect uploads models. Switch the header toggle to <strong>Architect</strong> to try it.</p>
    {/if}
  </section>
</div>

{#if bigFile}
  <div class="fixed inset-0 z-50 bg-black/30 grid items-end md:items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="big-h">
    <div class="card p-6 max-w-md grid gap-3">
      <h2 id="big-h" class="text-lg font-semibold">That's a big model for this device</h2>
      <p class="text-ink-2">{bigFile.name} is {(bigFile.size / 1e6).toFixed(0)} MB. We can load a simplified version (without furniture and small parts) so it runs smoothly.</p>
      <div class="flex gap-2 justify-end flex-wrap">
        <button class="btn btn-ghost" onclick={() => (bigFile = null)}>Cancel</button>
        <button class="btn btn-ghost" onclick={() => { const f = bigFile!; bigFile = null; run(loadFile(f, false)); }}>Load full model</button>
        <button class="btn btn-accent" onclick={() => { const f = bigFile!; bigFile = null; run(loadFile(f, true)); }}>Load simplified</button>
      </div>
    </div>
  </div>
{/if}
