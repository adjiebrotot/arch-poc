<script lang="ts">
  import { onMount } from 'svelte';
  import { href, route } from '@shared/router';
  import { role, toast } from '@shared/stores/session';
  import { storage } from '@shared/storage/localAdapter';
  import { comments, addComment } from '@shared/comments/store';
  import type { Comment, Anchor } from '@shared/comments/model';
  import BottomSheet from '@shared/ui/BottomSheet.svelte';
  import StateBox from '@shared/ui/StateBox.svelte';
  import CommentComposer from '@shared/comments/CommentComposer.svelte';
  import ThreadView from '@shared/comments/ThreadView.svelte';
  import { current, restoreLast, loading } from './model/modelStore';
  import { ViewerEngine, defaultQuality, isMobileDevice, type Quality, type PickResult } from './engine/ViewerEngine';
  import { friendlyType } from '@shared/model/labels';
  import Joystick from './Joystick.svelte';
  import Minimap from './Minimap.svelte';
  import LoadingBar from './LoadingBar.svelte';
  import { Vector3 } from '@babylonjs/core';

  let canvas: HTMLCanvasElement | undefined = $state();
  let engine = $state<ViewerEngine | null>(null);
  let status = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');
  let errorMsg = $state('');
  let mode = $state<'walk' | 'orbit'>('walk');
  let quality = $state<Quality>(storage.getPref('quality', defaultQuality()));
  let hour = $state(15);
  let commenting = $state(false);
  let sheet = $state<null | 'compose' | 'thread' | 'settings' | 'list'>(null);
  let pending = $state<{ pick: PickResult; thumb: string; view: ReturnType<ViewerEngine['snapshot']> } | null>(null);
  let threadId = $state<string | null>(null);
  let cutaway = $state<string>('all');
  let fps = $state(0);
  let showFps = $state(false);
  let locked = $state(false);
  const touch = isMobileDevice();

  const projectId = $derived($current?.projectId ?? '');
  const projectComments = $derived($comments.filter((c) => c.projectId === projectId && c.source !== 'design-workspace'));
  const thread = $derived(projectComments.find((c) => c.id === threadId));

  onMount(() => {
    let disposed = false;
    (async () => {
      try {
        const lm = $current ?? (await restoreLast());
        if (disposed) return;
        if (!lm) { status = 'missing'; return; }
        engine = new ViewerEngine(canvas!, lm.model, quality);
        if (import.meta.env.DEV) (window as unknown as { __viewer: ViewerEngine }).__viewer = engine;
        status = 'ready';
        const focus = $route.query.get('comment');
        if (focus) setTimeout(() => openThread(focus, true), 300);
      } catch (e) {
        status = 'error';
        errorMsg = e instanceof Error ? e.message : String(e);
      }
    })();
    const fpsTimer = setInterval(() => (fps = Math.round(engine?.fps ?? 0)), 500);
    const onLock = () => (locked = document.pointerLockElement === canvas);
    document.addEventListener('pointerlockchange', onLock);
    return () => { disposed = true; clearInterval(fpsTimer); document.removeEventListener('pointerlockchange', onLock); engine?.dispose(); };
  });

  $effect(() => { engine?.setPins(projectComments, threadId); });

  function setMode(m: 'walk' | 'orbit') { mode = m; engine?.setMode(m); }
  function setQuality(q: Quality) { quality = q; storage.setPref('quality', q); engine?.applyQuality(q); }
  function setCutaway(v: string) { cutaway = v; engine?.setStoreyCutaway(v === 'all' ? null : v); engine?.setPins(projectComments, threadId); }

  function startComment() {
    commenting = !commenting;
    engine?.setFrozen(commenting);
    if (commenting) toast(touch ? 'Tap where you want to comment' : 'Click where you want to comment');
  }

  async function placeComment(x: number, y: number) {
    if (!engine) return;
    const pick = engine.pick(x, y);
    if (!pick) { toast('Nothing there — tap a wall, floor or object', 'error'); return; }
    const view = engine.snapshot();
    const thumb = await engine.screenshot(320);
    pending = { pick, thumb, view };
    sheet = 'compose';
  }

  function labelFor(p: PickResult) {
    if (!p.element) return 'Garden / site';
    const e = p.element;
    return `${friendlyType(e.type)} · ${e.name.split(":")[0]}`;
  }

  function post(d: { text: string; category: Comment['category']; attachments: string[]; author: string }) {
    if (!pending || !$current) return;
    const p = pending.pick;
    const anchor: Anchor = {
      elementId: p.element?.id,
      ifcExpressId: p.element?.expressId,
      elementLabel: labelFor(p),
      position: [round(p.point.x), round(p.point.y), round(p.point.z)],
      normal: [round(p.normal.x), round(p.normal.y), round(p.normal.z)],
      storey: p.element?.storey,
      view: pending.view,
    };
    const c = addComment({ projectId: $current.projectId, versionId: $current.versionId, source: 'viewer-3d', anchor, text: d.text, category: d.category, attachments: d.attachments, thumbnail: pending.thumb || undefined, author: d.author, role: $role });
    pending = null;
    sheet = null;
    commenting = false;
    engine?.setFrozen(false);
    threadId = c.id;
    toast('Comment saved with your exact viewpoint', 'success');
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;

  function openThread(id: string, go = false) {
    threadId = id;
    sheet = 'thread';
    if (go) goTo();
  }
  function goTo() {
    const c = thread ?? projectComments.find((x) => x.id === threadId);
    if (!c || !engine) return;
    if (c.anchor.storey && cutaway !== 'all') setCutaway('all');
    if (c.anchor.view) engine.flyTo(c.anchor.view);
    else {
      const p = c.anchor.position, n = c.anchor.normal ?? [0, 0, 1];
      engine.flyTo({ position: [p[0] + n[0] * 3 + 2, p[1] + 2.5, p[2] + n[2] * 3 + 2], target: p, mode: 'orbit' });
    }
    mode = c.anchor.view?.mode === 'walk' ? 'walk' : 'orbit';
    sheet = null;
  }

  // ---- pointer handling: tap to comment / walk, drag to look (touch) -----------------
  let down: { x: number; y: number; t: number; id: number; lx: number; ly: number } | null = null;
  function onpointerdown(e: PointerEvent) {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, lx: e.clientX, ly: e.clientY };
  }
  function onpointermove(e: PointerEvent) {
    if (!down || e.pointerId !== down.id || !engine) return;
    if (e.pointerType === 'touch' && mode === 'walk' && !commenting) {
      const dx = e.clientX - down.lx, dy = e.clientY - down.ly;
      engine.walkCam.rotation.y -= dx * 0.005;
      engine.walkCam.rotation.x = Math.max(-1.3, Math.min(1.3, engine.walkCam.rotation.x - dy * 0.004));
    }
    down.lx = e.clientX; down.ly = e.clientY;
  }
  function onpointerup(e: PointerEvent) {
    if (!down || e.pointerId !== down.id || !engine) return;
    const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && Date.now() - down.t < 500;
    down = null;
    if (!tap) return;
    const r = canvas!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const pin = engine.pickPin(x, y);
    if (pin) return openThread(pin);
    if (commenting) return placeComment(x, y);
    if (mode === 'walk') {
      if (e.pointerType === 'mouse') {
        if (!document.pointerLockElement) canvas!.requestPointerLock?.();
        return;
      }
      const p = engine.pick(x, y);
      if (p && p.normal.y > 0.7) engine.walkTo(new Vector3(p.point.x, p.point.y, p.point.z));
    }
  }
  function ondblclick(e: MouseEvent) {
    if (!engine || mode !== 'walk' || commenting) return;
    const r = canvas!.getBoundingClientRect();
    const p = engine.pick(e.clientX - r.left, e.clientY - r.top);
    if (p && p.normal.y > 0.7) engine.walkTo(new Vector3(p.point.x, p.point.y, p.point.z));
  }
  const storeyNames = $derived($current ? [...$current.model.storeys].sort((a, b) => a.elevation - b.elevation).map((s) => s.name) : []);
