<script lang="ts">
  import type { Editor, Hit } from './editor.svelte';
  import { ROOM_COLORS, type Floor, type Site } from '@shared/planspec/schema';
  import type { Comment } from '@shared/comments/model';
  import { CATEGORY_ICON } from '@shared/comments/model';
  import { polygonCentroid, polygonArea, projectOnSegment, dist, type Vec2 } from '@shared/util/geometry';
  import * as site from '@shared/planspec/site';
  import { openingGeometry, floorBounds } from '../engine/planSvg';
  import { onMount } from 'svelte';

  let { editor, pins = [], onCommentTap, onPinTap, onRoomCreated, onError }: {
    editor: Editor; pins?: Comment[];
    onCommentTap: (hit: Hit) => void; onPinTap: (c: Comment) => void; onRoomCreated?: (id: string) => void; onError?: (msg: string) => void;
  } = $props();

  let el: HTMLDivElement;
  let W = $state(800), H = $state(600);
  let cx = $state(0), cy = $state(0), scale = $state(40); // px per metre
  let hover = $state<Vec2 | null>(null);
  let preview = $state<{ kind: 'rect'; a: Vec2; b: Vec2 } | { kind: 'line'; a: Vec2; b: Vec2 } | null>(null);
  let wallChain = $state<Vec2[]>([]);
  let pressing = $state<Vec2 | null>(null);

  const floor = $derived(editor.floor);
  const lot = $derived(editor.plan.site);
  const tolPx = 14;
  const tol = $derived(tolPx / scale);
  const vb = $derived(`${cx - W / 2 / scale} ${cy - H / 2 / scale} ${W / scale} ${H / scale}`);
  /** drawing an outline: a polygon room, or a new lot */
  const outlining = $derived((editor.tool === 'room' && editor.roomShape === 'polygon') || (editor.tool === 'site' && editor.drawingLot));

  export function fit() {
    const pts: Vec2[] = [];
    const useLot = editor.tool === 'site' || !floor.walls.length;
    if (useLot && lot?.boundary) {
      pts.push(...lot.boundary);
      for (const r of site.roadShapes(lot)) pts.push(...r.verge, r.asphalt[2], r.asphalt[3]);
    } else {
      const b = floorBounds(floor, 1.5);
      pts.push([b.x, b.y], [b.x + b.w, b.y + b.h]);
    }
    const b = site.bounds(pts.length ? pts : [[0, 0], [20, 20]]);
    cx = b.x + b.w / 2;
    cy = b.y + b.h / 2;
    scale = Math.max(4, Math.min(200, Math.min(W / Math.max(b.w, 1), H / Math.max(b.h, 1)) * 0.86));
  }
  export function zoomBy(f: number) { scale = Math.max(4, Math.min(400, scale * f)); }

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

  // ---- handles (corners you can drag) -------------------------------------------------------
  type Handle =
    | { kind: 'vertex'; point: Vec2 }
    | { kind: 'mid'; point: Vec2; wallId: string }
    | { kind: 'lot-vertex'; point: Vec2; i: number }
    | { kind: 'lot-mid'; point: Vec2; i: number }
    | { kind: 'entrance'; point: Vec2 };

  /** Room whose corners are showing (selected room, or the room a selected corner came from). */
  const handleRoom = $derived.by(() => {
    const s = editor.selection;
    if (!s || editor.tool !== 'select' || editor.mode !== 'edit') return null;
    const id = s.kind === 'room' || s.kind === 'vertex' ? s.id : '';
    return floor.rooms.find((r) => r.id === id) ?? null;
  });

  const handles = $derived.by((): Handle[] => {
    if (editor.mode !== 'edit') return [];
    if (editor.tool === 'site') {
      if (!lot?.boundary || editor.drawingLot) return [];
      const b = lot.boundary;
      const out: Handle[] = b.map((point, i) => ({ kind: 'lot-vertex', point, i }));
      b.forEach((_, i) => {
        if (site.edgeLength(b, i) * scale <= 60) return;
        // keep the ⊕ clear of the entrance arrow when that sits mid-side
        const et = lot.entrance?.edge === i ? lot.entrance.t : null;
        const t = et !== null && Math.abs(et - 0.5) < 0.18 ? (et < 0.5 ? 0.75 : 0.25) : 0.5;
        const [p, q] = site.edgeOf(b, i);
        out.push({ kind: 'lot-mid', point: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], i });
      });
      const e = site.entrancePoint(lot);
      if (e) out.push({ kind: 'entrance', point: e.p });
      return out;
    }
    if (editor.tool !== 'select') return [];
    const out: Handle[] = [];
    const s = editor.selection;
    if (handleRoom) {
      const poly = handleRoom.polygon;
      for (const point of poly) out.push({ kind: 'vertex', point });
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length];
        if (dist(p, q) * scale < 56 || dist(p, q) < 0.4) return;
        const m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const w = floor.walls.find((x) => projectOnSegment(m, x.a, x.b).d < 0.03);
        if (w) out.push({ kind: 'mid', point: m, wallId: w.id });
      });
    }
    if (s?.kind === 'wall') {
      const w = floor.walls.find((x) => x.id === s.id);
      if (w) out.push({ kind: 'vertex', point: w.a }, { kind: 'vertex', point: w.b });
    }
    if (s?.kind === 'vertex' && !out.some((h) => h.kind === 'vertex' && dist(h.point, s.point) < 0.02)) out.push({ kind: 'vertex', point: s.point });
    return out;
  });

  function handleAt(w: Vec2, pointerType: string): Handle | null {
    const r = (pointerType === 'mouse' ? 12 : 22) / scale;
    let best: Handle | null = null, bd = r;
    for (const h of handles) {
      // corners win over mid handles and the entrance when they overlap
      const d = dist(h.point, w) * (h.kind === 'mid' || h.kind === 'lot-mid' ? 1.25 : 1);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  function lotEdgeAt(w: Vec2): number | null {
    if (!lot?.boundary) return null;
    let best: number | null = null, bd = tol * 1.2;
    lot.boundary.forEach((_, i) => {
      const d = projectOnSegment(w, ...site.edgeOf(lot.boundary!, i)).d;
      if (d < bd) { bd = d; best = i; }
    });
    // tapping the road itself also picks its side
    if (best === null) for (const r of site.roadShapes(lot)) if (inPoly(w, [...r.verge.slice(0, 2), r.asphalt[2], r.asphalt[3]])) return r.edge;
    return best;
  }
  const inPoly = (p: Vec2, poly: Vec2[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // ---- gestures ---------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: null | {
    type: 'pan' | 'pinch' | 'drag-wall' | 'drag-opening' | 'rect' | 'pending' | 'drag-vertex' | 'drag-lot' | 'drag-entrance';
    startWorld: Vec2; startClient: { x: number; y: number }; startCx: number; startCy: number; startScale: number;
    startDist?: number; startMid?: { x: number; y: number }; id?: string; startFloor?: Floor; snapshot?: string; moved: boolean; pointerType: string; t0: number;
    pushed?: boolean; handle?: Handle; p0?: Vec2; startSite?: Site; lotIndex?: number;
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

  function beginHandle(h: Handle) {
    if (!gesture) return;
    gesture.handle = h;
    gesture.snapshot = editor.snapshot();
    if (h.kind === 'vertex' || h.kind === 'mid') {
      gesture.type = 'drag-vertex';
      gesture.startFloor = structuredClone($state.snapshot(editor.floor)) as Floor;
      gesture.p0 = h.point;
    } else {
      gesture.type = h.kind === 'entrance' ? 'drag-entrance' : 'drag-lot';
      gesture.startSite = structuredClone($state.snapshot(editor.site)) as Site;
      if (h.kind !== 'entrance') gesture.lotIndex = h.i;
    }
  }

  function pushOnce() {
    if (gesture?.snapshot && !gesture.pushed) { editor.pushHistory(gesture.snapshot); gesture.pushed = true; }
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
    if (outlining) return; // taps add corners; drags pan
    const h = handleAt(w, e.pointerType);
    if (h) { beginHandle(h); return; }
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
    if (e.pointerType === 'mouse') {
      const last = editor.draft[editor.draft.length - 1] ?? wallChain[wallChain.length - 1];
      hover = outlining ? snapDraft(w) : editor.tool === 'wall' ? editor.snapPoint(w, tol, { from: last }) : editor.tool === 'door' || editor.tool === 'window' ? editor.snapPoint(w, tol) : null;
    }
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
        const ns = Math.max(4, Math.min(400, gesture.startScale * (d / gesture.startDist!)));
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
        pushOnce();
        editor.moveWallFrom(gesture.startFloor!, gesture.id!, [w[0] - gesture.startWorld[0], w[1] - gesture.startWorld[1]]);
        break;
      case 'drag-opening':
        if (!gesture.moved) return;
        pushOnce();
        editor.moveOpeningFrom(gesture.startFloor!, gesture.id!, w);
        break;
      case 'drag-vertex': {
        if (!gesture.moved) return;
        const h = gesture.handle!;
        if (h.kind === 'mid' && !gesture.pushed) {
          // pulling the middle of a side adds a corner there
          const sp = editor.splitWall(gesture.startFloor!, h.wallId, h.point);
          if (!sp) { gesture.type = 'pan'; return; }
          gesture.startFloor = sp.floor;
          gesture.p0 = sp.point;
        }
        pushOnce();
        const target: Vec2 = [gesture.p0![0] + w[0] - gesture.startWorld[0], gesture.p0![1] + w[1] - gesture.startWorld[1]];
        editor.moveVertexFrom(gesture.startFloor!, gesture.p0!, target, tol);
        break;
      }
      case 'drag-lot': {
        if (!gesture.moved) return;
        const h = gesture.handle!;
        if (h.kind === 'lot-mid' && !gesture.pushed) {
          gesture.startSite = site.insertVertex(gesture.startSite!, h.i, h.point);
          gesture.lotIndex = h.i + 1;
          editor.siteSelection = null;
        }
        pushOnce();
        const p0 = gesture.startSite!.boundary![gesture.lotIndex!];
        editor.moveLotVertexFrom(gesture.startSite!, gesture.lotIndex!, [p0[0] + w[0] - gesture.startWorld[0], p0[1] + w[1] - gesture.startWorld[1]], tol);
        break;
      }
      case 'drag-entrance':
        if (!gesture.moved) return;
        pushOnce();
        editor.setSite({ ...editor.site, entrance: site.entranceNear(gesture.startSite!, w) }, false);
        break;
    }
    if (editor.tool === 'wall' && wallChain.length) preview = { kind: 'line', a: wallChain[wallChain.length - 1], b: editor.snapPoint(w, tol, { from: wallChain[wallChain.length - 1] }) };
  }

  function snapDraft(w: Vec2): Vec2 {
    const d = editor.draft;
    if (editor.tool === 'site') return editor.snapPoint(w, tol, { floor: { ...floor, walls: [] }, extra: d.slice(0, 1), from: d[d.length - 1] });
    return editor.snapPoint(w, tol, { from: d[d.length - 1], extra: d.slice(0, 1) });
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
    // tapping a handle selects that corner
    if (g.handle) {
      const h = g.handle;
      if (h.kind === 'vertex') editor.selection = { kind: 'vertex', id: handleRoom?.id ?? '', point: h.point };
      if (h.kind === 'lot-vertex') editor.siteSelection = { kind: 'lot-vertex', i: h.i };
      if (h.kind === 'lot-mid') editor.siteSelection = { kind: 'lot-edge', i: h.i };
      return;
    }
    if (editor.mode === 'comment') {
      // pins have priority
      const pin = pinAt(w);
      if (pin) return onPinTap(pin);
      return onCommentTap(editor.hitTest(w, tol));
    }
    if (outlining) return addDraftPoint(snapDraft(w));
    const pin = pinAt(w);
    if (pin) return onPinTap(pin);
    switch (editor.tool) {
      case 'select': {
        const hit = editor.hitTest(w, tol);
        editor.selection = hit.kind === 'space' ? null : { kind: hit.kind, id: hit.id };
        break;
      }
      case 'site': {
        const i = lotEdgeAt(w);
        editor.siteSelection = i === null ? null : { kind: 'lot-edge', i };
        break;
      }
      case 'wall': {
        const p = editor.snapPoint(w, tol, { from: wallChain[wallChain.length - 1] });
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

  // ---- outline drawing (polygon rooms, new lot) ----------------------------------------------
  function addDraftPoint(p: Vec2) {
    const d = editor.draft;
    if (d.length >= 3 && dist(p, d[0]) < tol * 1.2) return closeShape();
    if (d.length && dist(p, d[d.length - 1]) < 0.05) return;
    editor.draft = [...d, p];
  }
  /** Finish the outline being drawn (room or lot). Returns false when there's nothing to close. */
  export function closeShape(): boolean {
    const d = editor.draft;
    if (d.length < 3) { if (d.length) onError?.('Add at least 3 corners first'); return false; }
    if (editor.tool === 'site') {
      const err = editor.replaceLot(d);
      if (err) { onError?.(err); return false; }
      editor.drawingLot = false;
    } else {
      const res = editor.addRoomPolygon(d);
      if (res.error) { onError?.(res.error); return false; }
      if (res.id) onRoomCreated?.(res.id);
    }
    editor.draft = [];
    hover = null;
    return true;
  }
  export function undoPoint() { editor.draft = editor.draft.slice(0, -1); }

  export function finishChain() { wallChain = []; preview = null; editor.draft = []; }
  $effect(() => { if (editor.tool !== 'wall') { wallChain = []; preview = null; } });
  $effect(() => { if (!outlining && editor.draft.length) editor.draft = []; });

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    scale = Math.max(4, Math.min(400, scale * f));
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
  const roads = $derived(lot ? site.roadShapes(lot) : []);
  const entrance = $derived(lot ? site.entrancePoint(lot) : null);
  const draftPts = $derived(hover && outlining ? [...editor.draft, hover] : editor.draft);
  const siteTool = $derived(editor.tool === 'site' && editor.mode === 'edit');
  const lotLabelAt = $derived(lot?.boundary ? [...lot.boundary].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0] : null);

  /** a length tag placed just outside (or inside) an edge */
  function edgeTag(a: Vec2, b: Vec2, off: number) {
    const len = dist(a, b) || 1;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return { x: (a[0] + b[0]) / 2 + nx * off, y: (a[1] + b[1]) / 2 + ny * off, ang, len };
  }
  const pts = (p: Vec2[]) => p.map((q) => q.join(',')).join(' ');
</script>

<div bind:this={el} class="absolute inset-0 touch-none select-none overflow-hidden bg-[#FBFAF7] {editor.mode === 'comment' ? 'cursor-crosshair' : editor.tool === 'select' || (siteTool && !editor.drawingLot) ? 'cursor-default' : 'cursor-crosshair'}"
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

    <!-- roads along the lot -->
    {#each roads as r (r.edge)}
      {@const sel = siteTool && editor.siteSelection?.kind === 'lot-edge' && editor.siteSelection.i === r.edge}
      <polygon points={pts(r.asphalt)} fill={sel ? '#A9A39B' : '#C4C1BB'} />
      <polygon points={pts(r.verge)} fill="#E6E2DA" />
      <line x1={r.centre[0][0]} y1={r.centre[0][1]} x2={r.centre[1][0]} y2={r.centre[1][1]} stroke="#FFFFFF" stroke-width={Math.max(0.08, 1.5 / scale)} stroke-dasharray="1.5 1.5" />
      {#if r.width * scale > 18}
        <text x={r.label[0]} y={r.label[1]} transform={`rotate(${r.labelAngle} ${r.label[0]} ${r.label[1]})`} dy={fs * 0.35} font-size={Math.min(fs, r.width * 0.3)} text-anchor="middle" font-weight="600" fill="#4A5055" letter-spacing="0.08em" style="pointer-events:none">{r.name.toUpperCase()}</text>
      {/if}
    {/each}

    {#if lot?.boundary}
      <polygon points={pts(lot.boundary)} fill="#EEF2E8" fill-opacity={siteTool ? 0.9 : 0.6} stroke="#7F9A6E" stroke-dasharray={`${6 / scale} ${4 / scale}`} stroke-width={(siteTool ? 2 : 1.5) / scale} />
      {#if lotLabelAt && !siteTool}
        <text x={lotLabelAt[0] + 0.3} y={lotLabelAt[1] + fs * 1.3} font-size={fs * 0.85} fill="#5E7A4E" style="pointer-events:none">Lot · {site.lotArea(lot).toFixed(0)} m²</text>
      {/if}
      {#if siteTool}
        {#each lot.boundary as p, i}
          {@const q = lot.boundary[(i + 1) % lot.boundary.length]}
          {@const tag = edgeTag(p, q, site.signedAreaSign(lot.boundary) * -1.1 * fs)}
          {@const sel = editor.siteSelection?.kind === 'lot-edge' && editor.siteSelection.i === i}
          {#if sel}<line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#A4502F" stroke-width={4 / scale} />{/if}
          {#if tag.len * scale > 50}
            <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.8} text-anchor="middle" fill={sel ? '#A4502F' : '#5E7A4E'} font-weight="600" style="pointer-events:none">{tag.len.toFixed(2)} m · {site.edgeFacing(lot, i, true)}</text>
          {/if}
        {/each}
      {/if}
    {/if}

    {#each floor.rooms as r (r.id)}
      <polygon points={pts(r.polygon)} fill={ROOM_COLORS[r.type] ?? '#eee'} fill-opacity={siteTool ? 0.55 : 1}
        stroke={editor.selection?.id === r.id ? '#A4502F' : 'none'} stroke-width={editor.selection?.id === r.id ? 3 / scale : 0} />
    {/each}
    {#each floor.walls as w (w.id)}
      <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={editor.selection?.id === w.id ? '#A4502F' : '#1F2326'} stroke-opacity={siteTool ? 0.5 : 1} stroke-width={w.thickness} stroke-linecap="square" />
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

    <!-- main entrance -->
    {#if entrance}
      {@const s = Math.max(0.9, 18 / scale)}
      {@const n = entrance.n}
      {@const p = entrance.p}
      {@const ang = (Math.atan2(-n[1], -n[0]) * 180) / Math.PI}
      <g transform={`translate(${p[0]} ${p[1]}) rotate(${ang})`} style="pointer-events:none">
        <path d={`M ${-s * 1.6} ${-s * 0.32} L ${-s * 0.2} ${-s * 0.32} L ${-s * 0.2} ${-s * 0.75} L ${s * 0.75} 0 L ${-s * 0.2} ${s * 0.75} L ${-s * 0.2} ${s * 0.32} L ${-s * 1.6} ${s * 0.32} Z`}
          fill="#A4502F" stroke="#fff" stroke-width={1.5 / scale} />
      </g>
      <text x={p[0] + n[0] * s * 2.4} y={p[1] + n[1] * s * 2.4} dy={fs * 0.35} font-size={fs * 0.85} text-anchor="middle" font-weight="700" fill="#A4502F" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale} style="pointer-events:none">Entrance</text>
    {/if}

    {#if selWall && editor.showDims}
      {@const mid = [(selWall.a[0] + selWall.b[0]) / 2, (selWall.a[1] + selWall.b[1]) / 2]}
      <g style="pointer-events:none">
        <rect x={mid[0] - 2.2 * fs} y={mid[1] - 1.9 * fs} width={4.4 * fs} height={1.4 * fs} rx={0.3 * fs} fill="#1F2326" />
        <text x={mid[0]} y={mid[1] - 0.85 * fs} font-size={fs * 0.9} text-anchor="middle" fill="#fff">{dist(selWall.a, selWall.b).toFixed(2)} m</text>
      </g>
    {/if}
    {#if handleRoom && editor.showDims}
      {@const poly = handleRoom.polygon}
      {@const sign = site.signedAreaSign(poly)}
      {#each poly as p, i}
        {@const q = poly[(i + 1) % poly.length]}
        {@const tag = edgeTag(p, q, sign * 1.0 * fs)}
        {#if tag.len * scale > 44}
          <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.78} text-anchor="middle" fill="#A4502F" font-weight="600" style="pointer-events:none">{tag.len.toFixed(2)}</text>
        {/if}
      {/each}
    {/if}

    {#if preview?.kind === 'rect' && rectDims}
      <rect x={Math.min(preview.a[0], preview.b[0])} y={Math.min(preview.a[1], preview.b[1])} width={rectDims.w} height={rectDims.h} fill="#A4502F22" stroke="#A4502F" stroke-width={2 / scale} />
      <text x={Math.min(preview.a[0], preview.b[0]) + rectDims.w / 2} y={Math.min(preview.a[1], preview.b[1]) - 0.4 * fs} font-size={fs} text-anchor="middle" fill="#A4502F" font-weight="600">{rectDims.w.toFixed(1)} × {rectDims.h.toFixed(1)} m · {(rectDims.w * rectDims.h).toFixed(1)} m²</text>
    {/if}
    {#if preview?.kind === 'line'}
      <line x1={preview.a[0]} y1={preview.a[1]} x2={preview.b[0]} y2={preview.b[1]} stroke="#A4502F" stroke-width={editor.newWallThickness} stroke-opacity="0.6" />
      <text x={(preview.a[0] + preview.b[0]) / 2} y={(preview.a[1] + preview.b[1]) / 2 - 0.5 * fs} font-size={fs} text-anchor="middle" fill="#A4502F" font-weight="600">{dist(preview.a, preview.b).toFixed(2)} m</text>
    {/if}

    <!-- outline being drawn -->
    {#if outlining && draftPts.length}
      {@const col = editor.tool === 'site' ? '#5E7A4E' : '#A4502F'}
      {#if draftPts.length >= 3}<polygon points={pts(draftPts)} fill={col} fill-opacity="0.12" stroke="none" />{/if}
      <polyline points={pts(draftPts)} fill="none" stroke={col} stroke-width={editor.tool === 'site' ? 2 / scale : editor.newWallThickness} stroke-opacity="0.7" stroke-linejoin="round" />
      {#if draftPts.length >= 3}
        {@const last = draftPts[draftPts.length - 1]}
        <line x1={last[0]} y1={last[1]} x2={draftPts[0][0]} y2={draftPts[0][1]} stroke={col} stroke-width={1.5 / scale} stroke-dasharray={`${5 / scale} ${4 / scale}`} />
        {@const c = polygonCentroid(draftPts)}
        <text x={c[0]} y={c[1]} font-size={fs} text-anchor="middle" fill={col} font-weight="700" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale}>{polygonArea(draftPts).toFixed(1)} m²</text>
      {/if}
      {#each draftPts.slice(1) as p, i}
        {@const tag = edgeTag(draftPts[i], p, -0.9 * fs)}
        {#if tag.len * scale > 40}
          <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.8} text-anchor="middle" fill={col} font-weight="600" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale}>{tag.len.toFixed(2)} m</text>
        {/if}
      {/each}
      {#each editor.draft as p, i}
        <circle cx={p[0]} cy={p[1]} r={(i === 0 && editor.draft.length >= 3 ? 8 : 5) / scale} fill={i === 0 ? '#fff' : col} stroke={col} stroke-width={2 / scale} />
      {/each}
    {/if}

    {#each wallChain as p}<circle cx={p[0]} cy={p[1]} r={5 / scale} fill="#A4502F" />{/each}
    {#if hover}<circle cx={hover[0]} cy={hover[1]} r={5 / scale} fill="none" stroke="#A4502F" stroke-width={2 / scale} />{/if}
    {#if pressing}<circle cx={pressing[0]} cy={pressing[1]} r={22 / scale} fill="#A4502F22" stroke="#A4502F" stroke-width={2 / scale}><animate attributeName="r" from={8 / scale} to={26 / scale} dur="0.45s" fill="freeze" /></circle>{/if}

    <!-- drag handles -->
    {#each handles as h}
      {@const selV = (h.kind === 'vertex' && editor.selection?.kind === 'vertex' && dist(editor.selection.point, h.point) < 0.02) || (h.kind === 'lot-vertex' && editor.siteSelection?.kind === 'lot-vertex' && editor.siteSelection.i === h.i)}
      {#if h.kind === 'vertex' || h.kind === 'lot-vertex'}
        <circle cx={h.point[0]} cy={h.point[1]} r={(selV ? 8 : 6.5) / scale} fill={selV ? '#A4502F' : '#fff'} stroke={h.kind === 'lot-vertex' ? '#5E7A4E' : '#A4502F'} stroke-width={2.5 / scale} />
      {:else if h.kind === 'mid' || h.kind === 'lot-mid'}
        {@const r = 6 / scale}
        <g opacity="0.85">
          <circle cx={h.point[0]} cy={h.point[1]} r={r} fill="#fff" stroke={h.kind === 'lot-mid' ? '#5E7A4E' : '#A4502F'} stroke-width={1.5 / scale} stroke-dasharray={`${2 / scale} ${1.5 / scale}`} />
          <path d={`M${h.point[0] - r * 0.55} ${h.point[1]} h${r * 1.1} M${h.point[0]} ${h.point[1] - r * 0.55} v${r * 1.1}`} stroke={h.kind === 'lot-mid' ? '#5E7A4E' : '#A4502F'} stroke-width={1.5 / scale} />
        </g>
      {:else}
        <circle cx={h.point[0]} cy={h.point[1]} r={9 / scale} fill="none" stroke="#A4502F" stroke-width={2 / scale} stroke-dasharray={`${3 / scale} ${2 / scale}`} />
      {/if}
    {/each}

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
