<script lang="ts">
  /**
   * Step 1 (every mode): the lot. Never assumed to be rectangular.
   *  A. On a blank 1 m grid: place corners (snapped to 1 m) to close a polygon, then mark the
   *     street side(s) and set north with the compass.
   *  B. Over an OpenStreetMap map: find the address, trace the boundary; north comes from the map
   *     and the street side is detected from the roads around it.
   */
  import { onMount, untrack } from 'svelte';
  import { toast } from '@shared/stores/session';
  import type { Site } from '@shared/planspec/schema';
  import * as site from '@shared/planspec/site';
  import { rotatePoint, dist, type Vec2 } from '@shared/util/geometry';
  import { searchPlaces, fetchRoads, detectFrontage, streetAtBottom, type Place } from '@shared/geo/osm';
  import type { Editor } from '../workspace/editor.svelte';
  import PlanCanvas from '../workspace/PlanCanvas.svelte';
  import Compass from '../workspace/Compass.svelte';
  import SiteSheet from '../workspace/SiteSheet.svelte';

  let { editor, onnext }: { editor: Editor; onnext: () => void } = $props();

  const st = $derived(editor.plan.site?.boundary ? editor.plan.site : null);
  const hasGround = $derived(!!editor.plan.floors[0]?.footprint);
  const initial = untrack(() => editor.plan.site);
  let method = $state<'grid' | 'map' | null>(initial?.boundary ? (initial.source === 'map' ? 'map' : 'grid') : null);
  let canvas: PlanCanvas | undefined = $state();
  let sheet = $state(false);

  // map state
  let origin = $state<{ lat: number; lon: number; label: string } | null>(initial?.geo ? { lat: initial.geo.lat, lon: initial.geo.lon, label: initial.geo.label ?? '' } : null);
  let query = $state('');
  let results = $state<Place[]>([]);
  let searching = $state(false);
  let searchMsg = $state('');
  let detecting = $state(false);
  let roadMsg = $state('');

  onMount(() => {
    editor.mode = 'edit';
    editor.tool = 'site';
    editor.floorIdx = 0;
    editor.lotGrid = method !== 'map';
    if (method && !st) editor.drawingLot = true;
  });

  function choose(m: 'grid' | 'map') {
    method = m;
    editor.lotGrid = m === 'grid';
    editor.tool = 'site';
    editor.draft = [];
    editor.drawingLot = m === 'grid';
    queueMicrotask(() => canvas?.fit());
  }

  /** Main road on the side facing down the screen (the usual way a plan is drawn). */
  function bottomRoad(s: Site): Site {
    const b = s.boundary!;
    let best = 0, by = -Infinity;
    b.forEach((_, i) => { const n = site.outwardNormal(b, i); const v = n[1] * Math.min(1, site.edgeLength(b, i) / 3); if (v > by) { by = v; best = i; } });
    return { ...s, roads: [{ edge: best }], entrance: { edge: best, t: 0.5 } };
  }

  // ---- A. grid --------------------------------------------------------------------------------
  let rectW = $state(20), rectD = $state(30);
  function gridDrawn() {
    editor.setSite(bottomRoad({ ...editor.site, source: 'grid', geo: undefined }), false);
    toast('Lot drawn. Tap the side that faces the street, and turn the compass to point north.', 'success', 4500);
    canvas?.fit();
  }
  function useRect() {
    const w = Math.max(5, Math.round(rectW)), d = Math.max(5, Math.round(rectD));
    const err = editor.replaceLot(site.rectBoundary(0, 0, w, d), { source: 'grid', geo: undefined });
    if (err) return toast(err, 'error');
    editor.drawingLot = false;
    editor.draft = [];
    gridDrawn();
  }

  // ---- B. map ---------------------------------------------------------------------------------
  async function search(e?: Event) {
    e?.preventDefault();
    if (!query.trim()) return;
    searching = true; searchMsg = ''; results = [];
    try {
      results = await searchPlaces(query.trim());
      if (!results.length) searchMsg = 'Nothing found. Try the street and suburb, or type coordinates like -33.8688, 151.2093.';
    } catch {
      searchMsg = "Couldn't reach the map search. Check your connection, or type coordinates like -33.8688, 151.2093.";
    } finally {
      searching = false;
    }
  }
  function pick(p: Place) {
    origin = { lat: p.lat, lon: p.lon, label: p.label };
    results = [];
    editor.lotGrid = false;
    editor.tool = 'site';
    editor.drawingLot = true;
    editor.draft = [];
    queueMicrotask(() => canvas?.fit());
  }
  function here() {
    if (!navigator.geolocation) return toast('This device can’t share its location', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => pick({ label: 'My location', lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => toast('Location not available. Search for the address instead.', 'error'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  /** Turn the plan so `r` degrees clockwise from north-up; the lot turns with it and north follows. */
  function orient(r: number) {
    const s = editor.plan.site;
    if (!s?.boundary || !s.geo) return;
    const d = r - s.geo.rotation;
    const boundary = s.boundary.map((p) => rotatePoint(p, d).map((v) => Math.round(v * 1000) / 1000) as Vec2);
    const next: Site = { ...structuredClone($state.snapshot(s)) as Site, boundary, northAngle: ((Math.round(r) % 360) + 360) % 360, geo: { ...s.geo, rotation: r } };
    site.syncSize(next);
    editor.setSite(next);
    queueMicrotask(() => canvas?.fit());
  }
  const rotation = $derived(st?.geo?.rotation ?? 0);
  const streetRotation = $derived(st?.boundary && st.roads?.length ? (() => {
    const fe = site.frontEdge(st);
    if (fe === null) return null;
    // the rotation that would put the main side at the bottom, from the map's north-up frame
    const mapB = st.boundary!.map((p) => rotatePoint(p, -rotation));
    return streetAtBottom(mapB, fe);
  })() : null);

  async function mapDrawn() {
    if (!origin) return;
    const s0 = editor.site;
    let s: Site = { ...s0, source: 'map', northAngle: 0, geo: { lat: origin.lat, lon: origin.lon, rotation: 0, label: origin.label } };
    s = bottomRoad(s);
    editor.setSite(s, false);
    detecting = true; roadMsg = '';
    try {
      const b = s.boundary!;
      const radius = Math.max(...b.map((p) => dist(p, [0, 0]))) + 45;
      const roads = await fetchRoads(origin, Math.min(400, radius));
      const fr = detectFrontage(b, roads);
      if (fr.length) {
        const edges = [...new Map(fr.map((f) => [f.edge, f])).values()];
        const cur = editor.site;
        editor.setSite({ ...cur, roads: edges.map((f) => ({ edge: f.edge, ...(f.name ? { name: f.name } : {}) })).sort((a, b2) => a.edge - b2.edge), entrance: { edge: edges[0].edge, t: 0.5 } }, false);
        roadMsg = `Street found: ${edges[0].name ?? 'an unnamed road'}${edges.length > 1 ? ` (+${edges.length - 1} more side${edges.length > 2 ? 's' : ''})` : ''}. Tap a side to change it.`;
        orient(streetAtBottom(b, edges[0].edge));
      } else {
        roadMsg = 'No street found next to the lot. Tap the side that faces the street.';
      }
    } catch {
      roadMsg = "Couldn't reach OpenStreetMap's road data. Tap the side that faces the street.";
    } finally {
      detecting = false;
    }
    canvas?.fit();
  }
  function lotDrawn() {
    if (method === 'map') mapDrawn();
    else gridDrawn();
  }
  function startOver() {
    if (hasGround) return;
    editor.pushHistory();
    editor.plan.site = undefined;
    editor.siteSelection = null;
    editor.onChange?.();
    if (method === 'grid') { editor.drawingLot = true; editor.draft = []; }
    else if (origin) { editor.drawingLot = true; editor.draft = []; }
  }

  // ---- sides, roads, entrance -------------------------------------------------------------------
  const info = $derived.by(() => {
    if (!st) return null;
    const front = site.frontEdge(st);
    return { area: site.lotArea(st), front, facing: front !== null ? site.edgeFacing(st, front) : null, roadEdges: new Set((st.roads ?? []).map((r) => r.edge)) };
  });
  function toggleRoad(i: number) { editor.setSite(site.toggleRoad(editor.site, i)); }
  function entranceHere(i: number) {
    let s = editor.site;
    if (!s.roads?.some((r) => r.edge === i)) s = site.toggleRoad(s, i);
    editor.setSite({ ...s, entrance: { edge: i, t: 0.5 } });
  }
  function removeCorner() {
    if (editor.siteSelection?.kind !== 'lot-vertex') return;
    const err = editor.removeLotVertex(editor.siteSelection.i);
    if (err) toast(err, 'error');
  }
  function setNorth(deg: number) { editor.setSite({ ...editor.site, northAngle: ((Math.round(deg) % 360) + 360) % 360 }, false); }
</script>

{#if !method}
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto px-4 py-8 md:py-14 grid gap-6">
      <div class="grid gap-2">
        <p class="eyebrow">Step 1 · Your lot</p>
        <h1 class="text-2xl md:text-4xl font-semibold tracking-tight">Where will the house go?</h1>
        <p class="text-ink-2">Start with the shape of your land. It can be any shape: you place its corners one by one.</p>
      </div>
      <div class="grid sm:grid-cols-2 gap-4">
        <button class="card p-6 text-left grid gap-3 hover:border-ink" onclick={() => choose('grid')}>
          <div class="w-12 h-12 rounded-2xl bg-paper-2 grid place-items-center text-2xl" aria-hidden="true">📐</div>
          <h2 class="text-lg font-semibold">Draw it on a grid</h2>
          <p class="text-sm text-ink-2">Tap each corner of your lot on a 1 m grid. Then show which side faces the street and turn the compass to point north.</p>
          <span class="btn btn-primary btn-sm justify-self-start">Draw on a grid →</span>
        </button>
        <button class="card p-6 text-left grid gap-3 hover:border-ink" onclick={() => choose('map')}>
          <div class="w-12 h-12 rounded-2xl bg-paper-2 grid place-items-center text-2xl" aria-hidden="true">🗺️</div>
          <h2 class="text-lg font-semibold">Find it on a map</h2>
          <p class="text-sm text-ink-2">Search your address and trace the lot over OpenStreetMap. North and the street are taken from the map.</p>
          <span class="btn btn-primary btn-sm justify-self-start">Use the map →</span>
        </button>
      </div>
    </div>
  </div>
{:else if method === 'map' && !origin}
  <div class="h-full overflow-y-auto">
    <div class="max-w-xl mx-auto px-4 py-8 md:py-14 grid gap-4">
      <button class="text-sm text-muted hover:text-ink justify-self-start" onclick={() => (method = null)}>← Other ways to draw the lot</button>
      <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Find your lot</h1>
      <form class="flex gap-2" onsubmit={search}>
        <label class="sr-only" for="addr">Address</label>
        <input id="addr" class="input flex-1" placeholder="Street address, suburb, or -33.8688, 151.2093" bind:value={query} autocomplete="street-address" />
        <button class="btn btn-primary" disabled={!query.trim() || searching}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      <button class="btn btn-ghost btn-sm justify-self-start" onclick={here}>📍 Use my location</button>
      {#if searchMsg}<p class="text-sm text-warn" role="status">{searchMsg}</p>{/if}
      {#if results.length}
        <ul class="card divide-y divide-line overflow-hidden" aria-label="Search results">
          {#each results as r}
            <li><button class="w-full text-left px-4 py-3 hover:bg-paper-2 text-sm" onclick={() => pick(r)}>{r.label}</button></li>
          {/each}
        </ul>
      {/if}
      <p class="text-xs text-muted">Search uses OpenStreetMap Nominatim; your query is sent to it. Map data {'©'} OpenStreetMap contributors.</p>
    </div>
  </div>
{:else}
  <div class="absolute inset-0">
    <PlanCanvas bind:this={canvas} {editor} map={method === 'map' && origin ? { lat: origin.lat, lon: origin.lon, rotation } : null} emptyView={method === 'map' ? 90 : 40} padBottom={st?.source === 'map' ? 170 : 110}
      onLotDrawn={lotDrawn} onError={(m) => toast(m, 'error')} />

    <div class="absolute top-3 left-3 right-16 pointer-events-none flex">
      <div class="rounded-full bg-white/90 border border-line px-3 py-1.5 text-xs text-ink-2 shadow-sm max-w-full truncate">
        {#if editor.drawingLot}
          {method === 'map' ? 'Trace your lot: tap each corner over the map · tap the first corner (or Done) to finish' : 'Tap each corner of your lot (snaps to 1 m) · tap the first corner (or Done) to finish'}
        {:else}
          Tap a side to mark the street · drag corners (pull a ⊕ to add one) · drag the ➜ entrance
        {/if}
      </div>
    </div>

    {#if st}
      <div class="absolute left-3 top-12 z-10">
        <Compass northAngle={st.northAngle} caption={info?.facing ? `Street: ${info.facing}` : 'No street'} locked={st.source === 'map'}
          onstart={() => editor.pushHistory()} onrotate={setNorth} onopen={() => (sheet = true)} />
      </div>
    {/if}

    <div class="absolute right-3 top-3 grid gap-2 z-10">
      <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom in" onclick={() => canvas?.zoomBy(1.3)}>＋</button>
      <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom out" onclick={() => canvas?.zoomBy(1 / 1.3)}>－</button>
      <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Fit to screen" onclick={() => canvas?.fit()}>⤢</button>
    </div>

    <div class="absolute left-2 right-2 bottom-2 z-20 grid gap-2">
      {#if detecting}
        <div class="card px-3 py-2 shadow-lg text-sm" role="status">Looking up the streets around your lot…</div>
      {:else if roadMsg && st}
        <div class="card px-3 py-2 shadow-lg text-sm flex items-center gap-2" role="status"><span class="flex-1">{roadMsg}</span><button class="btn btn-ghost btn-sm" onclick={() => (roadMsg = '')}>OK</button></div>
      {/if}

      {#if editor.drawingLot}
        <div class="card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Drawing the lot">
          <span class="text-sm font-medium flex-1 min-w-32">New lot · {editor.draft.length} corner{editor.draft.length === 1 ? '' : 's'}</span>
          {#if method === 'grid' && !editor.draft.length}
            <span class="flex items-center gap-1 text-sm">or a rectangle
              <input class="input !min-h-9 !w-16 !py-1 text-center" type="number" min="5" max="300" bind:value={rectW} aria-label="Width in metres" /> ×
              <input class="input !min-h-9 !w-16 !py-1 text-center" type="number" min="5" max="300" bind:value={rectD} aria-label="Depth in metres" /> m
              <button class="btn btn-soft btn-sm" onclick={useRect}>Use</button>
            </span>
          {/if}
          {#if method === 'map'}<button class="btn btn-ghost btn-sm" onclick={() => { origin = null; editor.draft = []; }}>New search</button>{/if}
          <button class="btn btn-ghost btn-sm" disabled={!editor.draft.length} onclick={() => canvas?.undoPoint()}>↶ Corner</button>
          {#if st}<button class="btn btn-ghost btn-sm" onclick={() => { editor.drawingLot = false; editor.draft = []; }}>Cancel</button>{/if}
          <button class="btn btn-primary btn-sm" disabled={editor.draft.length < 3} onclick={() => canvas?.closeShape()}>Done</button>
        </div>
      {:else if st && info}
        {@const ss = editor.siteSelection}
        <div class="card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap" role="group" aria-label="Lot">
          {#if ss?.kind === 'lot-edge'}
            {@const isRoad = info.roadEdges.has(ss.i)}
            <span class="text-sm font-medium flex-1 min-w-32 truncate">Side · {site.edgeLength(st.boundary!, ss.i).toFixed(2)} m · faces {site.edgeFacing(st, ss.i)}</span>
            <button class="btn btn-sm {isRoad ? 'btn-primary' : 'btn-soft'}" aria-pressed={isRoad} onclick={() => toggleRoad(ss.i)}>{isRoad ? '✓ Street here' : '+ Street here'}</button>
            {#if info.front !== ss.i}<button class="btn btn-soft btn-sm" onclick={() => entranceHere(ss.i)}>➜ Main entrance here</button>{/if}
          {:else if ss?.kind === 'lot-vertex'}
            <span class="text-sm font-medium flex-1">Lot corner · drag to move</span>
            <button class="btn btn-ghost btn-sm" disabled={st.boundary!.length <= 3} onclick={removeCorner}>Remove corner</button>
          {:else}
            <span class="text-sm font-medium flex-1 min-w-32 truncate">Lot · {info.area.toFixed(0)} m²{info.facing ? ` · street on the ${info.facing.toLowerCase()} side` : ' · no street yet'}</span>
            <button class="btn btn-soft btn-sm" onclick={() => (sheet = true)}>Streets & north</button>
            {#if !hasGround}<button class="btn btn-ghost btn-sm" onclick={startOver}>Start over</button>{/if}
            <button class="btn btn-primary btn-sm" disabled={!info.roadEdges.size} title={info.roadEdges.size ? '' : 'Mark the side that faces the street first'} onclick={onnext}>Next: floors →</button>
          {/if}
        </div>
        {#if st.source === 'map' && !hasGround && streetRotation !== null}
          <div class="card px-3 py-2 shadow-lg flex items-center gap-2 flex-wrap text-sm" role="group" aria-label="Plan orientation">
            <span class="flex-1 min-w-32">Plan orientation (north stays true either way)</span>
            <button class="chip" aria-pressed={Math.abs(rotation - streetRotation) < 0.5} onclick={() => orient(streetRotation)}>⬇ Street at the bottom</button>
            <button class="chip" aria-pressed={Math.abs(rotation) < 0.5} onclick={() => orient(0)}>⬆ North up</button>
          </div>
        {/if}
      {/if}
    </div>
    <SiteSheet {editor} open={sheet} onclose={() => (sheet = false)} onEditCorners={() => { sheet = false; editor.tool = 'site'; canvas?.fit(); }} onError={(m) => toast(m, 'error')} />
  </div>
{/if}