</script>

<div class="relative h-[calc(100dvh-3.5rem)] bg-[#dfe3e6] overflow-hidden">
  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full outline-none touch-none {commenting ? 'cursor-crosshair' : ''}" aria-label="3D walkthrough of the model"
    {onpointerdown} {onpointermove} {onpointerup} {ondblclick} tabindex="0"></canvas>

  {#if status !== 'ready'}
    <div class="absolute inset-0 grid place-items-center p-6 bg-paper">
      <div class="w-full max-w-md grid gap-3">
        {#if status === 'loading'}<LoadingBar />{#if !$loading.active}<StateBox kind="loading" title="Preparing the 3D scene…" />{/if}
        {:else if status === 'missing'}<StateBox title="No model loaded yet">Open a demo model or your architect's project first. <a class="underline" href={href('/viewer')}>Choose a model</a></StateBox>
        {:else}<StateBox kind="error" title="3D isn't available">{errorMsg || 'This device could not start WebGL.'} <a class="underline" href={href('/viewer/plan')}>Try the 2D drawings</a></StateBox>{/if}
      </div>
    </div>
  {:else if engine}
    <!-- top bar -->
    <div class="absolute top-0 inset-x-0 p-2 md:p-3 flex items-start gap-2 pointer-events-none">
      <div class="pointer-events-auto flex items-center gap-2 bg-white/90 backdrop-blur rounded-full pl-1 pr-3 py-1 shadow-sm min-w-0">
        <a class="btn btn-ghost btn-sm btn-icon !border-0" href={href('/viewer')} aria-label="Back to models">←</a>
        <div class="min-w-0"><div class="text-sm font-semibold truncate">{$current?.title}</div>{#if $current?.versionLabel}<div class="text-[11px] text-muted truncate">{$current.versionLabel}</div>{/if}</div>
      </div>
      <div class="flex-1"></div>
      <div class="pointer-events-auto flex rounded-full bg-white/90 backdrop-blur p-0.5 text-sm font-semibold shadow-sm" role="group" aria-label="Camera">
        <button class="px-3 min-h-10 rounded-full {mode === 'walk' ? 'bg-ink text-white' : ''}" aria-pressed={mode === 'walk'} onclick={() => setMode('walk')}>🚶 Walk</button>
        <button class="px-3 min-h-10 rounded-full {mode === 'orbit' ? 'bg-ink text-white' : ''}" aria-pressed={mode === 'orbit'} onclick={() => setMode('orbit')}>🌐 Orbit</button>
      </div>
      <a class="pointer-events-auto btn btn-ghost btn-icon bg-white/90 shadow-sm !border-0" href={href('/viewer/plan')} aria-label="2D drawings">📐</a>
      <button class="pointer-events-auto btn btn-ghost btn-icon bg-white/90 shadow-sm !border-0" aria-label="View settings" onclick={() => (sheet = 'settings')}>⚙️</button>
    </div>

    {#if commenting}
      <div class="absolute inset-0 pointer-events-none grid place-items-center">
        <div class="w-10 h-10 rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,.35)] grid place-items-center"><div class="w-1.5 h-1.5 rounded-full bg-accent"></div></div>
      </div>
      <div class="absolute top-16 inset-x-0 flex justify-center pointer-events-none"><div class="rounded-full bg-accent text-white px-4 py-2 text-sm font-semibold shadow-lg">Movement paused · tap the spot you want to comment on</div></div>
    {:else if mode === 'walk' && !touch && !locked}
      <div class="absolute top-16 inset-x-0 flex justify-center pointer-events-none"><div class="rounded-full bg-black/55 text-white px-4 py-2 text-xs shadow">Click to look around · WASD / arrows to walk · double-click the floor to go there · Esc to release</div></div>
    {/if}
    {#if showFps}<div class="absolute top-16 left-3 rounded bg-black/60 text-white text-xs px-2 py-1 tabular-nums">{fps} fps · {quality}</div>{/if}

    <!-- bottom controls -->
    <div class="absolute bottom-0 inset-x-0 p-3 flex items-end gap-3 pointer-events-none safe-b">
      <div class="pointer-events-auto">
        {#if touch && mode === 'walk' && !commenting}
          <Joystick onmove={(x, y) => { if (engine) engine.move = { x, y }; }} />
        {/if}
      </div>
      <div class="flex-1 flex justify-center gap-2 pointer-events-auto flex-wrap">
        <button class="btn shadow-lg {commenting ? 'btn-primary' : 'btn-accent'} min-h-12 px-5" onclick={startComment} aria-pressed={commenting}>{commenting ? '✕ Cancel' : '💬 Comment'}</button>
        <button class="btn btn-ghost bg-white/90 shadow-lg !border-0 min-h-12" onclick={() => (sheet = 'list')}>🗂 {projectComments.length}</button>
        {#if mode === 'walk' && !commenting}<button class="btn btn-ghost bg-white/90 shadow-lg !border-0 min-h-12" onclick={() => { if (!engine?.goInside()) toast("Couldn't find a free spot inside", 'error'); }}>🚪 Go inside</button>{/if}
      </div>
      <div class="pointer-events-auto"><Minimap {engine} /></div>
    </div>
  {/if}
</div>

<BottomSheet open={sheet === 'settings'} title="View settings" onclose={() => (sheet = null)}>
  <div class="grid gap-5">
    <label class="field"><span>Time of day: {Math.floor(hour)}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')}</span>
      <input type="range" min="6" max="20" step="0.25" bind:value={hour} oninput={() => engine?.setTimeOfDay(hour)} class="accent-[#A4502F] h-11" />
    </label>
    <div class="field"><span>Quality</span>
      <div class="flex gap-2" role="radiogroup" aria-label="Quality">
        {#each ['low', 'medium', 'high'] as q}<button role="radio" aria-checked={quality === q} class="chip flex-1 justify-center capitalize" class:on={quality === q} onclick={() => setQuality(q as Quality)}>{q}</button>{/each}
      </div>
      <small class="text-muted">Low is best for phones. High adds ambient occlusion{isMobileDevice() ? '' : ', reflections'} and anti-aliasing. Default for this device: {defaultQuality()}.</small>
    </div>
    <div class="field"><span>Show levels</span>
      <div class="flex gap-2 flex-wrap">
        <button class="chip" class:on={cutaway === 'all'} onclick={() => setCutaway('all')}>Everything</button>
        {#each storeyNames as s}<button class="chip" class:on={cutaway === s} onclick={() => setCutaway(s)}>Up to {s}</button>{/each}
      </div>
    </div>
    <label class="flex items-center gap-3"><input type="checkbox" class="w-5 h-5 accent-[#A4502F]" bind:checked={showFps} /> Show frame rate</label>
  </div>
</BottomSheet>

<BottomSheet open={sheet === 'compose'} title="New comment" onclose={() => { sheet = null; pending = null; }}>
  {#if pending}
    <CommentComposer context={labelFor(pending.pick) + (pending.pick.element?.storey ? ` · ${pending.pick.element.storey}` : '')} thumbnail={pending.thumb} onsubmit={post} oncancel={() => { sheet = null; pending = null; }} />
  {/if}
</BottomSheet>

<BottomSheet open={sheet === 'thread' && !!thread} title="Comment" onclose={() => { sheet = null; threadId = null; }}>
  {#if thread}<ThreadView comment={thread} ongoto={goTo} onclose={() => (sheet = null)} />{/if}
</BottomSheet>

<BottomSheet open={sheet === 'list'} title={`Comments (${projectComments.length})`} onclose={() => (sheet = null)}>
  {#if projectComments.length === 0}
    <p class="text-muted">No comments yet. Tap <strong>💬 Comment</strong>, then tap anything in the model.</p>
  {:else}
    <ul class="grid gap-2">
      {#each projectComments as c}
        <li><button class="w-full text-left card p-3 hover:border-ink flex gap-3" onclick={() => { threadId = c.id; goTo(); }}>
          {#if c.thumbnail}<img src={c.thumbnail} alt="" class="w-16 h-12 object-cover rounded-lg" />{/if}
          <div class="min-w-0"><div class="text-sm font-medium line-clamp-2">{c.text}</div><div class="text-xs text-muted">{c.author} · {c.anchor.elementLabel} · {c.source === 'viewer-2d' ? '2D' : '3D'} · {c.status}</div></div>
        </button></li>
      {/each}
    </ul>
  {/if}
</BottomSheet>
