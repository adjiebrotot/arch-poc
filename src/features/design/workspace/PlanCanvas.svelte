<script lang="ts">
  import type { Editor, Hit } from './editor.svelte';
  import { ROOM_COLORS, type Floor } from '@shared/planspec/schema';
  import type { Comment } from '@shared/comments/model';
  import { CATEGORY_ICON } from '@shared/comments/model';
  import { polygonCentroid, dist, type Vec2 } from '@shared/util/geometry';
  import { openingGeometry, floorBounds } from '../engine/planSvg';
  import { onMount } from 'svelte';

  let { editor, pins = [], onCommentTap, onPinTap, onRoomCreated }: {
    editor: Editor; pins?: Comment[];
    onCommentTap: (hit: Hit) => void; onPinTap: (c: Comment) => void; onRoomCreated?: (id: string) => void;
  } = $props();

  let el: HTMLDivElement;
  let W = $state(800), H = $state(600);
  let cx = $state(0), cy = $state(0), scale = $state(40); // px per metre
  let hover = $state<Vec2 | null>(null);
  let preview = $state<{ kind: 'rect'; a: Vec2; b: Vec2 } | { kind: 'line'; a: Vec2; b: Vec2 } | null>(null);
  let wallChain = $state<Vec2[]>([]);
  let pressing = $state<Vec2 | null>(null);

  const floor = $derived(editor.floor);
  const tolPx = 14;
  const tol = $derived(tolPx / scale);
  const vb = $derived(`${cx - W / 2 / scale} ${cy - H / 2 / scale} ${W / scale} ${H / scale}`);

  export function fit() {
    const b = floorBounds(floor, 1.5);
    const site = editor.plan.site;
    const bw = floor.walls.length ? b.w : site?.width ?? 20, bh = floor.walls.length ? b.h : site?.depth ?? 20;
    cx = floor.walls.length ? b.x + b.w / 2 : (site?.width ?? 20) / 2;
    cy = floor.walls.length ? b.y + b.h / 2 : (site?.depth ?? 20) / 2;
    scale = Math.max(8, Math.min(200, Math.min(W / bw, H / bh) * 0.9));
  }
  export function zoomBy(f: number) { scale = Math.max(6, Math.min(400, scale * f)); }

  onMount(() => {
    const ro = new ResizeObserver(() => { W = el.clientWidth; H = el.clientHeight; });
    ro.observe(el);
    W = el.clientWidth; H = el.clientHeight;
    fit();
    return () => ro.disconnect();
  });

  const toWorld = (px: number, py: number): Vec2 => {
    const r = el.getBoundingClientRect();
    return [cx + (px - r.left - W / 2) / scale, cy + (py - r.top - H / 2) / scale];
  };

  // ---- gestures ---------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: null | {
    type: 'pan' | 'pinch' | 'drag-wall' | 'drag-opening' | 'rect' | 'pending';
    startWorld: Vec2; startClient: { x: number; y: number }; startCx: number; startCy: number; startScale: number;
    startDist?: number; startMid?: { x: number; y: number }; id?: string; startFloor?: Floor; snapshot?: string; moved: boolean; pointerType: string; t0: number;
  } = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function clearLongPress() { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null; pressing = null; }

  function beginDrag(hit: Hit) {
    if (!gesture) return;
    if (hit.kind === 'wall') { gesture.type = 'drag-wall'; gesture.id = hit.id; }
    else if (hit.kind === 'opening') { gesture.type = 'drag-opening'; gesture.id = hit.id; }
    else return;
    gesture.startFloor = structuredClone($state.snapshot(editor.floor)) as Floor;
    gesture.snapshot = editor.snapshot();
  }

  function onpointerdown(e: PointerEvent) {
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const w = toWorld(e.clientX, e.clientY);
    if (pointers.size === 2) {
      clearLongPress();
      // second finger → pinch (cancel any in-progress drag by restoring)
      if (gesture?.snapshot && gesture.moved) { editor.plan = JSON.parse(gesture.snapshot); }
      const [p1, p2] = [...pointers.values()];
      gesture = { type: 'pinch', startWorld: w, startClient: { x: e.clientX, y: e.clientY }, startCx: cx, startCy: cy, startScale: scale,
        startDist: Math.hypot(p2.x - p1.x, p2.y - p1.y), startMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, moved: true, pointerType: e.pointerType, t0: Date.now() };
      preview = null;
      return;
    }
    if (pointers.size > 2) return;
    gesture = { type: 'pending', startWorld: w, startClient: { x: e.clientX, y: e.clientY }, startCx: cx, startCy: cy, startScale: scale, moved: false, pointerType: e.pointerType, t0: Date.now() };
    const middle = e.button === 1 || e.button === 2;
    if (middle) { gesture.type = 'pan'; return; }
    if (editor.mode === 'comment') return; // tap handled on pointerup
    const t = editor.tool;
    if (t === 'room') { gesture.type = 'rect'; const s = editor.snapPoint(w, tol); preview = { kind: 'rect', a: s, b: s }; return; }
    if (t === 'select') {
      const hit = editor.hitTest(w, tol);
      const isSelected = editor.selection && hit.kind !== 'space' && editor.selection.id === hit.id;
      if (e.pointerType === 'mouse') {
        if (hit.kind !== 'space') editor.selection = { kind: hit.kind, id: hit.id };
        else editor.selection = null;
        beginDrag(hit);
        if (gesture.type === 'pending') gesture.type = 'pan';
      } else if (isSelected && (hit.kind === 'wall' || hit.kind === 'opening')) {
        beginDrag(hit);
      } else {
        // touch: long-press selects and starts a drag; otherwise this becomes a pan
        pressing = w;
        longPressTimer = setTimeout(() => {
          if (!gesture || gesture.moved) return;
          if (hit.kind !== 'space') {
            editor.selection = { kind: hit.kind, id: hit.id };
            navigator.vibrate?.(15);
            beginDrag(hit);
          }
          pressing = null;
        }, 450);
      }
    }
  }

  function onpointermove(e: PointerEvent) {
    const w = toWorld(e.clientX, e.clientY);
    if (e.pointerType === 'mouse') hover = editor.tool === 'wall' || editor.tool === 'door' || editor.tool === 'window' ? editor.snapPoint(w, tol) : null;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    const moved = Math.hypot(e.clientX - gesture.startClient.x, e.clientY - gesture.startClient.y) > 6;
    if (moved && !gesture.moved) { gesture.moved = true; clearLongPress(); }
    switch (gesture.type) {
      case 'pinch': {
        const [p1, p2] = [...pointers.values()];
        if (!p2) return;
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const ns = Math.max(6, Math.min(400, gesture.startScale * (d / gesture.startDist!)));
        const r = el.getBoundingClientRect();
        const anchor: Vec2 = [gesture.startCx + (gesture.startMid!.x - r.left - W / 2) / gesture.startScale, gesture.startCy + (gesture.startMid!.y - r.top - H / 2) / gesture.startScale];
        scale = ns;
        cx = anchor[0] - (mid.x - r.left - W / 2) / ns;
        cy = anchor[1] - (mid.y - r.top - H / 2) / ns;
        break;
      }
      case 'pending':
      case 'pan':
        if (!gesture.moved) return;
        gesture.type = 'pan';
        cx = gesture.startCx - (e.clientX - gesture.startClient.x) / scale;
        cy = gesture.startCy - (e.clientY - gesture.startClient.y) / scale;
        break;
      case 'rect':
        preview = { kind: 'rect', a: (preview as { a: Vec2 })?.a ?? editor.snapPoint(gesture.startWorld, tol), b: editor.snapPoint(w, tol) };
        break;
      case 'drag-wall':
        if (!gesture.moved) return;
        if (gesture.snapshot && !(gesture as { pushed?: boolean }).pushed) { editor.pushHistory(gesture.snapshot); (gesture as { pushed?: boolean }).pushed = true; }
        editor.moveWallFrom(gesture.startFloor!, gesture.id!, [w[0] - gesture.startWorld[0], w[1] - gesture.startWorld[1]]);
        break;
      case 'drag-opening':
        if (!gesture.moved) return;
        if (gesture.snapshot && !(gesture as { pushed?: boolean }).pushed) { editor.pushHistory(gesture.snapshot); (gesture as { pushed?: boolean }).pushed = true; }
        editor.moveOpeningFrom(gesture.startFloor!, gesture.id!, w);
        break;
    }
    if (editor.tool === 'wall' && wallChain.length) preview = { kind: 'line', a: wallChain[wallChain.length - 1], b: editor.snapPoint(w, tol) };
  }

  function onpointerup(e: PointerEvent) {
    pointers.delete(e.pointerId);
    clearLongPress();
    if (!gesture) return;
    const g = gesture;
    if (pointers.size > 0) { if (g.type !== 'pinch') gesture = null; return; }
    gesture = null;
    const w = toWorld(e.clientX, e.clientY);
    const tap = !g.moved && Date.now() - g.t0 < 600;
    if (g.type === 'rect') {
      const p = preview as { a: Vec2; b: Vec2 } | null;
      preview = null;
      let a = p?.a ?? editor.snapPoint(w, tol), b = p?.b ?? a;
      if (tap || dist(a, b) < 0.5) {
        // tap: drop a default 3.6 × 3.0 m room centred here
        const c = editor.snapPoint(w, tol);
        a = [c[0] - 1.8, c[1] - 1.5]; b = [c[0] + 1.8, c[1] + 1.5];
      }
      const id = editor.addRoomRect(a, b);
      if (id) onRoomCreated?.(id);
      return;
    }
    if (!tap) return;
    if (editor.mode === 'comment') {
      // pins have priority
      const pin = pinAt(w);
      if (pin) return onPinTap(pin);
      return onCommentTap(editor.hitTest(w, tol));
    }
    const pin = pinAt(w);
    if (pin) return onPinTap(pin);
    switch (editor.tool) {
      case 'select': {
        const hit = editor.hitTest(w, tol);
        editor.selection = hit.kind === 'space' ? null : { kind: hit.kind, id: hit.id };
        break;
      }
      case 'wall': {
        const p = editor.snapPoint(w, tol);
        if (wallChain.length && dist(p, wallChain[0]) < tol && wallChain.length > 2) { editor.addWall(wallChain[wallChain.length - 1], wallChain[0]); finishChain(); break; }
        if (wallChain.length) editor.addWall(wallChain[wallChain.length - 1], p);
        wallChain = [...wallChain, p];
        break;
      }
      case 'door':
      case 'window':
        editor.addOpening(editor.tool, w, tol * 1.5);
        break;
      case 'erase': {
        const hit = editor.hitTest(w, tol);
        if (hit.kind !== 'space') editor.deleteElement({ kind: hit.kind, id: hit.id });
        break;
      }
    }
  }

  export function finishChain() { wallChain = []; preview = null; }
  $effect(() => { if (editor.tool !== 'wall') finishChain(); });

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    scale = Math.max(6, Math.min(400, scale * f));
    const after = toWorld(e.clientX, e.clientY);
    cx += before[0] - after[0];
    cy += before[1] - after[1];
  }

  function pinAt(w: Vec2): Comment | null {
    for (const c of pins) {
      const p = editor.resolveAnchor(c.anchor);
      if (p && Math.hypot(p[0] - w[0], p[1] - 0.45 * (16 / scale) - w[1]) < 16 / scale) return c;
    }
    return null;
  }

  const wallById = $derived(new Map(floor.walls.map((w) => [w.id, w])));
  const selWall = $derived(editor.selection?.kind === 'wall' ? wallById.get(editor.selection.id) : undefined);
  const rectDims = $derived(preview?.kind === 'rect' ? { w: Math.abs(preview.b[0] - preview.a[0]), h: Math.abs(preview.b[1] - preview.a[1]) } : null);
  const fs = $derived(13 / scale);
  const gridStep = $derived(scale > 60 ? 0.5 : scale > 20 ? 1 : 5);
