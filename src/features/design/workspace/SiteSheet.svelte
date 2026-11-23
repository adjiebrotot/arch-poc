<script lang="ts">
  /** Lot, roads & north settings (shared by the setup flow and the workspace). */
  import BottomSheet from '@shared/ui/BottomSheet.svelte';
  import * as site from '@shared/planspec/site';
  import type { Editor } from './editor.svelte';

  let { editor, open, onclose, onEditCorners, onRedraw, onError }: {
    editor: Editor; open: boolean; onclose: () => void;
    onEditCorners?: () => void; onRedraw?: () => void; onError?: (m: string) => void;
  } = $props();

  const info = $derived.by(() => {
    const st = editor.plan.site;
    if (!st?.boundary) return null;
    const front = site.frontEdge(st);
    return {
      st, front,
      preset: site.detectPreset(st),
      area: site.lotArea(st),
      facing: front !== null ? site.edgeFacing(st, front) : null,
      fromMap: st.source === 'map',
    };
  });
  let cornerSide = $state<site.Side>('right');

  function setPreset(p: site.RoadPreset, side: site.Side = cornerSide) {
    if (p === 'corner') cornerSide = side;
    editor.setSite(site.applyPreset(editor.site, p, side));
  }
  function setNorth(deg: number, history = true) {
    editor.setSite({ ...editor.site, northAngle: ((Math.round(deg) % 360) + 360) % 360 }, history);
  }
  function faceRoad(bearing: number) {
    if (info?.front == null) return;
    setNorth(site.northForFacing(site.outwardNormal(editor.site.boundary!, info.front), bearing));
  }
  function updateRoad(edge: number, patch: { name?: string; width?: number }) {
    editor.setSite({ ...editor.site, roads: (editor.site.roads ?? []).map((r) => (r.edge === edge ? { ...r, ...patch } : r)) });
  }
  let rectW = $state(20), rectD = $state(30);
  $effect(() => { if (open && info) { rectW = Math.round(info.st.width); rectD = Math.round(info.st.depth); } });
  function makeRect() {
    const b = site.bounds(editor.site.boundary!);
    const err = editor.replaceLot(site.rectBoundary(Math.round(b.x), Math.round(b.y), Math.max(3, Math.round(rectW)), Math.max(3, Math.round(rectD))));
    if (err) onError?.(err);
  }
</script>

<BottomSheet {open} title="Lot, roads & north" {onclose}>
  {#if info}
    {@const st = info.st}
    <div class="grid gap-5">
      <div class="field"><span>Which sides of the lot face a road?</span>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Road layout">
          <button class="chip" aria-pressed={info.preset.preset === 'single'} onclick={() => setPreset('single')}>One road</button>
          <button class="chip" aria-pressed={info.preset.preset === 'corner'} onclick={() => setPreset('corner')}>Corner lot (L)</button>
          <button class="chip" aria-pressed={info.preset.preset === 'double'} onclick={() => setPreset('double')}>Front & back</button>
          {#if info.preset.preset === 'custom'}<span class="chip on">Custom</span>{/if}
        </div>
        {#if info.preset.preset === 'corner'}
          <div class="flex flex-wrap items-center gap-2 mt-1" role="group" aria-label="Side road">
            <span class="text-sm text-muted">Side road, seen from the main road:</span>
            <button class="chip" aria-pressed={info.preset.side === 'left'} onclick={() => setPreset('corner', 'left')}>On the left</button>
            <button class="chip" aria-pressed={info.preset.side === 'right'} onclick={() => setPreset('corner', 'right')}>On the right</button>
          </div>
        {/if}
        <p class="text-sm text-muted">The main road is the one with the ➜ entrance. To pick any other side, tap that side of the lot.</p>
      </div>

      {#if info.fromMap}
        <p class="text-sm rounded-2xl bg-paper-2 p-3">🧭 North comes from the map: the main road faces <strong>{info.facing?.toLowerCase() ?? '—'}</strong> and north is {Math.round(st.northAngle)}° from the top of the plan. Redraw the lot on the grid if you want to set it by hand.</p>
      {:else}
        {#if info.front !== null}
          <div class="field"><span>The main road is on the {info.facing?.toLowerCase()} side. Change it:</span>
            <div class="grid grid-cols-4 gap-2 max-w-xs" role="group" aria-label="Main road faces">
              {#each site.COMPASS_POINTS as c}
                <button class="chip justify-center" aria-pressed={info.facing === c.name} onclick={() => faceRoad(c.bearing)} title={c.name}>{c.label}</button>
              {/each}
            </div>
          </div>
        {/if}
        <label class="field"><span>North: {Math.round(st.northAngle)}° from the top of the plan</span>
          <input type="range" min="0" max="355" step="5" value={st.northAngle} class="accent-[#A4502F] h-11" oninput={(e) => setNorth(+(e.target as HTMLInputElement).value, false)} onpointerdown={() => editor.pushHistory()} onkeydown={() => editor.pushHistory()} />
        </label>
      {/if}

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

      <div class="field"><span>Lot shape · {info.area.toFixed(0)} m², {st.boundary!.length} corners</span>
        <div class="flex flex-wrap gap-2">
          {#if onEditCorners}<button class="btn btn-soft btn-sm" onclick={onEditCorners}>Edit corners</button>{/if}
          {#if onRedraw}<button class="btn btn-ghost btn-sm" onclick={onRedraw}>Redraw outline</button>{/if}
        </div>
        {#if !info.fromMap}
          <div class="flex flex-wrap items-end gap-2 mt-2">
            <label class="field w-24"><span>Width (m)</span><input class="input" type="number" min="3" max="300" step="1" bind:value={rectW} /></label>
            <label class="field w-24"><span>Depth (m)</span><input class="input" type="number" min="3" max="300" step="1" bind:value={rectD} /></label>
            <button class="btn btn-ghost btn-sm" onclick={makeRect}>Make it a rectangle</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</BottomSheet>
