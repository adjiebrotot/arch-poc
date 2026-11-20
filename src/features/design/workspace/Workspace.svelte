<script lang="ts">
  import { route, href, navigate } from '@shared/router';
  import { storage } from '@shared/storage/localAdapter';
  import { comments, addComment } from '@shared/comments/store';
  import { role, toast } from '@shared/stores/session';
  import { ROOM_TYPES, ROOM_LABELS, ROOM_COLORS, type PlanSpec, type RoomType } from '@shared/planspec/schema';
  import { recomputeRooms } from '../engine/openplan3dAdapter';
  import { Editor, type Tool, type Hit } from './editor.svelte';
  import PlanCanvas from './PlanCanvas.svelte';
  import BottomSheet from '@shared/ui/BottomSheet.svelte';
  import StateBox from '@shared/ui/StateBox.svelte';
  import CommentComposer from '@shared/comments/CommentComposer.svelte';
  import ThreadView from '@shared/comments/ThreadView.svelte';
  import CoachMarks from './CoachMarks.svelte';
  import { projectIdForPlan, makeBundle, bundleToShareUrl, shareCodeToBundle } from '../planStore';
  import { mergeComments } from '@shared/comments/store';
  import { downloadJSON, downloadBlob } from '@shared/util/download';
  import { floorToSvg } from '../engine/planSvg';
  import { dist } from '@shared/util/geometry';
  import type { Comment } from '@shared/comments/model';
  import type { Component } from 'svelte';

  let status = $state<'loading' | 'ready' | 'missing'>('loading');
  let editor = $state<Editor | null>(null);
  let planId = $state('');
  let canvas: PlanCanvas | undefined = $state();
  let view = $state<'2d' | '3d'>('2d');
  let saved = $state<'saved' | 'saving'>('saved');
  let Preview3D = $state<Component<any> | null>(null);

  let sheet = $state<null | 'details' | 'compose' | 'thread' | 'send' | 'advanced' | 'list'>(null);
  let pendingHit = $state<Hit | null>(null);
  let threadId = $state<string | null>(null);
  let namingRoom = $state<string | null>(null);
  let showCoach = $state(false);

  async function load() {
    const q = $route.query;
    const share = q.get('share');
    if (share) {
      const b = shareCodeToBundle(share);
      if (!b) { status = 'missing'; return; }
      const id = b.plan.meta.id ?? 'shared';
      await storage.savePlan(id, b.plan);
      mergeComments(b.comments);
      toast('Shared plan opened', 'success');
      navigate(`/design/workspace?id=${id}`, { replace: true });
      return init(id, b.plan);
    }
    const id = q.get('id');
    const plan = id ? await storage.getPlan(id) : null;
    if (!id || !plan) { status = 'missing'; return; }
    init(id, plan);
  }

  function init(id: string, plan: PlanSpec) {
    planId = id;
    // Make sure rooms/areas are derived from walls via openPlan3D detection.
    plan.floors = plan.floors.map((f) => (f.walls.length ? recomputeRooms(f) : f));
    const ed = new Editor(plan);
    let timer: ReturnType<typeof setTimeout>;
    ed.onChange = () => {
      saved = 'saving';
      clearTimeout(timer);
      timer = setTimeout(async () => { await storage.savePlan(planId, $state.snapshot(ed.plan) as PlanSpec); saved = 'saved'; }, 400);
    };
    editor = ed;
    status = 'ready';
    showCoach = plan.meta.mode === 'pro' && !storage.getPref('coach-done', false) && plan.floors[0].walls.length === 0;
    if (plan.meta.mode === 'pro' && plan.floors[0].walls.length === 0) ed.tool = 'room';
  }
  load();

  const projectId = $derived(projectIdForPlan(planId));
  const planComments = $derived($comments.filter((c) => c.projectId === projectId && c.source === 'design-workspace'));
  const floorPins = $derived(editor ? planComments.filter((c) => (c.anchor.floor ?? 0) === editor!.floor.level) : []);
  const openCount = $derived(planComments.filter((c) => c.status === 'open').length);
  const thread = $derived(planComments.find((c) => c.id === threadId));

  async function setView(v: '2d' | '3d') {
    view = v;
    if (v === '3d' && !Preview3D) Preview3D = (await import('./Preview3D.svelte')).default;
  }

  const tools: { id: Tool; icon: string; label: string; key: string }[] = [
    { id: 'select', icon: '👆', label: 'Move', key: 'v' },
    { id: 'room', icon: '⬛', label: 'Add a room', key: 'r' },
    { id: 'wall', icon: '📏', label: 'Draw wall', key: 'w' },
    { id: 'door', icon: '🚪', label: 'Add door', key: 'd' },
    { id: 'window', icon: '🪟', label: 'Add window', key: 'n' },
    { id: 'erase', icon: '🧽', label: 'Remove', key: 'x' },
  ];
  const toolHint: Record<Tool, string> = {
    select: 'Tap to select · drag a selected wall or door to move it · long-press to grab on touch',
    room: 'Drag to draw a room, or tap to drop a 3.6 × 3 m room',
    wall: 'Tap corner points to draw walls · tap the first point to close',
    door: 'Tap on a wall to add a door',
    window: 'Tap on a wall to add a window',
    erase: 'Tap a wall, door, window or room to remove it',
  };

  function onCommentTap(hit: Hit) { pendingHit = hit; sheet = 'compose'; }
  function onPinTap(c: Comment) { threadId = c.id; sheet = 'thread'; }

  function postComment(d: { text: string; category: Comment['category']; attachments: string[]; author: string }) {
    if (!editor || !pendingHit) return;
    const c = addComment({ projectId, source: 'design-workspace', anchor: editor.anchorFor(pendingHit), text: d.text, category: d.category, attachments: d.attachments, author: d.author, role: $role });
    sheet = null; pendingHit = null;
    toast('Comment pinned', 'success');
    threadId = c.id;
  }

  const sel = $derived.by(() => {
    if (!editor?.selection) return null;
    const f = editor.floor, s = editor.selection;
    if (s.kind === 'room') { const r = f.rooms.find((x) => x.id === s.id); return r ? { label: `${r.name} · ${r.area.toFixed(1)} m²`, room: r } : null; }
    if (s.kind === 'wall') { const w = f.walls.find((x) => x.id === s.id); return w ? { label: `${w.exterior ? 'Outside wall' : 'Wall'} · ${dist(w.a, w.b).toFixed(2)} m`, wall: w } : null; }
    const o = f.openings.find((x) => x.id === s.id);
    return o ? { label: `${o.type === 'door' ? 'Door' : 'Window'} · ${o.width.toFixed(2)} m wide`, opening: o } : null;
  });

  function onkeydown(e: KeyboardEvent) {
    if (!editor || sheet) return;
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selection) { editor.deleteElement(editor.selection); return; }
    if (e.key === 'Escape') { editor.selection = null; canvas?.finishChain(); editor.tool = 'select'; return; }
    const tool = tools.find((x) => x.key === e.key.toLowerCase());
    if (tool && !mod) { editor.mode = 'edit'; editor.tool = tool.id; }
    if (e.key === 'c' && !mod) editor.mode = editor.mode === 'comment' ? 'edit' : 'comment';
  }

  function exportBundle() {
    if (!editor) return;
    downloadJSON(makeBundle($state.snapshot(editor.plan) as PlanSpec, planComments), `${editor.plan.meta.title.replace(/\W+/g, '-').toLowerCase()}-for-architect.json`);
    toast('Bundle downloaded — email it to your architect', 'success');
  }
  const share = $derived(editor && sheet === 'send' ? bundleToShareUrl(makeBundle($state.snapshot(editor.plan) as PlanSpec, planComments)) : null);
  async function copyShare() {
    if (!share) return;
    try { await navigator.clipboard.writeText(share.url); toast('Link copied', 'success'); } catch { toast('Copy failed — select and copy the link manually', 'error'); }
  }
  function exportSvg() {
    if (!editor) return;
    downloadBlob(new Blob([floorToSvg(editor.floor, { labels: true, areas: true })], { type: 'image/svg+xml' }), 'floor-plan.svg');
  }
  function dismissCoach() { showCoach = false; storage.setPref('coach-done', true); }
  const totalArea = $derived(editor ? editor.plan.floors.reduce((s, f) => s + f.rooms.reduce((t, r) => t + r.area, 0), 0) : 0);