</script>

<div bind:this={el} class="absolute inset-0 touch-none select-none overflow-hidden bg-[#FBFAF7] {editor.mode === 'comment' ? 'cursor-crosshair' : editor.tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}"
  role="application" aria-label="Floor plan editor canvas. Use the toolbar to choose a tool."
  {onpointerdown} {onpointermove} {onpointerup} onpointercancel={onpointerup} {onwheel}
  oncontextmenu={(e) => e.preventDefault()} onpointerleave={() => (hover = null)}>
  <svg width={W} height={H} viewBox={vb} class="block">
    <defs>
      <pattern id="grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
        <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="#E7E3DB" stroke-width={1 / scale} />
      </pattern>
    </defs>
    <rect x={cx - W / scale} y={cy - H / scale} width={(2 * W) / scale} height={(2 * H) / scale} fill="url(#grid)" />
    {#if editor.plan.site}
      <rect x="-4" y="-6" width={editor.plan.site.width} height={editor.plan.site.depth} fill="none" stroke="#9CB28A" stroke-dasharray={`${6 / scale} ${4 / scale}`} stroke-width={1.5 / scale} />
      <text x={-4 + 0.2} y={-6 - 0.25} font-size={fs * 0.85} fill="#5E7A4E">Lot {editor.plan.site.width} × {editor.plan.site.depth} m</text>
    {/if}

    {#each floor.rooms as r (r.id)}
      <polygon points={r.polygon.map((p) => p.join(',')).join(' ')} fill={ROOM_COLORS[r.type] ?? '#eee'}
        stroke={editor.selection?.id === r.id ? '#A4502F' : 'none'} stroke-width={editor.selection?.id === r.id ? 3 / scale : 0} />
    {/each}
    {#each floor.walls as w (w.id)}
      <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={editor.selection?.id === w.id ? '#A4502F' : '#1F2326'} stroke-width={w.thickness} stroke-linecap="square" />
    {/each}
    {#each floor.openings as o (o.id)}
      {@const w = wallById.get(o.wallId)}
      {#if w}
        {@const g = openingGeometry(w, o)}
        {@const sel = editor.selection?.id === o.id}
        <line x1={g.p0[0]} y1={g.p0[1]} x2={g.p1[0]} y2={g.p1[1]} stroke="#FBFAF7" stroke-width={w.thickness + 0.02} />
        {#if o.type === 'window'}
          <line x1={g.p0[0]} y1={g.p0[1]} x2={g.p1[0]} y2={g.p1[1]} stroke={sel ? '#A4502F' : '#4E8FB0'} stroke-width={Math.max(0.05, 3 / scale)} />
        {:else if o.width < 1.3}
          <path d={`M${g.p1[0]},${g.p1[1]} A${o.width},${o.width} 0 0 0 ${g.p0[0] + g.nx * o.width},${g.p0[1] + g.ny * o.width} L${g.p0[0]},${g.p0[1]}`} fill={sel ? '#F4E4DA' : 'none'} stroke={sel ? '#A4502F' : '#8A8F93'} stroke-width={1.2 / scale} />
        {:else}
          <line x1={g.p0[0]} y1={g.p0[1]} x2={g.p1[0]} y2={g.p1[1]} stroke={sel ? '#A4502F' : '#C9C4BA'} stroke-width={1.5 / scale} stroke-dasharray={`${4 / scale} ${3 / scale}`} />
        {/if}
      {/if}
    {/each}

    {#each floor.rooms as r (r.id)}
      {@const c = polygonCentroid(r.polygon)}
      {#if Math.sqrt(r.area) * scale > 46}
        <text x={c[0]} y={c[1]} font-size={fs} text-anchor="middle" font-weight="600" fill="#1F2326" style="pointer-events:none">{r.name}</text>
        <text x={c[0]} y={c[1] + fs * 1.25} font-size={fs * 0.85} text-anchor="middle" fill="#4A5055" style="pointer-events:none">{r.area.toFixed(1)} m²</text>
      {/if}
    {/each}

    {#if selWall && editor.showDims}
      {@const mid = [(selWall.a[0] + selWall.b[0]) / 2, (selWall.a[1] + selWall.b[1]) / 2]}
      <g style="pointer-events:none">
        <rect x={mid[0] - 2.2 * fs} y={mid[1] - 1.9 * fs} width={4.4 * fs} height={1.4 * fs} rx={0.3 * fs} fill="#1F2326" />
        <text x={mid[0]} y={mid[1] - 0.85 * fs} font-size={fs * 0.9} text-anchor="middle" fill="#fff">{dist(selWall.a, selWall.b).toFixed(2)} m</text>
      </g>
    {/if}

    {#if preview?.kind === 'rect' && rectDims}
      <rect x={Math.min(preview.a[0], preview.b[0])} y={Math.min(preview.a[1], preview.b[1])} width={rectDims.w} height={rectDims.h} fill="#A4502F22" stroke="#A4502F" stroke-width={2 / scale} />
      <text x={Math.min(preview.a[0], preview.b[0]) + rectDims.w / 2} y={Math.min(preview.a[1], preview.b[1]) - 0.4 * fs} font-size={fs} text-anchor="middle" fill="#A4502F" font-weight="600">{rectDims.w.toFixed(1)} × {rectDims.h.toFixed(1)} m · {(rectDims.w * rectDims.h).toFixed(1)} m²</text>
    {/if}
    {#if preview?.kind === 'line'}
      <line x1={preview.a[0]} y1={preview.a[1]} x2={preview.b[0]} y2={preview.b[1]} stroke="#A4502F" stroke-width={editor.newWallThickness} stroke-opacity="0.6" />
      <text x={(preview.a[0] + preview.b[0]) / 2} y={(preview.a[1] + preview.b[1]) / 2 - 0.5 * fs} font-size={fs} text-anchor="middle" fill="#A4502F" font-weight="600">{dist(preview.a, preview.b).toFixed(2)} m</text>
    {/if}
    {#each wallChain as p}<circle cx={p[0]} cy={p[1]} r={5 / scale} fill="#A4502F" />{/each}
    {#if hover}<circle cx={hover[0]} cy={hover[1]} r={5 / scale} fill="none" stroke="#A4502F" stroke-width={2 / scale} />{/if}
    {#if pressing}<circle cx={pressing[0]} cy={pressing[1]} r={22 / scale} fill="#A4502F22" stroke="#A4502F" stroke-width={2 / scale}><animate attributeName="r" from={8 / scale} to={26 / scale} dur="0.45s" fill="freeze" /></circle>{/if}

    {#each pins as c (c.id)}
      {@const p = editor.resolveAnchor(c.anchor)}
      {#if p}
        {@const s = 16 / scale}
        <g transform={`translate(${p[0]} ${p[1]})`} opacity={c.status === 'resolved' ? 0.5 : 1}>
          <path d={`M0 0 C ${-s * 0.9} ${-s * 0.9} ${-s * 0.9} ${-s * 1.9} 0 ${-s * 1.9} C ${s * 0.9} ${-s * 1.9} ${s * 0.9} ${-s * 0.9} 0 0Z`} fill={c.role === 'architect' ? '#1F2326' : '#A4502F'} stroke="#fff" stroke-width={1.5 / scale} />
          <text y={-s * 1.08} font-size={s * 0.75} text-anchor="middle">{CATEGORY_ICON[c.category ?? 'question']}</text>
        </g>
      {/if}
    {/each}
  </svg>
</div>
