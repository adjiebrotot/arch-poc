<script lang="ts">
  /**
   * Step 2: floor footprints. The ground floor is drawn point by point inside the lot (1 m grid).
   * Each added floor starts as an exact copy of the floor below, which stays visible as a
   * silhouette; it can be reshaped or made smaller but never reach outside the floor below.
   * Sketch mode defines the ground floor here and adds upper floors later in the workspace;
   * Template and Tell us define every floor before any room is generated.
   */
  import { onMount } from 'svelte';
  import { toast } from '@shared/stores/session';
  import { floorLabel, type PlanSpec } from '@shared/planspec/schema';
  import { footprintArea, containerFor, snapToGrid } from '@shared/planspec/envelope';
  import { interiorPoint, type Vec2 } from '@shared/util/geometry';
  import * as site from '@shared/planspec/site';
  import type { Editor } from '../workspace/editor.svelte';
  import PlanCanvas from '../workspace/PlanCanvas.svelte';

  let { editor, mode, onback, onnext }: { editor: Editor; mode: PlanSpec['meta']['mode']; onback: () => void; onnext: () => void } = $props();

  let canvas: PlanCanvas | undefined = $state();
  let showMap = $state(true);
  const MAX_FLOORS = 3;
  const sketch = $derived(mode === 'pro');
  const floors = $derived(sketch ? editor.plan.floors.slice(0, 1) : editor.plan.floors);
  const fp = $derived(editor.floor.footprint ?? null);
  const geo = $derived(editor.plan.site?.geo ?? null);
  const allDrawn = $derived(floors.every((f) => (f.footprint?.length ?? 0) >= 3));
  const total = $derived(floors.reduce((s, f) => s + footprintArea(f.footprint), 0));
  const top = $derived(editor.plan.floors.length - 1);

  onMount(() => {
    editor.mode = 'edit';
    editor.tool = 'footprint';
    editor.selection = null;
    editor.siteSelection = null;
    if (sketch) editor.floorIdx = 0;
    if (!editor.floor.footprint) { editor.drawingFootprint = true; editor.draft = []; }
  });

  function pickFloor(i: number) {
    editor.floorIdx = i;
    editor.siteSelection = null;
    editor.draft = [];
    editor.drawingFootprint = !editor.plan.floors[i].footprint;
  }
  function addFloor() {
    if (!editor.plan.floors[top].footprint) return toast(`Draw the ${floorLabel(top).toLowerCase()} first`, 'error');
    editor.addFloor(false);
    editor.tool = 'footprint';
    editor.drawingFootprint = false;
    toast(`${floorLabel(editor.floor.level)} starts as a copy of the floor below. Drag its corners to make it smaller or change its shape.`, 'info', 5000);
  }
  function removeTop() {
    if (top === 0) return;
    editor.floorIdx = top;
    editor.removeFloor();
    pickFloor(Math.min(editor.floorIdx, editor.plan.floors.length - 1));
  }
  function redraw() {
    editor.siteSelection = null;
    editor.draft = [];
    editor.drawingFootprint = true;
  }
  function removeCorner() {
    if (editor.siteSelection?.kind !== 'fp-vertex') return;
    const err = editor.removeFootprintVertex(editor.siteSelection.i);
    if (err) toast(err, 'error');
  }

  // quick start: a rectangle in the middle of the lot (or the floor below)
  let rw = $state(12), rd = $state(10);
  function useRect() {
    const c = containerFor(editor.plan, editor.floorIdx).poly;
    if (!c) return;
    const m = snapToGrid(interiorPoint(c));
    const w = Math.max(3, Math.round(rw)), d = Math.max(3, Math.round(rd));
    const x0 = m[0] - Math.floor(w / 2), y0 = m[1] - Math.floor(d / 2);
    const err = editor.replaceFootprint(site.rectBoundary(x0, y0, w, d) as Vec2[]);
    if (err) return toast(`${err}. Try a smaller size, or tap the corners yourself.`, 'error');
    editor.draft = [];
    canvas?.fit();
  }

  const label = $derived(floorLabel(editor.floor.level));
  const inside = $derived(containerFor(editor.plan, editor.floorIdx).label);
</script>