</script>

<svelte:window {onkeydown} />

{#if status === 'loading'}
  <div class="p-8"><StateBox kind="loading" title="Opening your plan…" /></div>
{:else if status === 'missing' || !editor}
  <div class="p-8 max-w-xl mx-auto"><StateBox kind="error" title="We couldn't find that plan">It may have been created on another device. <a class="underline" href={href('/design')}>Start a new plan</a> or import a .json file.</StateBox></div>
{:else}
  {@const ed = editor}
  <div class="relative flex flex-col h-[calc(100dvh-3.5rem)] overflow-hidden">
    <!-- top bar -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper z-20 flex-wrap">
      <label class="sr-only" for="plan-title">Plan name</label>
      <input id="plan-title" class="bg-transparent font-semibold min-w-0 flex-1 basis-32 px-1 py-1 rounded-lg hover:bg-paper-2 focus:bg-white" value={ed.plan.meta.title}
        onchange={(e) => { ed.pushHistory(); ed.plan.meta.title = (e.target as HTMLInputElement).value || 'My plan'; ed.onChange?.(); }} />
      <span class="text-xs text-muted hidden sm:inline" aria-live="polite">{saved === 'saving' ? 'Saving…' : '✓ Saved on this device'} · {totalArea.toFixed(0)} m²</span>
      <div class="flex rounded-full bg-paper-2 p-0.5 text-sm font-semibold" role="group" aria-label="Workspace mode">
        <button class="px-3 min-h-9 rounded-full {ed.mode === 'edit' ? 'bg-white shadow-sm' : 'text-ink-2'}" aria-pressed={ed.mode === 'edit'} onclick={() => (ed.mode = 'edit')}>✏️ Edit</button>
        <button class="px-3 min-h-9 rounded-full {ed.mode === 'comment' ? 'bg-accent text-white shadow-sm' : 'text-ink-2'}" aria-pressed={ed.mode === 'comment'} onclick={() => { ed.mode = 'comment'; ed.selection = null; }}>💬 Comment</button>
      </div>
      <div class="flex rounded-full bg-paper-2 p-0.5 text-sm font-semibold" role="group" aria-label="View">
        <button class="px-3 min-h-9 rounded-full {view === '2d' ? 'bg-white shadow-sm' : 'text-ink-2'}" aria-pressed={view === '2d'} onclick={() => setView('2d')}>2D</button>
        <button class="px-3 min-h-9 rounded-full {view === '3d' ? 'bg-white shadow-sm' : 'text-ink-2'}" aria-pressed={view === '3d'} onclick={() => setView('3d')}>3D</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick={() => (sheet = 'list')} aria-label={`Comments (${openCount} open)`}>💬 {openCount}</button>
      <button class="btn btn-accent btn-sm" onclick={() => (sheet = 'send')}>Send to architect</button>
    </div>

    {#if ed.plan.floors.length > 1 || ed.floor.level > 0}
      <div class="flex gap-1 px-3 py-1.5 bg-paper border-b border-line z-20 text-sm overflow-x-auto" role="tablist" aria-label="Floors">
        {#each ed.plan.floors as f, i}
          <button role="tab" aria-selected={ed.floorIdx === i} class="px-3 py-1 rounded-full {ed.floorIdx === i ? 'bg-ink text-white' : 'hover:bg-paper-2'}" onclick={() => { ed.floorIdx = i; ed.selection = null; }}>{f.level === 0 ? 'Ground' : `Level ${f.level + 1}`}</button>
        {/each}
      </div>
    {/if}

    <div class="relative flex-1 min-h-0">
      {#if view === '2d'}
        <PlanCanvas bind:this={canvas} editor={ed} pins={floorPins} {onCommentTap} {onPinTap} onRoomCreated={(id) => (namingRoom = id)} />
      {:else if Preview3D}
        <Preview3D plan={ed.plan} />
      {:else}
        <div class="absolute inset-0 grid place-items-center text-muted" role="status">Loading 3D…</div>
      {/if}

      <!-- hint -->
      <div class="absolute top-3 left-3 right-16 pointer-events-none flex">
        <div class="rounded-full bg-white/90 border border-line px-3 py-1.5 text-xs text-ink-2 shadow-sm max-w-full truncate">
          {#if view === '3d'}3D preview · drag to orbit, pinch to zoom · switch to 2D to edit
          {:else if ed.mode === 'comment'}💬 Tap any wall, room, door or window to leave a comment
          {:else}{toolHint[ed.tool]}{/if}
        </div>
      </div>

      {#if view === '2d'}
        <div class="absolute right-3 top-3 grid gap-2 z-10">
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom in" onclick={() => canvas?.zoomBy(1.3)}>＋</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom out" onclick={() => canvas?.zoomBy(1 / 1.3)}>－</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Fit plan to screen" onclick={() => canvas?.fit()}>⤢</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Undo" disabled={!ed.canUndo} onclick={() => ed.undo()}>↶</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Redo" disabled={!ed.canRedo} onclick={() => ed.redo()}>↷</button>
        </div>
      {/if}

      <!-- naming chips after creating a room -->
      {#if namingRoom && view === '2d'}
        <div class="absolute left-2 right-2 bottom-2 z-20 card p-3 shadow-lg" role="group" aria-label="Name this room">
          <div class="flex items-center mb-2"><span class="text-sm font-semibold flex-1">What is this room?</span><button class="btn btn-ghost btn-sm" onclick={() => (namingRoom = null)}>Later</button></div>
          <div class="flex gap-2 overflow-x-auto pb-1">
            {#each ['bedroom', 'master', 'bathroom', 'kitchen', 'living', 'dining', 'study', 'laundry', 'garage', 'hallway'] as t}
              <button class="chip shrink-0" style="background:{ROOM_COLORS[t as RoomType]}" onclick={() => { ed.updateRoom(namingRoom!, { type: t as RoomType, name: ROOM_LABELS[t as RoomType] }); namingRoom = null; }}>{ROOM_LABELS[t as RoomType]}</button>
            {/each}
          </div>
        </div>
      {:else if sel && view === '2d' && ed.mode === 'edit'}
        <div class="absolute left-2 right-2 bottom-2 z-20 card px-3 py-2 shadow-lg flex items-center gap-2" role="group" aria-label="Selected element">
          <span class="text-sm font-medium flex-1 truncate">{sel.label}</span>
          <button class="btn btn-soft btn-sm" onclick={() => (sheet = 'details')}>Details</button>
          <button class="btn btn-ghost btn-sm" onclick={() => ed.selection && ed.deleteElement(ed.selection)}>Delete</button>
        </div>
      {/if}
    </div>

    <!-- bottom toolbar -->
    {#if view === '2d' && ed.mode === 'edit'}
      <nav class="border-t border-line bg-paper safe-b z-20" aria-label="Drawing tools">
        <div class="flex gap-1 px-2 py-1.5 overflow-x-auto justify-start md:justify-center">
          {#each tools as t}
            <button class="flex flex-col items-center justify-center gap-0.5 min-w-[64px] min-h-[52px] px-2 rounded-2xl text-[11px] font-semibold {ed.tool === t.id ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper-2'}"
              aria-pressed={ed.tool === t.id} onclick={() => { ed.tool = t.id; if (t.id !== 'select') ed.selection = null; }} title={`${t.label} (${t.key.toUpperCase()})`}>
              <span class="text-lg leading-none" aria-hidden="true">{t.icon}</span>{t.label}
            </button>
          {/each}
          {#if ed.tool === 'wall'}<button class="btn btn-soft btn-sm self-center" onclick={() => canvas?.finishChain()}>Done</button>{/if}
          <button class="flex flex-col items-center justify-center gap-0.5 min-w-[64px] min-h-[52px] px-2 rounded-2xl text-[11px] font-semibold text-ink-2 hover:bg-paper-2" onclick={() => (sheet = 'advanced')}>
            <span class="text-lg leading-none" aria-hidden="true">⚙️</span>Advanced
          </button>
        </div>
      </nav>
    {/if}

    {#if showCoach}<CoachMarks ondone={dismissCoach} />{/if}
  </div>

  <BottomSheet open={sheet === 'details'} title="Details" onclose={() => (sheet = null)}>
    {#if sel?.room}
      {@const r = sel.room}
      <div class="grid gap-4">
        <label class="field"><span>Room name</span><input class="input" value={r.name} onchange={(e) => ed.updateRoom(r.id, { name: (e.target as HTMLInputElement).value })} /></label>
        <div class="field"><span>Room type</span>
          <div class="flex flex-wrap gap-2">{#each ROOM_TYPES as t}<button class="chip" aria-pressed={r.type === t} onclick={() => ed.updateRoom(r.id, { type: t })}>{ROOM_LABELS[t]}</button>{/each}</div>
        </div>
        <p class="text-sm text-muted">Area: <strong class="text-ink">{r.area.toFixed(1)} m²</strong> (measured to the middle of the walls). Move walls to resize.</p>
      </div>
    {:else if sel?.opening}
      {@const o = sel.opening}
      <div class="grid gap-4">
        <label class="field"><span>Width: {o.width.toFixed(2)} m</span><input type="range" min="0.6" max={o.type === 'door' ? 3 : 4} step="0.05" value={o.width} class="accent-[#A4502F] h-11" onchange={(e) => ed.updateOpening(o.id, { width: +(e.target as HTMLInputElement).value })} /></label>
        <label class="field"><span>Height: {o.height.toFixed(2)} m</span><input type="range" min="0.4" max="2.4" step="0.05" value={o.height} class="accent-[#A4502F] h-11" onchange={(e) => ed.updateOpening(o.id, { height: +(e.target as HTMLInputElement).value })} /></label>
        {#if o.type === 'window'}<label class="field"><span>Height above floor: {(o.sill ?? 0.9).toFixed(2)} m</span><input type="range" min="0" max="1.8" step="0.05" value={o.sill ?? 0.9} class="accent-[#A4502F] h-11" onchange={(e) => ed.updateOpening(o.id, { sill: +(e.target as HTMLInputElement).value })} /></label>{/if}
        <button class="btn btn-soft justify-self-start" onclick={() => ed.updateOpening(o.id, { type: o.type === 'door' ? 'window' : 'door', ...(o.type === 'door' ? { sill: 0.9, height: 1.2 } : { height: 2.04 }) })}>Change to {o.type === 'door' ? 'window' : 'door'}</button>
      </div>
    {:else if sel?.wall}
      {@const w = sel.wall}
      <div class="grid gap-4">
        <p>Length: <strong>{dist(w.a, w.b).toFixed(2)} m</strong>{w.exterior ? ' · outside wall' : ' · inside wall'}</p>
        <label class="field"><span>Thickness: {(w.thickness * 100).toFixed(0)} cm</span><input type="range" min="0.08" max="0.4" step="0.01" value={w.thickness} class="accent-[#A4502F] h-11" onchange={(e) => ed.updateWall(w.id, { thickness: +(e.target as HTMLInputElement).value })} /></label>
        <p class="text-sm text-muted">Tip: drag the wall in the plan to move it — connected walls follow.</p>
      </div>
    {/if}
  </BottomSheet>

  <BottomSheet open={sheet === 'compose'} title="New comment" onclose={() => { sheet = null; pendingHit = null; }}>
    {#if pendingHit}
      <CommentComposer context={ed.anchorFor(pendingHit).elementLabel} onsubmit={postComment} oncancel={() => { sheet = null; pendingHit = null; }} />
    {/if}
  </BottomSheet>

  <BottomSheet open={sheet === 'thread' && !!thread} title="Comment" onclose={() => (sheet = null)}>
    {#if thread}<ThreadView comment={thread} onclose={() => (sheet = null)} />{/if}
  </BottomSheet>

  <BottomSheet open={sheet === 'list'} title={`Comments on this plan (${planComments.length})`} onclose={() => (sheet = null)}>
    {#if planComments.length === 0}
      <p class="text-muted">No comments yet. Switch to <strong>💬 Comment</strong> and tap anything in the plan.</p>
    {:else}
      <ul class="grid gap-2">
        {#each planComments as c}
          <li><button class="w-full text-left card p-3 hover:border-ink" onclick={() => { const fi = ed.plan.floors.findIndex((f) => f.level === (c.anchor.floor ?? 0)); if (fi >= 0) ed.floorIdx = fi; setView('2d'); threadId = c.id; sheet = 'thread'; }}>
            <div class="text-sm font-medium">{c.text}</div>
            <div class="text-xs text-muted">{c.author} · {c.anchor.elementLabel} · {c.status}</div>
          </button></li>
        {/each}
      </ul>
    {/if}
  </BottomSheet>

  <BottomSheet open={sheet === 'send'} title="Send to your architect" onclose={() => (sheet = null)}>
    <div class="grid gap-4">
      <p class="text-ink-2">This packs your plan, your {planComments.length} comment{planComments.length === 1 ? '' : 's'} and your brief into one file your architect can open.</p>
      <button class="btn btn-accent" onclick={exportBundle}>⬇ Download bundle (.json)</button>
      {#if share}
        {#if share.tooLarge}
          <p class="text-sm text-muted">This plan is too big for a share link — please send the file instead.</p>
        {:else}
          <div class="field"><span>Or share a link (photos aren't included)</span>
            <div class="flex gap-2"><input class="input text-xs" readonly value={share.url} onfocus={(e) => (e.target as HTMLInputElement).select()} /><button class="btn btn-primary" onclick={copyShare}>Copy</button></div>
          </div>
        {/if}
      {/if}
      <p class="text-xs text-muted">POC: there's no server — files and links are how plans travel. Nothing is uploaded.</p>
    </div>
  </BottomSheet>

  <BottomSheet open={sheet === 'advanced'} title="Advanced" onclose={() => (sheet = null)}>
    <div class="grid gap-5">
      <label class="flex items-center gap-3"><input type="checkbox" class="w-5 h-5 accent-[#A4502F]" bind:checked={ed.snapping} /> Snap to 10 cm grid and wall corners</label>
      <label class="flex items-center gap-3"><input type="checkbox" class="w-5 h-5 accent-[#A4502F]" bind:checked={ed.showDims} /> Show length of the selected wall</label>
      <label class="field"><span>New wall thickness: {(ed.newWallThickness * 100).toFixed(0)} cm</span><input type="range" min="0.08" max="0.35" step="0.01" bind:value={ed.newWallThickness} class="accent-[#A4502F] h-11" /></label>
      <label class="field"><span>Ceiling height: {ed.floor.height.toFixed(2)} m</span><input type="range" min="2.4" max="3.6" step="0.05" value={ed.floor.height} class="accent-[#A4502F] h-11" onchange={(e) => ed.commit((f) => { f.height = +(e.target as HTMLInputElement).value; }, { recompute: false })} /></label>
      {#if ed.plan.site}
        <div class="grid grid-cols-2 gap-3">
          <label class="field"><span>Lot width (m)</span><input class="input" type="number" min="5" max="200" value={ed.plan.site.width} onchange={(e) => { ed.pushHistory(); ed.plan.site!.width = +(e.target as HTMLInputElement).value; ed.onChange?.(); }} /></label>
          <label class="field"><span>Lot depth (m)</span><input class="input" type="number" min="5" max="200" value={ed.plan.site.depth} onchange={(e) => { ed.pushHistory(); ed.plan.site!.depth = +(e.target as HTMLInputElement).value; ed.onChange?.(); }} /></label>
        </div>
      {/if}
      <div class="flex gap-2 flex-wrap">
        <button class="btn btn-soft btn-sm" onclick={() => ed.addFloor()} disabled={ed.plan.floors.length >= 3}>+ Add floor</button>
        <button class="btn btn-ghost btn-sm" onclick={() => ed.removeFloor()} disabled={ed.plan.floors.length < 2}>Remove this floor</button>
        <button class="btn btn-ghost btn-sm" onclick={exportSvg}>Export floor as SVG</button>
        <button class="btn btn-ghost btn-sm" onclick={() => downloadJSON($state.snapshot(ed.plan), 'planspec.json')}>Export PlanSpec JSON</button>
        <button class="btn btn-ghost btn-sm" onclick={() => { showCoach = true; sheet = null; }}>Show tips again</button>
      </div>
      <p class="text-xs text-muted">Rooms and areas are detected automatically from the walls (openPlan3D room detection). Shortcuts: V move, R room, W wall, D door, N window, X remove, C comment, Ctrl+Z undo.</p>
    </div>
  </BottomSheet>
{/if}
