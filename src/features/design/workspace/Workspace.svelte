<script lang="ts">
  import { route, href, navigate } from '@shared/router';
  import { storage } from '@shared/storage/localAdapter';
  import { comments, addComment } from '@shared/comments/store';
  import { role, toast } from '@shared/stores/session';
  import { ROOM_TYPES, ROOM_LABELS, ROOM_COLORS, type PlanSpec, type RoomType } from '@shared/planspec/schema';
  import { recomputeRooms } from '../engine/openplan3dAdapter';
  import { Editor, type Tool, type Hit } from './editor.svelte';
  import PlanCanvas from './PlanCanvas.svelte';
  import Compass from './Compass.svelte';
  import * as site from '@shared/planspec/site';
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

  let sheet = $state<null | 'details' | 'compose' | 'thread' | 'send' | 'advanced' | 'list' | 'site'>(null);
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
    // Older plans only had a width × depth lot: give them an outline, a road and an entrance.
    site.ensureSite(plan);
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
    { id: 'site', icon: '🧭', label: 'Lot & road', key: 'l' },
  ];
  const toolHint: Record<Tool, string> = {
    select: 'Tap to select · drag walls, doors or a room\'s corners · pull a ⊕ to add a corner · long-press to grab on touch',
    room: 'Drag to draw a room, or tap to drop a 3.6 × 3 m room',
    wall: 'Tap corner points to draw walls · tap the first point to close',
    door: 'Tap on a wall to add a door',
    window: 'Tap on a wall to add a window',
    erase: 'Tap a wall, door, window or room to remove it',
    site: 'Drag lot corners · pull a ⊕ to add a corner · tap a side to set a road · drag the ➜ entrance',
  };
  const roomPolyHint = 'Tap each corner of the room · tap the first corner (or Done) to finish';
  const lotDrawHint = 'Tap each corner of your lot · tap the first corner (or Done) to finish';

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
    if (s.kind === 'vertex') return { label: 'Corner · drag to reshape', vertex: s.point };
    if (s.kind === 'room') { const r = f.rooms.find((x) => x.id === s.id); return r ? { label: `${r.name} · ${r.area.toFixed(1)} m² · ${r.polygon.length} corners`, room: r } : null; }
    if (s.kind === 'wall') { const w = f.walls.find((x) => x.id === s.id); return w ? { label: `${w.exterior ? 'Outside wall' : 'Wall'} · ${dist(w.a, w.b).toFixed(2)} m`, wall: w } : null; }
    const o = f.openings.find((x) => x.id === s.id);
    return o ? { label: `${o.type === 'door' ? 'Door' : 'Window'} · ${o.width.toFixed(2)} m wide`, opening: o } : null;
  });

  function onkeydown(e: KeyboardEvent) {
    if (!editor || sheet || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
    if (editor.draft.length) {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); canvas?.undoPoint(); return; }
      if (e.key === 'Enter') { e.preventDefault(); canvas?.closeShape(); return; }
      if (e.key === 'Escape') { canvas?.finishChain(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor.siteSelection?.kind === 'lot-vertex' && editor.tool === 'site') { removeLotCorner(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selection) { remove(); return; }
    if (e.key === 'Escape') { editor.selection = null; editor.siteSelection = null; editor.drawingLot = false; canvas?.finishChain(); editor.tool = 'select'; return; }
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
    downloadBlob(new Blob([floorToSvg(editor.floor, { labels: true, areas: true, site: editor.plan.site })], { type: 'image/svg+xml' }), 'floor-plan.svg');
  }
  function remove() {
    if (!editor?.selection) return;
    const err = editor.deleteElement(editor.selection);
    if (err) toast(err, 'error');
  }

  // ---- lot & roads ----------------------------------------------------------------------------
  const lotInfo = $derived.by(() => {
    if (!editor?.plan.site?.boundary) return null;
    const st = editor.plan.site;
    const front = site.frontEdge(st);
    const preset = site.detectPreset(st);
    const presetLabel = { single: 'One road', corner: 'Corner lot', double: 'Front & back roads', custom: `${st.roads?.length ?? 0} road sides` }[preset.preset];
    return {
      site: st, front, preset, presetLabel,
      area: site.lotArea(st),
      facing: front !== null ? site.edgeFacing(st, front) : null,
      roadEdges: new Set((st.roads ?? []).map((r) => r.edge)),
    };
  });
  const compassCaption = $derived(lotInfo?.facing ? `Road: ${lotInfo.facing}` : 'No road');
  let cornerSide = $state<site.Side>('right');

  function setPreset(p: site.RoadPreset, side: site.Side = cornerSide) {
    if (!editor) return;
    if (p === 'corner') cornerSide = side;
    editor.setSite(site.applyPreset(editor.site, p, side));
  }
  function setNorth(deg: number, history = true) {
    if (!editor) return;
    editor.setSite({ ...editor.site, northAngle: ((Math.round(deg) % 360) + 360) % 360 }, history);
  }
  function faceRoad(bearing: number) {
    if (!editor || lotInfo?.front == null) return;
    setNorth(site.northForFacing(site.outwardNormal(editor.site.boundary!, lotInfo.front), bearing));
  }
  function toggleRoadEdge(i: number) { if (editor) editor.setSite(site.toggleRoad(editor.site, i)); }
  function entranceHere(i: number) {
    if (!editor) return;
    let st = editor.site;
    if (!st.roads?.some((r) => r.edge === i)) st = site.toggleRoad(st, i);
    editor.setSite({ ...st, entrance: { edge: i, t: 0.5 } });
  }
  function removeLotCorner() {
    if (!editor || editor.siteSelection?.kind !== 'lot-vertex') return;
    if (editor.site.boundary!.length <= 3) { toast('A lot needs at least 3 corners', 'error'); return; }
    editor.setSite(site.removeVertex(editor.site, editor.siteSelection.i));
    editor.siteSelection = null;
  }
  function updateRoad(edge: number, patch: { name?: string; width?: number }) {
    if (!editor) return;
    editor.setSite({ ...editor.site, roads: (editor.site.roads ?? []).map((r) => (r.edge === edge ? { ...r, ...patch } : r)) });
  }
  let rectW = $state(20), rectD = $state(30);
  function openSite() {
    if (!editor) return;
    rectW = editor.site.width; rectD = editor.site.depth;
    sheet = 'site';
  }
  function resetLotRect() {
    if (!editor) return;
    const b = site.bounds(editor.site.boundary!);
    editor.setSite(site.replaceBoundary(editor.site, site.rectBoundary(b.x, b.y, Math.max(3, rectW), Math.max(3, rectD))));
    editor.siteSelection = null;
  }
  function startLotDrawing() {
    if (!editor) return;
    editor.mode = 'edit'; editor.tool = 'site'; editor.selection = null; editor.siteSelection = null;
    editor.drawingLot = true; editor.draft = [];
    sheet = null;
  }
  function selectTool(id: Tool) {
    if (!editor) return;
    editor.tool = id;
    editor.drawingLot = false;
    if (id !== 'select') editor.selection = null;
    if (id !== 'site') editor.siteSelection = null;
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
        <PlanCanvas bind:this={canvas} editor={ed} pins={floorPins} {onCommentTap} {onPinTap} onRoomCreated={(id) => (namingRoom = id)} onError={(m) => toast(m, 'error')} />
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
          {:else if ed.tool === 'room' && ed.roomShape === 'polygon'}{roomPolyHint}
          {:else if ed.tool === 'site' && ed.drawingLot}{lotDrawHint}
          {:else}{toolHint[ed.tool]}{/if}
        </div>
      </div>

      {#if view === '2d' && ed.plan.site}
        <div class="absolute left-3 top-12 z-10">
          <Compass northAngle={ed.plan.site.northAngle} caption={compassCaption} onstart={() => ed.pushHistory()} onrotate={(d) => setNorth(d, false)} onopen={openSite} />
        </div>
      {/if}

      {#if view === '2d'}
        <div class="absolute right-3 top-3 grid gap-2 z-10">
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom in" onclick={() => canvas?.zoomBy(1.3)}>＋</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom out" onclick={() => canvas?.zoomBy(1 / 1.3)}>－</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Fit plan to screen" onclick={() => canvas?.fit()}>⤢</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Undo" disabled={!ed.canUndo} onclick={() => ed.undo()}>↶</button>
          <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Redo" disabled={!ed.canRedo} onclick={() => ed.redo()}>↷</button>
        </div>
      {/if}

      <!-- outline being drawn (room of any shape, or a new lot) -->
      {#if view === '2d' && ed.mode === 'edit' && ((ed.tool === 'room' && ed.roomShape === 'polygon') || (ed.tool === 'site' && ed.drawingLot)) && (ed.draft.length || ed.drawingLot)}
        <div class="absolute left-2 right-2 bottom-2 z-20 card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Drawing an outline">
          <span class="text-sm font-medium flex-1 min-w-32">{ed.tool === 'site' ? 'New lot outline' : 'New room'} · {ed.draft.length} corner{ed.draft.length === 1 ? '' : 's'}</span>
          <button class="btn btn-ghost btn-sm" disabled={!ed.draft.length} onclick={() => canvas?.undoPoint()}>↶ Corner</button>
          <button class="btn btn-ghost btn-sm" onclick={() => { canvas?.finishChain(); ed.drawingLot = false; }}>Cancel</button>
          <button class="btn btn-primary btn-sm" disabled={ed.draft.length < 3} onclick={() => canvas?.closeShape()}>Done</button>
        </div>
      {:else if view === '2d' && ed.mode === 'edit' && ed.tool === 'site' && lotInfo}
        {@const ss = ed.siteSelection}
        <div class="absolute left-2 right-2 bottom-2 z-20 card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Lot and road">
          {#if ss?.kind === 'lot-edge'}
            {@const isRoad = lotInfo.roadEdges.has(ss.i)}
            <span class="text-sm font-medium flex-1 min-w-32 truncate">Side · {site.edgeLength(lotInfo.site.boundary!, ss.i).toFixed(2)} m · faces {site.edgeFacing(lotInfo.site, ss.i)}</span>
            <button class="btn btn-sm {isRoad ? 'btn-primary' : 'btn-soft'}" aria-pressed={isRoad} onclick={() => toggleRoadEdge(ss.i)}>{isRoad ? '✓ Road here' : '+ Road here'}</button>
            {#if lotInfo.front !== ss.i}<button class="btn btn-soft btn-sm" onclick={() => entranceHere(ss.i)}>➜ Entrance here</button>{/if}
          {:else if ss?.kind === 'lot-vertex'}
            <span class="text-sm font-medium flex-1">Lot corner · drag to move</span>
            <button class="btn btn-ghost btn-sm" disabled={lotInfo.site.boundary!.length <= 3} onclick={removeLotCorner}>Remove corner</button>
          {:else}
            <span class="text-sm font-medium flex-1 min-w-32 truncate">Lot · {lotInfo.area.toFixed(0)} m² · {lotInfo.presetLabel}{lotInfo.facing ? ` · main road on the ${lotInfo.facing.toLowerCase()}` : ''}</span>
            <button class="btn btn-soft btn-sm" onclick={openSite}>Roads & north</button>
            <button class="btn btn-ghost btn-sm" onclick={startLotDrawing}>Redraw lot</button>
          {/if}
        </div>
      <!-- naming chips after creating a room -->
      {:else if namingRoom && view === '2d'}
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
          {#if !sel.vertex}<button class="btn btn-soft btn-sm" onclick={() => (sheet = 'details')}>Details</button>{/if}
          <button class="btn btn-ghost btn-sm" onclick={remove}>{sel.vertex ? 'Remove corner' : 'Delete'}</button>
        </div>
      {/if}
    </div>

    <!-- bottom toolbar -->
    {#if view === '2d' && ed.mode === 'edit'}
      <nav class="border-t border-line bg-paper safe-b z-20" aria-label="Drawing tools">
        {#if ed.tool === 'room'}
          <div class="flex gap-2 px-3 pt-2 justify-start md:justify-center" role="group" aria-label="Room shape">
            <button class="chip" aria-pressed={ed.roomShape === 'polygon'} onclick={() => (ed.roomShape = 'polygon')}>⬠ Any shape</button>
            <button class="chip" aria-pressed={ed.roomShape === 'rect'} onclick={() => { ed.roomShape = 'rect'; canvas?.finishChain(); }}>▭ Rectangle</button>
          </div>
        {/if}
        <div class="flex gap-1 px-2 py-1.5 overflow-x-auto justify-start md:justify-center">
          {#each tools as t}
            <button class="flex flex-col items-center justify-center gap-0.5 min-w-[64px] min-h-[52px] px-2 rounded-2xl text-[11px] font-semibold {ed.tool === t.id ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper-2'}"
              aria-pressed={ed.tool === t.id} onclick={() => selectTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`}>
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
        <p class="text-sm text-muted">Area: <strong class="text-ink">{r.area.toFixed(1)} m²</strong> (measured to the middle of the walls), {r.polygon.length} corners. Drag a wall or a corner to reshape it; pull the ⊕ in the middle of a side to add a corner.</p>
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

  <BottomSheet open={sheet === 'site'} title="Lot, roads & north" onclose={() => (sheet = null)}>
    {#if lotInfo}
      {@const st = lotInfo.site}
      <div class="grid gap-5">
        <div class="field"><span>Which sides of the lot face a road?</span>
          <div class="flex flex-wrap gap-2" role="group" aria-label="Road layout">
            <button class="chip" aria-pressed={lotInfo.preset.preset === 'single'} onclick={() => setPreset('single')}>One road</button>
            <button class="chip" aria-pressed={lotInfo.preset.preset === 'corner'} onclick={() => setPreset('corner')}>Corner lot (L)</button>
            <button class="chip" aria-pressed={lotInfo.preset.preset === 'double'} onclick={() => setPreset('double')}>Front & back</button>
            {#if lotInfo.preset.preset === 'custom'}<span class="chip on">Custom</span>{/if}
          </div>
          {#if lotInfo.preset.preset === 'corner'}
            <div class="flex flex-wrap items-center gap-2 mt-1" role="group" aria-label="Side road">
              <span class="text-sm text-muted">Side road, seen from the main road:</span>
              <button class="chip" aria-pressed={lotInfo.preset.side === 'left'} onclick={() => setPreset('corner', 'left')}>On the left</button>
              <button class="chip" aria-pressed={lotInfo.preset.side === 'right'} onclick={() => setPreset('corner', 'right')}>On the right</button>
            </div>
          {/if}
          <p class="text-sm text-muted">The main road is the one with the ➜ entrance. To pick any other side, use <strong>🧭 Lot & road</strong> and tap that side of the lot.</p>
        </div>

        {#if lotInfo.front !== null}
          <div class="field"><span>The main road is on the {lotInfo.facing?.toLowerCase()} side. Change it:</span>
            <div class="grid grid-cols-4 gap-2 max-w-xs" role="group" aria-label="Main road faces">
              {#each site.COMPASS_POINTS as c}
                <button class="chip justify-center" aria-pressed={lotInfo.facing === c.name} onclick={() => faceRoad(c.bearing)} title={c.name}>{c.label}</button>
              {/each}
            </div>
          </div>
        {/if}
        <label class="field"><span>North: {Math.round(st.northAngle)}° from the top of the plan</span>
          <input type="range" min="0" max="355" step="5" value={st.northAngle} class="accent-[#A4502F] h-11" oninput={(e) => setNorth(+(e.target as HTMLInputElement).value, false)} onpointerdown={() => ed.pushHistory()} onkeydown={() => ed.pushHistory()} />
        </label>

        {#if st.roads?.length}
          <div class="grid gap-3">
            {#each site.roadShapes(st) as r (r.edge)}
              <div class="grid grid-cols-[1fr_auto] gap-2 items-end">
                <label class="field"><span>{r.main ? 'Main road' : 'Road'} · {site.edgeFacing(st, r.edge)} side</span>
                  <input class="input" value={st.roads.find((x) => x.edge === r.edge)?.name ?? ''} placeholder={r.name} onchange={(e) => updateRoad(r.edge, { name: (e.target as HTMLInputElement).value || undefined })} /></label>
                <label class="field"><span>Width {r.width} m</span>
                  <input type="range" min="3" max="20" step="0.5" value={r.width} class="accent-[#A4502F] h-11 w-28" onchange={(e) => updateRoad(r.edge, { width: +(e.target as HTMLInputElement).value })} /></label>
              </div>
            {/each}
          </div>
        {/if}

        <div class="field"><span>Lot shape · {lotInfo.area.toFixed(0)} m², {st.boundary!.length} corners</span>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-soft btn-sm" onclick={() => { sheet = null; selectTool('site'); canvas?.fit(); }}>Edit corners</button>
            <button class="btn btn-ghost btn-sm" onclick={startLotDrawing}>Redraw outline</button>
          </div>
          <div class="flex flex-wrap items-end gap-2 mt-2">
            <label class="field w-24"><span>Width (m)</span><input class="input" type="number" min="3" max="300" step="0.5" bind:value={rectW} /></label>
            <label class="field w-24"><span>Depth (m)</span><input class="input" type="number" min="3" max="300" step="0.5" bind:value={rectD} /></label>
            <button class="btn btn-ghost btn-sm" onclick={resetLotRect}>Make it a rectangle</button>
          </div>
        </div>
      </div>
    {/if}
  </BottomSheet>

  <BottomSheet open={sheet === 'advanced'} title="Advanced" onclose={() => (sheet = null)}>
    <div class="grid gap-5">
      <label class="flex items-center gap-3"><input type="checkbox" class="w-5 h-5 accent-[#A4502F]" bind:checked={ed.snapping} /> Snap to 10 cm grid and wall corners</label>
      <label class="flex items-center gap-3"><input type="checkbox" class="w-5 h-5 accent-[#A4502F]" bind:checked={ed.showDims} /> Show length of the selected wall</label>
      <label class="field"><span>New wall thickness: {(ed.newWallThickness * 100).toFixed(0)} cm</span><input type="range" min="0.08" max="0.35" step="0.01" bind:value={ed.newWallThickness} class="accent-[#A4502F] h-11" /></label>
      <label class="field"><span>Ceiling height: {ed.floor.height.toFixed(2)} m</span><input type="range" min="2.4" max="3.6" step="0.05" value={ed.floor.height} class="accent-[#A4502F] h-11" onchange={(e) => ed.commit((f) => { f.height = +(e.target as HTMLInputElement).value; }, { recompute: false })} /></label>
      <button class="btn btn-soft btn-sm justify-self-start" onclick={openSite}>🧭 Lot, roads & north…</button>
      <div class="flex gap-2 flex-wrap">
        <button class="btn btn-soft btn-sm" onclick={() => ed.addFloor()} disabled={ed.plan.floors.length >= 3}>+ Add floor</button>
        <button class="btn btn-ghost btn-sm" onclick={() => ed.removeFloor()} disabled={ed.plan.floors.length < 2}>Remove this floor</button>
        <button class="btn btn-ghost btn-sm" onclick={exportSvg}>Export floor as SVG</button>
        <button class="btn btn-ghost btn-sm" onclick={() => downloadJSON($state.snapshot(ed.plan), 'planspec.json')}>Export PlanSpec JSON</button>
        <button class="btn btn-ghost btn-sm" onclick={() => { showCoach = true; sheet = null; }}>Show tips again</button>
      </div>
      <p class="text-xs text-muted">Rooms and areas are detected automatically from the walls (openPlan3D room detection). Shortcuts: V move, R room, W wall, D door, N window, X remove, L lot & road, C comment, Ctrl+Z undo. While drawing an outline: Enter finishes, Backspace removes the last corner.</p>
    </div>
  </BottomSheet>
{/if}
