<script lang="ts">
  import { onMount } from 'svelte';
  import { href, navigate } from '@shared/router';
  import { role, toast } from '@shared/stores/session';
  import { comments, addComment } from '@shared/comments/store';
  import type { Comment, Anchor } from '@shared/comments/model';
  import { CATEGORY_ICON } from '@shared/comments/model';
  import BottomSheet from '@shared/ui/BottomSheet.svelte';
  import StateBox from '@shared/ui/StateBox.svelte';
  import CommentComposer from '@shared/comments/CommentComposer.svelte';
  import ThreadView from '@shared/comments/ThreadView.svelte';
  import { current, restoreLast } from './model/modelStore';
  import { DrawingEngine, DRAWINGS, type DrawingKind } from './engine/DrawingEngine';
  import { friendlyType } from '@shared/model/labels';
  import { drawWatermark, WATERMARK_TEXT } from './watermark';
  import { downloadBlob } from '@shared/util/download';
  import { Vector3 } from '@babylonjs/core';

  let canvas: HTMLCanvasElement | undefined = $state();
  let wm: HTMLCanvasElement | undefined = $state();
  let engine = $state<DrawingEngine | null>(null);
  let status = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');
  let kind = $state<DrawingKind>('plan');
  let storey = $state('');
  let tick = $state(0); // bumps when the view changes → re-project overlays
  let commenting = $state(false);
  let watermarkOn = $state(true);
  let sheet = $state<null | 'compose' | 'thread'>(null);
  let pending = $state<{ anchor: Anchor; label: string } | null>(null);
  let threadId = $state<string | null>(null);
  let exporting = $state(false);
  let size = $state({ w: 0, h: 0 });

  const projectId = $derived($current?.projectId ?? '');
  const storeys = $derived($current ? [...$current.model.storeys].sort((a, b) => a.elevation - b.elevation) : []);
  const usable = $derived(storeys.filter((s) => $current!.model.elements.some((e) => e.storey === s.name && /Wall/.test(e.type))));
  const drawing = $derived(DRAWINGS.find((d) => d.id === kind)!);
  const mirrored = $derived(kind === 'rcp');
  const allComments = $derived($comments.filter((c) => c.projectId === projectId && c.source !== 'design-workspace'));
  const thread = $derived(allComments.find((c) => c.id === threadId));

  onMount(() => {
    let disposed = false;
    (async () => {
      try {
        const lm = $current ?? (await restoreLast());
        if (disposed) return;
        if (!lm) { status = 'missing'; return; }
        const e = new DrawingEngine(canvas!, lm.model);
        e.onViewChange = () => tick++;
        engine = e;
        const sts = [...lm.model.storeys].sort((a, b) => a.elevation - b.elevation).filter((s) => lm.model.elements.some((x) => x.storey === s.name && /Wall/.test(x.type)));
        storey = [...sts].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0]?.name ?? lm.model.storeys[0]?.name ?? '';
        e.setDrawing(kind, storey);
        status = 'ready';
      } catch (err) { status = 'error'; console.error(err); }
    })();
    const ro = new ResizeObserver(() => { if (canvas) size = { w: canvas.clientWidth, h: canvas.clientHeight }; });
    if (canvas) ro.observe(canvas);
    return () => { disposed = true; ro.disconnect(); engine?.dispose(); };
  });

  function choose(k: DrawingKind, s = storey) {
    kind = k; storey = s;
    engine?.setDrawing(k, s);
  }

  // Watermark overlay (also baked into exports). The client role can't turn it off.
  $effect(() => {
    void size; void tick;
    if (!wm) return;
    const dpr = window.devicePixelRatio || 1;
    wm.width = size.w * dpr; wm.height = size.h * dpr;
    const ctx = wm.getContext('2d')!;
    ctx.clearRect(0, 0, wm.width, wm.height);
    if (watermarkOn || $role === 'client') drawWatermark(ctx, wm.width, wm.height, dpr);
  });

  // ---- overlays: scale bar, pins ---------------------------------------------------
  const scaleBar = $derived.by(() => {
    void tick; void size;
    if (!engine) return null;
    const ppm = engine.pxPerMetre;
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100].find((m) => m * ppm >= 90) ?? 100;
    return { metres: nice, px: nice * ppm };
  });
  const pinPositions = $derived.by(() => {
    void tick; void size;
    if (!engine) return [] as { c: Comment; x: number; y: number }[];
    const elev = engine.storeyElevation(storey), next = engine.nextStoreyElevation(storey);
    return allComments
      .filter((c) => {
        if (!drawing.perStorey) return true;
        const y = c.anchor.position[1];
        return c.anchor.storey ? c.anchor.storey === storey || (y >= elev - 0.2 && y < next - 0.2) : y >= elev - 0.2 && y < next;
      })
      .map((c) => {
        const p = engine!.project(Vector3.FromArray(c.anchor.position));
        return { c, x: mirrored ? size.w - p.x : p.x, y: p.y };
      })
      .filter((p) => p.x > -20 && p.y > -20 && p.x < size.w + 20 && p.y < size.h + 20);
  });

  // ---- pan / zoom / tap ---------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; t: number; moved: boolean; dist?: number } | null = null;
  function local(e: PointerEvent | WheelEvent) {
    const r = canvas!.getBoundingClientRect();
    const x = e.clientX - r.left;
    return { x: mirrored ? r.width - x : x, y: e.clientY - r.top };
  }
  function onpointerdown(e: PointerEvent) {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) start = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    if (pointers.size === 2 && start) { const [a, b] = [...pointers.values()]; start.dist = Math.hypot(a.x - b.x, a.y - b.y); start.moved = true; }
  }
  function onpointermove(e: PointerEvent) {
    const prev = pointers.get(e.pointerId);
    if (!prev || !engine || !start) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (start.dist) engine.zoom(d / start.dist);
      start.dist = d;
      return;
    }
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) start.moved = true;
    if (start.moved) engine.pan((e.clientX - prev.x) * (mirrored ? -1 : 1), e.clientY - prev.y);
  }
  function onpointerup(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (!start || pointers.size > 0) return;
    const tap = !start.moved && Date.now() - start.t < 500;
    start = null;
    if (tap && commenting) place(local(e));
  }
  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const p = local(e);
    engine?.zoom(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }

  function place(p: { x: number; y: number }) {
    if (!engine) return;
    const hit = engine.pick(p.x, p.y);
    if (!hit) { toast('Tap on the building', 'error'); return; }
    const e = hit.element;
    const pos = hit.point;
    const label = e ? `${friendlyType(e.type)} · ${e.name.split(':')[0]}` : 'Site';
    pending = {
      label,
      anchor: {
        elementId: e?.id, ifcExpressId: e?.expressId, elementLabel: label,
        position: [r3(pos.x), r3(pos.y), r3(pos.z)], normal: [r3(hit.normal.x), r3(hit.normal.y), r3(hit.normal.z)],
        storey: e?.storey ?? storey,
        // a 3D viewpoint looking at the same spot, so "Go to view" works in the walkthrough too
        view: { position: [r3(pos.x + 4), r3(pos.y + 5), r3(pos.z + 6)], target: [r3(pos.x), r3(pos.y), r3(pos.z)], mode: 'orbit' },
      },
    };
    sheet = 'compose';
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  function post(d: { text: string; category: Comment['category']; attachments: string[]; author: string }) {
    if (!pending || !$current) return;
    const c = addComment({ projectId, versionId: $current.versionId, source: 'viewer-2d', anchor: pending.anchor, text: d.text, category: d.category, attachments: d.attachments, author: d.author, role: $role });
    pending = null; sheet = null; commenting = false; threadId = c.id;
    toast('Comment pinned — it also shows in the 3D walkthrough', 'success');
  }

  // ---- export (watermark always included for clients) --------------------------------
  async function composite(): Promise<HTMLCanvasElement> {
    const src = engine!.snapshotCanvas();
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height + Math.round(src.height * 0.09);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.save();
    if (mirrored) { ctx.translate(src.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    const k = src.width / Math.max(1, size.w);
    // scale bar + north arrow
    if (scaleBar) {
      ctx.fillStyle = '#1F2326'; ctx.strokeStyle = '#1F2326'; ctx.lineWidth = 2 * k;
      const x0 = 24 * k, y0 = src.height - 28 * k;
      ctx.fillRect(x0, y0, scaleBar.px * k, 6 * k);
      ctx.font = `600 ${12 * k}px Inter Variable, sans-serif`;
      ctx.fillText(`${scaleBar.metres} m`, x0 + scaleBar.px * k + 8 * k, y0 + 7 * k);
    }
    if (drawing.perStorey) {
      const cx = src.width - 40 * k, cy = 50 * k;
      ctx.beginPath(); ctx.moveTo(cx, cy - 22 * k); ctx.lineTo(cx + 10 * k, cy + 12 * k); ctx.lineTo(cx, cy + 4 * k); ctx.lineTo(cx - 10 * k, cy + 12 * k); ctx.closePath(); ctx.fill();
      ctx.font = `700 ${13 * k}px Inter Variable, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('N', cx, cy + 30 * k); ctx.textAlign = 'left';
    }
    // title block
    const tb = src.height;
    ctx.fillStyle = '#1F2326'; ctx.fillRect(0, tb, out.width, out.height - tb);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${16 * k}px Inter Variable, sans-serif`;
    ctx.fillText(`${$current?.title ?? ''} — ${drawing.label}${drawing.perStorey ? ` · ${storey}` : ''}`, 20 * k, tb + (out.height - tb) * 0.45);
    ctx.font = `${12 * k}px Inter Variable, sans-serif`;
    ctx.fillText(`Architect Tool POC · ${$current?.versionLabel ?? 'Working model'} · ${new Date().toLocaleDateString()} · ${WATERMARK_TEXT}`, 20 * k, tb + (out.height - tb) * 0.78);
    if (watermarkOn || $role === 'client') drawWatermark(ctx, out.width, out.height, k);
    return out;
  }
  async function exportPng() {
    exporting = true;
    try {
      const c = await composite();
      const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
      downloadBlob(blob, `${kind}${drawing.perStorey ? '-' + storey.replace(/\W+/g, '') : ''}.png`);
    } finally { exporting = false; }
  }
  async function exportPdf() {
    exporting = true;
    try {
      const c = await composite();
      const { jsPDF } = await import('jspdf');
      const landscape = c.width >= c.height;
      const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a3' });
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const s = Math.min((pw - 20) / c.width, (ph - 20) / c.height);
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', (pw - c.width * s) / 2, (ph - c.height * s) / 2, c.width * s, c.height * s);
      pdf.save(`${kind}.pdf`);
    } finally { exporting = false; }
  }

  function goToThread() {
    const c = thread;
    if (!c || !engine) return;
    if (c.anchor.storey && drawing.perStorey && c.anchor.storey !== storey && usable.some((s) => s.name === c.anchor.storey)) choose(kind, c.anchor.storey);
    const p = engine.project(Vector3.FromArray(c.anchor.position));
    engine.pan(size.w / 2 - p.x, size.h / 2 - p.y);
    sheet = null;
  }
</script>

<div class="relative h-[calc(100dvh-3.5rem)] flex flex-col bg-white">
  <div class="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper flex-wrap z-10">
    <a class="btn btn-ghost btn-sm btn-icon" href={href('/viewer')} aria-label="Back to models">←</a>
    <div class="flex gap-1 overflow-x-auto flex-1 min-w-0" role="tablist" aria-label="Drawing">
      {#each DRAWINGS as d}
        <button role="tab" aria-selected={kind === d.id} class="chip shrink-0 !min-h-9" class:on={kind === d.id} onclick={() => choose(d.id)}>{d.short}</button>
      {/each}
    </div>
    {#if drawing.perStorey && usable.length > 1}
      <label class="sr-only" for="storey">Level</label>
      <select id="storey" class="input !w-auto !min-h-9 !py-1" value={storey} onchange={(e) => choose(kind, (e.target as HTMLSelectElement).value)}>
        {#each usable as s}<option value={s.name}>{s.name}</option>{/each}
      </select>
    {/if}
  </div>

  <div class="relative flex-1 min-h-0 overflow-hidden">
    <canvas bind:this={canvas} class="absolute inset-0 w-full h-full touch-none outline-none {commenting ? 'cursor-crosshair' : 'cursor-grab'}" style={mirrored ? 'transform: scaleX(-1)' : ''}
      aria-label={`${drawing.label} drawing`} {onpointerdown} {onpointermove} {onpointerup} onpointercancel={onpointerup} {onwheel}></canvas>
    <canvas bind:this={wm} class="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true"></canvas>

    {#if status !== 'ready'}
      <div class="absolute inset-0 grid place-items-center p-6 bg-paper">
        <div class="max-w-md w-full">
          {#if status === 'loading'}<StateBox kind="loading" title="Preparing drawings…" />
          {:else if status === 'missing'}<StateBox title="No model loaded yet">Pick a model first. <a class="underline" href={href('/viewer')}>Choose a model</a></StateBox>
          {:else}<StateBox kind="error" title="Drawings couldn't start">This device couldn't start WebGL.</StateBox>{/if}
        </div>
      </div>
    {:else}
      {#each pinPositions as p (p.c.id)}
        <button class="absolute -translate-x-1/2 -translate-y-full w-9 h-11 grid place-items-start justify-center" style="left:{p.x}px; top:{p.y}px" aria-label={`Comment: ${p.c.text}`} onclick={() => { threadId = p.c.id; sheet = 'thread'; }}>
          <svg viewBox="0 0 36 44" class="w-9 h-11 drop-shadow"><path d="M18 43C8 30 2 24 2 16a16 16 0 0 1 32 0c0 8-6 14-16 27z" fill={p.c.status === 'resolved' ? '#7C8A80' : p.c.role === 'architect' ? '#1F2326' : '#A4502F'} stroke="#fff" stroke-width="2.5" /><text x="18" y="21" text-anchor="middle" font-size="14">{CATEGORY_ICON[p.c.category ?? 'question']}</text></svg>
        </button>
      {/each}

      {#if drawing.perStorey}
        <div class="absolute bottom-3 right-3 w-12 h-14 grid justify-items-center pointer-events-none" aria-label="North arrow" role="img">
          <svg viewBox="0 0 24 30" class="w-6 h-8"><path d="M12 1l8 22-8-5-8 5z" fill="#1F2326" /></svg><span class="text-xs font-bold">N</span>
        </div>
      {/if}
      {#if scaleBar}
        <div class="absolute left-3 bottom-3 flex items-center gap-2 pointer-events-none" aria-label={`Scale bar ${scaleBar.metres} metres`}>
          <div class="h-1.5 bg-ink" style="width:{scaleBar.px}px"></div><span class="text-xs font-semibold">{scaleBar.metres} m</span>
        </div>
      {/if}
      <div class="absolute top-3 left-3 text-xs bg-white/90 rounded-full px-3 py-1 border border-line pointer-events-none">{drawing.label}{drawing.perStorey ? ` · ${storey}` : ''}{mirrored ? ' · viewed looking up, mirrored' : ''}</div>
      {#if commenting}<div class="absolute top-12 inset-x-0 flex justify-center pointer-events-none"><div class="rounded-full bg-accent text-white px-4 py-2 text-sm font-semibold shadow-lg">Tap the spot you want to comment on</div></div>{/if}

      <div class="absolute right-3 top-12 grid gap-2">
        <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom in" onclick={() => engine?.zoom(1.3)}>＋</button>
        <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Zoom out" onclick={() => engine?.zoom(1 / 1.3)}>－</button>
        <button class="btn btn-ghost btn-icon bg-white shadow-sm" aria-label="Fit drawing" onclick={() => engine?.fit()}>⤢</button>
      </div>
    {/if}
  </div>
  {#if status === 'ready'}
    <nav class="border-t border-line bg-paper safe-b" aria-label="Drawing actions">
      <div class="flex gap-2 px-3 py-2 overflow-x-auto items-center">
        <button class="btn shrink-0 {commenting ? 'btn-primary' : 'btn-accent'}" onclick={() => (commenting = !commenting)}>{commenting ? '✕ Cancel' : '💬 Comment'}</button>
        <button class="btn btn-ghost shrink-0" disabled={exporting} onclick={exportPng}>⬇ PNG</button>
        <button class="btn btn-ghost shrink-0" disabled={exporting} onclick={exportPdf}>⬇ PDF</button>
        {#if $role === 'architect'}
          <button class="btn btn-ghost shrink-0" aria-pressed={watermarkOn} onclick={() => (watermarkOn = !watermarkOn)}>{watermarkOn ? 'Hide' : 'Show'} watermark</button>
        {/if}
        <div class="flex-1"></div>
        <button class="btn btn-primary shrink-0" onclick={() => navigate('/viewer/walk')}>🚶 Walk in 3D</button>
      </div>
    </nav>
  {/if}
</div>

<BottomSheet open={sheet === 'compose'} title="New comment" onclose={() => { sheet = null; pending = null; }}>
  {#if pending}<CommentComposer context={pending.label + (pending.anchor.storey ? ` · ${pending.anchor.storey}` : '')} onsubmit={post} oncancel={() => { sheet = null; pending = null; }} />{/if}
</BottomSheet>
<BottomSheet open={sheet === 'thread' && !!thread} title="Comment" onclose={() => (sheet = null)}>
  {#if thread}
    <ThreadView comment={thread} ongoto={goToThread} onclose={() => (sheet = null)} />
    <a class="btn btn-ghost btn-sm mt-3" href={href(`/viewer/walk?comment=${thread.id}`)}>Open this spot in 3D →</a>
  {/if}
</BottomSheet>
