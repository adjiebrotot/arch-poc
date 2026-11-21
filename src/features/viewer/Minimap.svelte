<script lang="ts">
  import type { ViewerEngine } from './engine/ViewerEngine';
  import { sliceModel } from './model/slice';
  import { onMount } from 'svelte';
  import { toast } from '@shared/stores/session';

  let { engine }: { engine: ViewerEngine } = $props();
  let canvas: HTMLCanvasElement;
  let big = $state(false);
  const S = 300; // backing-store size; CSS scales it
  const cache = new Map<string, number[][]>();
  // svelte-ignore state_referenced_locally
  const eng = engine;
  const b = eng.focus;
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) + 4;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const toPx = (x: number, z: number) => [S / 2 + ((x - cx) / span) * S, S / 2 + ((z - cz) / span) * S];
  const storeys = eng.walkStoreys;

  // the storey with the most walls (shown in orbit mode until you pick one)
  const wallCount = (n: string) => eng.model.elements.filter((e) => e.storey === n && /Wall/.test(e.type)).length;
  const mainIdx = storeys.indexOf([...storeys].sort((a, b) => wallCount(b.name) - wallCount(a.name))[0]);

  /** storey shown on the map: follows you in walk mode, chosen with ▲▼ in orbit mode */
  let viewIdx = $state(Math.max(0, mainIdx));
  let isWalk = $state(eng.mode === 'walk');
  const canUp = $derived(viewIdx < storeys.length - 1);
  const canDown = $derived(viewIdx > 0);

  // drag state: while dragging, the marker follows your finger and you move with it
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let dragPt: [number, number] | null = null;
  let pending: [number, number] | null = null;
  let raf2 = 0;

  onMount(() => {
    const ctx = canvas.getContext('2d')!;
    let raf = 0, last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 66) return;
      last = t;
      isWalk = eng.mode === 'walk';
      const cam = eng.scene.activeCamera!;
      if (isWalk && !drag) viewIdx = eng.storeyIndexAt(cam.position.y);
      const st = storeys[viewIdx];
      const key = st?.name ?? '';
      if (!cache.has(key)) cache.set(key, sliceModel(eng.model, (st?.elevation ?? 0) + 1.2));
      ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = '#1F2326';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (const s of cache.get(key)!) { const a = toPx(s[0], s[1]), c = toPx(s[2], s[3]); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); }
      ctx.stroke();
      // doors: small marks, filled when open
      for (const o of eng.openings) {
        if (o.kind !== 'door' || o.storey !== key) continue;
        const p = toPx(o.center[0], o.center[2]);
        ctx.fillStyle = o.open ? '#A4502F' : 'rgba(164,80,47,0.35)';
        ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); ctx.fill();
      }
      // you
      const onThisFloor = isWalk && eng.storeyIndexAt(cam.position.y) === viewIdx;
      const p = dragPt ?? toPx(cam.position.x, cam.position.z);
      if (onThisFloor || dragPt || !isWalk) {
        const tgt = isWalk ? eng.walkCam.getTarget() : eng.orbitCam.target;
        const dir = tgt.subtract(cam.position); dir.y = 0; dir.normalize();
        const ang = Math.atan2(dir.z, dir.x);
        ctx.fillStyle = 'rgba(164,80,47,0.25)';
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.arc(p[0], p[1], 52, ang - 0.5, ang + 0.5); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#A4502F'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(p[0], p[1], dragPt ? 13 : 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  });

  function worldAt(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [cx + ((e.clientX - r.left) / r.width - 0.5) * span, cz + ((e.clientY - r.top) / r.height - 0.5) * span];
  }
  function pxAt(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * S, ((e.clientY - r.top) / r.height) * S];
  }

  function onpointerdown(e: PointerEvent) {
    e.stopPropagation();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  }
  function onpointermove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.moved = true;
    dragPt = pxAt(e);
    pending = worldAt(e);
    // move with your finger, at most once per frame
    if (!raf2) raf2 = requestAnimationFrame(() => {
      raf2 = 0;
      if (pending) eng.travelTo(pending[0], pending[1], viewIdx, false);
    });
  }
  function onpointerup(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const wasDrag = drag.moved;
    drag = null;
    dragPt = null;
    const [x, z] = worldAt(e);
    // tap: glide there quickly; drag: land where you let go
    if (!eng.travelTo(x, z, viewIdx, !wasDrag)) toast('There’s no floor there on this level', 'error');
  }
  function oncancel() { drag = null; dragPt = null; }

  function step(d: number) {
    const to = viewIdx + d;
    if (to < 0 || to >= storeys.length) return;
    if (eng.mode === 'walk') {
      if (eng.goToStorey(to)) viewIdx = to;
      else toast(`Couldn’t find a place to stand on ${storeys[to].name}`, 'error');
    } else viewIdx = to; // orbit: just show that floor; tap the map to walk there
  }
</script>

<div class="relative select-none">
  <canvas bind:this={canvas} width={S} height={S}
    class="block rounded-2xl shadow-lg border border-line touch-none cursor-crosshair transition-[width,height] {big ? 'w-[220px] h-[220px] md:w-[300px] md:h-[300px]' : 'w-[120px] h-[120px] md:w-[160px] md:h-[160px]'}"
    aria-label="Minimap: your position on the floor plan. Tap to go there, or drag your marker to move."
    {onpointerdown} {onpointermove} {onpointerup} onpointercancel={oncancel}></canvas>
  <button class="absolute top-1 left-1 w-7 h-7 rounded-full bg-white/90 shadow text-xs grid place-items-center" aria-label={big ? 'Smaller map' : 'Bigger map'} onclick={() => (big = !big)}>{big ? '⤡' : '⤢'}</button>
  {#if storeys.length > 1}
    <div class="absolute top-1 right-1 flex flex-col gap-1" role="group" aria-label="Floor">
      <button class="w-8 h-8 rounded-full bg-white/95 shadow font-bold disabled:opacity-35" disabled={!canUp} aria-label="Go up a floor" onclick={() => step(1)}>▲</button>
      <button class="w-8 h-8 rounded-full bg-white/95 shadow font-bold disabled:opacity-35" disabled={!canDown} aria-label="Go down a floor" onclick={() => step(-1)}>▼</button>
    </div>
  {/if}
  <div class="absolute bottom-1 left-1 right-1 flex justify-center pointer-events-none">
    <span class="rounded-full bg-ink/85 text-white text-[10px] md:text-[11px] font-semibold px-2 py-0.5 truncate max-w-full">{storeys[viewIdx]?.name ?? ''}{!isWalk ? ' · tap to walk' : ''}</span>
  </div>
</div>