<div class="absolute inset-0">
  <PlanCanvas bind:this={canvas} {editor} map={geo && showMap ? { lat: geo.lat, lon: geo.lon, rotation: geo.rotation } : null} mapOpacity={0.45} padBottom={90}
    onFootprintDrawn={() => { toast(`${label} footprint drawn: ${footprintArea(editor.floor.footprint).toFixed(0)} m²`, 'success'); }} onError={(m) => toast(m, 'error')} />

  <div class="absolute top-3 left-3 right-16 pointer-events-none grid gap-2 justify-items-start">
    <div class="flex gap-1 pointer-events-auto flex-wrap" role="tablist" aria-label="Floors">
      {#each floors as f, i}
        <button role="tab" aria-selected={editor.floorIdx === i} class="px-3 py-1.5 rounded-full text-sm border shadow-sm whitespace-nowrap {editor.floorIdx === i ? 'bg-ink text-white border-ink' : 'bg-white border-line hover:bg-paper-2'}" onclick={() => pickFloor(i)}>
          {floorLabel(f.level)}{#if f.footprint}<span class="opacity-70">{` · ${footprintArea(f.footprint).toFixed(0)} m²`}</span>{:else}<span class="opacity-70">{' · to draw'}</span>{/if}
        </button>
      {/each}
      {#if !sketch}
        <button class="px-3 py-1.5 rounded-full text-sm border border-dashed border-line bg-white/90 shadow-sm whitespace-nowrap hover:bg-paper-2 disabled:opacity-40" disabled={editor.plan.floors.length >= MAX_FLOORS || !allDrawn} onclick={addFloor}>+ Add floor</button>
      {/if}
    </div>
    <div class="rounded-full bg-white/90 border border-line px-3 py-1.5 text-xs text-ink-2 shadow-sm max-w-full truncate">
      {#if editor.drawingFootprint}
        Tap each corner of the {label.toLowerCase()} (1 m grid), inside {inside} · tap the first corner (or Done) to finish
      {:else if editor.floorIdx > 0}
        Drag corners to shape {label} · pull a ⊕ to add a corner · it can't reach outside the floor below (hatched)
      {:else}
        Drag corners (1 m grid) · pull a ⊕ to add a corner · the footprint stays inside the lot
      {/if}
    </div>
  </div>

  <div class="absolute right-3 top-3 grid gap-2 z-10">
    <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom in" onclick={() => canvas?.zoomBy(1.3)}>＋</button>
    <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom out" onclick={() => canvas?.zoomBy(1 / 1.3)}>－</button>
    <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Fit to screen" onclick={() => canvas?.fit()}>⤢</button>
    {#if geo}<button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label={showMap ? 'Hide the map' : 'Show the map'} aria-pressed={showMap} onclick={() => (showMap = !showMap)}>🗺️</button>{/if}
  </div>

  <div class="absolute left-2 right-2 bottom-2 z-20">
    {#if editor.drawingFootprint}
      <div class="card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Drawing a footprint">
        <span class="text-sm font-medium flex-1 min-w-32">{label} footprint · {editor.draft.length} corner{editor.draft.length === 1 ? '' : 's'}</span>
        {#if !editor.draft.length}
          <span class="flex items-center gap-1 text-sm">or a rectangle
            <input class="input !min-h-9 !w-16 !py-1 text-center" type="number" min="3" max="100" bind:value={rw} aria-label="Width in metres" /> ×
            <input class="input !min-h-9 !w-16 !py-1 text-center" type="number" min="3" max="100" bind:value={rd} aria-label="Depth in metres" /> m
            <button class="btn btn-soft btn-sm" onclick={useRect}>Use</button>
          </span>
        {/if}
        <button class="btn btn-ghost btn-sm" disabled={!editor.draft.length} onclick={() => canvas?.undoPoint()}>↶ Corner</button>
        {#if fp}<button class="btn btn-ghost btn-sm" onclick={() => { editor.drawingFootprint = false; editor.draft = []; }}>Cancel</button>{/if}
        <button class="btn btn-primary btn-sm" disabled={editor.draft.length < 3} onclick={() => canvas?.closeShape()}>Done</button>
      </div>
    {:else}
      {@const ss = editor.siteSelection}
      <div class="card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Footprint">
        {#if ss?.kind === 'fp-vertex'}
          <span class="text-sm font-medium flex-1">Corner · drag to move</span>
          <button class="btn btn-ghost btn-sm" disabled={(fp?.length ?? 0) <= 3} onclick={removeCorner}>Remove corner</button>
          <button class="btn btn-ghost btn-sm" onclick={() => (editor.siteSelection = null)}>Done</button>
        {:else}
          <span class="text-sm font-medium flex-1 min-w-32 truncate">
            {label} · {footprintArea(fp ?? undefined).toFixed(0)} m² · inside {inside}{#if !sketch && floors.length > 1} · {floors.length} floors, {total.toFixed(0)} m² in all{/if}
          </span>
          <button class="btn btn-ghost btn-sm" onclick={onback}>← Lot</button>
          <button class="btn btn-ghost btn-sm" onclick={redraw}>Redraw</button>
          {#if !sketch && editor.floorIdx === top && top > 0}<button class="btn btn-ghost btn-sm" onclick={removeTop}>Remove {label}</button>{/if}
          <button class="btn btn-primary btn-sm" disabled={!allDrawn} onclick={onnext}>
            {sketch ? 'Next: draw rooms →' : mode === 'creative' ? 'Next: pick a template →' : 'Next: describe your home →'}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
