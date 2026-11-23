<script lang="ts">
  /**
   * The one plan canvas: the lot, each floor's footprint and the rooms are all drawn and edited
   * here with the same point-by-point interaction (tap each corner, snapping to the 1 m grid; tap
   * the first corner or Done to close; drag corners, pull a ⊕ to add one).
   */
  import type { Editor, Hit } from './editor.svelte';
  import { ROOM_COLORS, floorLabel, type Floor, type Site } from '@shared/planspec/schema';
  import type { Comment } from '@shared/comments/model';
  import { CATEGORY_ICON } from '@shared/comments/model';
  import { polygonCentroid, polygonArea, projectOnSegment, dist, distToBoundary, type Vec2 } from '@shared/util/geometry';
  import * as site from '@shared/planspec/site';
  import { openingGeometry, floorBounds } from '../engine/planSvg';
  import MapTiles from './MapTiles.svelte';
  import { ATTRIBUTION, type GeoOrigin } from '@shared/geo/osm';
  import { onMount } from 'svelte';

  let { editor, pins = [], onCommentTap, onPinTap, onRoomCreated, onError, onLotDrawn, onFootprintDrawn, map = null, mapOpacity = 1, emptyView = 40, padBottom = 64 }: {
    editor: Editor; pins?: Comment[];
    onCommentTap?: (hit: Hit) => void; onPinTap?: (c: Comment) => void; onRoomCreated?: (id: string) => void; onError?: (msg: string) => void;
    onLotDrawn?: () => void; onFootprintDrawn?: () => void;
    /** OpenStreetMap underlay: origin of the plan and how far the plan is turned from north-up */
    map?: (GeoOrigin & { rotation: number }) | null; mapOpacity?: number;
    /** metres shown when there's nothing to fit yet */
    emptyView?: number;
    /** pixels at the bottom covered by panels (kept clear when fitting) */
    padBottom?: number;
  } = $props();

  let el: HTMLDivElement;
  let W = $state(800), H = $state(600);
  let cx = $state(0), cy = $state(0), scale = $state(40); // px per metre
  let hover = $state<Vec2 | null>(null);
  let preview = $state<{ kind: 'rect'; a: Vec2; b: Vec2 } | { kind: 'line'; a: Vec2; b: Vec2 } | null>(null);
  let wallChain = $state<Vec2[]>([]);
  let pressing = $state<Vec2 | null>(null);

  const floor = $derived(editor.floor);
  const lot = $derived(editor.plan.site?.boundary ? editor.plan.site : undefined);
  const footprint = $derived(floor.footprint ?? null);
  const below = $derived(editor.floorBelow);
  const tolPx = 14;
  const tol = $derived(tolPx / scale);
  const view = $derived({ x: cx - W / 2 / scale, y: cy - H / 2 / scale, w: W / scale, h: H / scale });
  const vb = $derived(`${view.x} ${view.y} ${view.w} ${view.h}`);
  /** drawing an outline: a polygon room, a new lot, or a footprint */
  const outlining = $derived((editor.tool === 'room' && editor.roomShape === 'polygon') || (editor.tool === 'site' && editor.drawingLot) || (editor.tool === 'footprint' && editor.drawingFootprint));
  const siteTool = $derived(editor.tool === 'site' && editor.mode === 'edit');
  const fpTool = $derived(editor.tool === 'footprint' && editor.mode === 'edit');

  export function fit() {
    const pts: Vec2[] = [];
    const useLot = editor.tool === 'site' || editor.tool === 'footprint' || !floor.walls.length;
    if (useLot && lot?.boundary) {
      pts.push(...lot.boundary);
      for (const r of site.roadShapes(lot)) pts.push(...r.verge, r.asphalt[2], r.asphalt[3]);
    } else if (useLot && footprint) {
      pts.push(...footprint);
    } else if (floor.walls.length) {
      const b = floorBounds(floor, 1.5);
      pts.push([b.x, b.y], [b.x + b.w, b.y + b.h]);
    }
    if (!pts.length) {
      const e = emptyView / 2;
      pts.push(map ? [-e, -e] : [-2, -2], map ? [e, e] : [emptyView - 2, emptyView - 2]);
    }
    const b = site.bounds(pts);
    const h = Math.max(120, H - padBottom);
    scale = Math.max(2, Math.min(200, Math.min(W / Math.max(b.w, 1), h / Math.max(b.h, 1)) * 0.86));
    cx = b.x + b.w / 2;
    cy = b.y + b.h / 2 + padBottom / 2 / scale;
  }
  export function zoomBy(f: number) { scale = Math.max(2, Math.min(400, scale * f)); }
  export function centreOn(p: Vec2, s?: number) { cx = p[0]; cy = p[1]; if (s) scale = s; }

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
    | { kind: 'fp-vertex'; point: Vec2; i: number }
    | { kind: 'fp-mid'; point: Vec2; i: number }
    | { kind: 'entrance'; point: Vec2 };

  /** Room whose corners are showing (selected room, or the room a selected corner came from). */
  const handleRoom = $derived.by(() => {
    const s = editor.selection;
    if (!s || editor.tool !== 'select' || editor.mode !== 'edit') return null;
    const id = s.kind === 'room' || s.kind === 'vertex' ? s.id : '';
    return floor.rooms.find((r) => r.id === id) ?? null;
  });

  function polyHandles(poly: Vec2[], kind: 'lot' | 'fp', skipT?: (i: number) => number): Handle[] {
    const out: Handle[] = poly.map((point, i) => ({ kind: `${kind}-vertex`, point, i }) as Handle);
    poly.forEach((_, i) => {
      if (site.edgeLength(poly, i) * scale <= 60) return;
      const t = skipT?.(i) ?? 0.5;
      const [p, q] = site.edgeOf(poly, i);
      out.push({ kind: `${kind}-mid`, point: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], i } as Handle);
    });
    return out;
  }

  const handles = $derived.by((): Handle[] => {
    if (editor.mode !== 'edit') return [];
    if (editor.tool === 'site') {
      if (!lot?.boundary || editor.drawingLot) return [];
      // keep the ⊕ clear of the entrance arrow when that sits mid-side
      const out = polyHandles(lot.boundary, 'lot', (i) => {
        const et = lot.entrance?.edge === i ? lot.entrance.t : null;
        return et !== null && Math.abs(et - 0.5) < 0.18 ? (et < 0.5 ? 0.75 : 0.25) : 0.5;
      });
      const e = site.entrancePoint(lot);
      if (e) out.push({ kind: 'entrance', point: e.p });
      return out;
    }
    if (editor.tool === 'footprint') return footprint && !editor.drawingFootprint ? polyHandles(footprint, 'fp') : [];
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
        if (w && !editor.isEnvelopeWall(w)) out.push({ kind: 'mid', point: m, wallId: w.id });
      });
    }
    if (s?.kind === 'wall') {
      const w = floor.walls.find((x) => x.id === s.id);
      if (w && !editor.isEnvelopeWall(w)) out.push({ kind: 'vertex', point: w.a }, { kind: 'vertex', point: w.b });
    }
    if (s?.kind === 'vertex' && !out.some((h) => h.kind === 'vertex' && dist(h.point, s.point) < 0.02)) out.push({ kind: 'vertex', point: s.point });
    return out;
  });

  function handleAt(w: Vec2, pointerType: string): Handle | null {
    const r = (pointerType === 'mouse' ? 12 : 22) / scale;
    let best: Handle | null = null, bd = r;
    for (const h of handles) {
      // corners win over mid handles and the entrance when they overlap
      const d = dist(h.point, w) * (h.kind.endsWith('mid') ? 1.25 : 1);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  function edgeAt(poly: Vec2[] | null | undefined, w: Vec2): number | null {
    if (!poly) return null;
    let best: number | null = null, bd = tol * 1.2;
    poly.forEach((_, i) => {
      const d = projectOnSegment(w, ...site.edgeOf(poly, i)).d;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function lotEdgeAt(w: Vec2): number | null {
    if (!lot?.boundary) return null;
    const best = edgeAt(lot.boundary, w);
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
    type: 'pan' | 'pinch' | 'drag-wall' | 'drag-opening' | 'rect' | 'pending' | 'drag-vertex' | 'drag-lot' | 'drag-fp' | 'drag-entrance';
    startWorld: Vec2; startClient: { x: number; y: number }; startCx: number; startCy: number; startScale: number;
    startDist?: number; startMid?: { x: number; y: number }; id?: string; startFloor?: Floor; snapshot?: string; moved: boolean; pointerType: string; t0: number;
    pushed?: boolean; handle?: Handle; p0?: Vec2; startSite?: Site; startFp?: Vec2[]; index?: number; blocked?: string | null;
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
    } else if (h.kind === 'fp-vertex' || h.kind === 'fp-mid') {
      gesture.type = 'drag-fp';
      gesture.startFp = structuredClone($state.snapshot(footprint)) as Vec2[];
      gesture.index = h.i;
    } else {
      gesture.type = h.kind === 'entrance' ? 'drag-entrance' : 'drag-lot';
      gesture.startSite = structuredClone($state.snapshot(editor.site)) as Site;
      if (h.kind !== 'entrance') gesture.index = h.i;
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
      hover = outlining ? snapDraft(w) : editor.tool === 'wall' || editor.tool === 'door' || editor.tool === 'window' ? editor.snapPoint(w, tol) : null;
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
        const ns = Math.max(2, Math.min(400, gesture.startScale * (d / gesture.startDist!)));
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
          gesture.index = h.i + 1;
          editor.siteSelection = null;
        }
        pushOnce();
        const p0 = gesture.startSite!.boundary![gesture.index!];
        gesture.blocked = editor.moveLotVertexFrom(gesture.startSite!, gesture.index!, [p0[0] + w[0] - gesture.startWorld[0], p0[1] + w[1] - gesture.startWorld[1]], tol);
        break;
      }
      case 'drag-fp': {
        if (!gesture.moved) return;
        const h = gesture.handle!;
        if (h.kind === 'fp-mid' && !gesture.pushed) {
          gesture.startFp = editor.insertFootprintVertex(gesture.startFp!, h.i, h.point);
          gesture.index = h.i + 1;
          editor.siteSelection = null;
        }
        pushOnce();
        const p0 = gesture.startFp![gesture.index!];
        gesture.blocked = editor.moveFootprintVertexFrom(gesture.startFp!, gesture.index!, [p0[0] + w[0] - gesture.startWorld[0], p0[1] + w[1] - gesture.startWorld[1]], tol);
        break;
      }
      case 'drag-entrance':
        if (!gesture.moved) return;
        pushOnce();
        editor.setSite({ ...editor.site, entrance: site.entranceNear(gesture.startSite!, w) }, false);
        break;
    }
    if (editor.tool === 'wall' && wallChain.length) preview = { kind: 'line', a: wallChain[wallChain.length - 1], b: editor.snapPoint(w, tol) };
  }

  function snapDraft(w: Vec2): Vec2 {
    const d = editor.draft;
    if (editor.tool === 'site') return editor.snapLot(w, tol, d.slice(0, 1));
    if (editor.tool === 'footprint') return editor.snapFootprint(w, tol, d.slice(0, 1));
    return editor.snapPoint(w, tol, { extra: d.slice(0, 1) });
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
    if (g.blocked) onError?.(g.blocked);
    if (g.type === 'rect') {
      const p = preview as { a: Vec2; b: Vec2 } | null;
      preview = null;
      let a = p?.a ?? editor.snapPoint(w, tol), b = p?.b ?? a;
      if (tap || dist(a, b) < 0.5) {
        // tap: drop a default 4 × 3 m room around this grid point
        const c = editor.snapPoint(w, tol);
        a = [c[0] - 2, c[1] - 1]; b = [c[0] + 2, c[1] + 2];
      }
      const res = editor.addRoomRect(a, b);
      if (res.id) onRoomCreated?.(res.id);
      else if (res.error) onError?.(res.error);
      return;
    }
    if (!tap) return;
    // tapping a handle selects that corner
    if (g.handle) {
      const h = g.handle;
      if (h.kind === 'vertex') editor.selection = { kind: 'vertex', id: handleRoom?.id ?? '', point: h.point };
      if (h.kind === 'lot-vertex') editor.siteSelection = { kind: 'lot-vertex', i: h.i };
      if (h.kind === 'lot-mid') editor.siteSelection = { kind: 'lot-edge', i: h.i };
      if (h.kind === 'fp-vertex') editor.siteSelection = { kind: 'fp-vertex', i: h.i };
      if (h.kind === 'fp-mid') editor.siteSelection = { kind: 'fp-edge', i: h.i };
      return;
    }
    if (editor.mode === 'comment') {
      // pins have priority
      const pin = pinAt(w);
      if (pin) return onPinTap?.(pin);
      return onCommentTap?.(editor.hitTest(w, tol));
    }
    if (outlining) {
      // a tap well outside the footprint is a mistake, not a corner on its wall
      const b = editor.tool === 'room' ? editor.roomBounds : null;
      if (b && !inPoly(w, b) && distToBoundary(w, b) > Math.max(1, tol * 2)) return onError?.(`Rooms have to stay inside the ${floorLabel(floor.level).toLowerCase()} footprint`);
      return addDraftPoint(snapDraft(w));
    }
    const pin = pinAt(w);
    if (pin) return onPinTap?.(pin);
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
      case 'footprint': {
        const i = edgeAt(footprint, w);
        editor.siteSelection = i === null ? null : { kind: 'fp-edge', i };
        break;
      }
      case 'wall': {
        const p = editor.snapPoint(w, tol);
        if (wallChain.length && dist(p, wallChain[0]) < tol && wallChain.length > 2) {
          const err = editor.addWall(wallChain[wallChain.length - 1], wallChain[0]);
          if (err) onError?.(err);
          finishChain();
          break;
        }
        if (wallChain.length) { const err = editor.addWall(wallChain[wallChain.length - 1], p); if (err) { onError?.(err); break; } }
        wallChain = [...wallChain, p];
        break;
      }
      case 'door':
      case 'window':
        editor.addOpening(editor.tool, w, tol * 1.5);
        break;
      case 'erase': {
        const hit = editor.hitTest(w, tol);
        if (hit.kind !== 'space') { const err = editor.deleteElement({ kind: hit.kind, id: hit.id }); if (err) onError?.(err); }
        break;
      }
    }
  }

  // ---- outline drawing (lot, footprint, polygon rooms) -----------------------------------------
  function addDraftPoint(p: Vec2) {
    const d = editor.draft;
    if (d.length >= 3 && dist(p, d[0]) < Math.max(tol * 1.2, 0.3)) return closeShape();
    if (d.length && dist(p, d[d.length - 1]) < 0.05) return;
    editor.draft = [...d, p];
  }
  /** Finish the outline being drawn. Returns false when there's nothing to close. */
  export function closeShape(): boolean {
    const d = editor.draft;
    if (d.length < 3) { if (d.length) onError?.('Add at least 3 corners first'); return false; }
    if (editor.tool === 'site') {
      const err = editor.replaceLot(d);
      if (err) { onError?.(err); return false; }
      editor.drawingLot = false;
      editor.draft = [];
      onLotDrawn?.();
    } else if (editor.tool === 'footprint') {
      const err = editor.replaceFootprint(d);
      if (err) { onError?.(err); return false; }
      editor.draft = [];
      onFootprintDrawn?.();
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
    scale = Math.max(2, Math.min(400, scale * f));
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
  // 1 m grid (the snapping grid) when it is big enough to see, with a 5 m grid over it
  const minorStep = $derived(scale >= 9 ? 1 : 5);
  const majorStep = $derived(scale >= 9 ? 5 : 25);
  const roads = $derived(lot ? site.roadShapes(lot) : []);
  const entrance = $derived(lot ? site.entrancePoint(lot) : null);
  const draftPts = $derived(hover && outlining ? [...editor.draft, hover] : editor.draft);
  const lotLabelAt = $derived(lot?.boundary ? [...lot.boundary].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0] : null);
  const draftColor = $derived(editor.tool === 'site' ? '#5E7A4E' : editor.tool === 'footprint' ? '#2F5D7C' : '#A4502F');
  const roomsByArea = $derived([...floor.rooms].sort((a, b) => b.area - a.area));

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
  const fmtLen = (v: number) => (Math.abs(v - Math.round(v)) < 0.005 ? `${Math.round(v)} m` : `${v.toFixed(2)} m`);
</script>

<div bind:this={el} class="absolute inset-0 touch-none select-none overflow-hidden bg-[#FBFAF7] {editor.mode === 'comment' ? 'cursor-crosshair' : editor.tool === 'select' || ((siteTool || fpTool) && !outlining) ? 'cursor-default' : 'cursor-crosshair'}"
  role="application" aria-label="Plan canvas. Use the toolbar to choose a tool."
  {onpointerdown} {onpointermove} {onpointerup} onpointercancel={onpointerup} {onwheel}
  oncontextmenu={(e) => e.preventDefault()} onpointerleave={() => (hover = null)}>
  <svg width={W} height={H} viewBox={vb} class="block">
    <defs>
      <pattern id="grid-minor" width={minorStep} height={minorStep} patternUnits="userSpaceOnUse">
        <path d={`M ${minorStep} 0 L 0 0 0 ${minorStep}`} fill="none" stroke="#E7E3DB" stroke-width={1 / scale} />
      </pattern>
      <pattern id="grid-major" width={majorStep} height={majorStep} patternUnits="userSpaceOnUse">
        <path d={`M ${majorStep} 0 L 0 0 0 ${majorStep}`} fill="none" stroke="#D9D3C7" stroke-width={1.3 / scale} />
      </pattern>
      <pattern id="hatch-below" width="0.6" height="0.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="0.6" height="0.6" fill="#E8E4DC" />
        <line x1="0" y1="0" x2="0" y2="0.6" stroke="#CFC8BB" stroke-width="0.12" />
      </pattern>
    </defs>
    {#if map}
      <MapTiles geo={map} rotation={map.rotation} {view} {scale} opacity={mapOpacity} />
    {/if}
    <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill="url(#grid-minor)" opacity={map ? 0.55 : 1} />
    <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill="url(#grid-major)" opacity={map ? 0.55 : 1} />

    <!-- roads along the lot -->
    {#each roads as r (r.edge)}
      {@const sel = siteTool && editor.siteSelection?.kind === 'lot-edge' && editor.siteSelection.i === r.edge}
      <polygon points={pts(r.asphalt)} fill={sel ? '#A9A39B' : '#C4C1BB'} fill-opacity={map ? 0.55 : 1} />
      <polygon points={pts(r.verge)} fill="#E6E2DA" fill-opacity={map ? 0.55 : 1} />
      <line x1={r.centre[0][0]} y1={r.centre[0][1]} x2={r.centre[1][0]} y2={r.centre[1][1]} stroke="#FFFFFF" stroke-width={Math.max(0.08, 1.5 / scale)} stroke-dasharray="1.5 1.5" />
      {#if r.width * scale > 18}
        <text x={r.label[0]} y={r.label[1]} transform={`rotate(${r.labelAngle} ${r.label[0]} ${r.label[1]})`} dy={fs * 0.35} font-size={Math.min(fs, r.width * 0.3)} text-anchor="middle" font-weight="600" fill="#4A5055" letter-spacing="0.08em" style="pointer-events:none">{r.name.toUpperCase()}</text>
      {/if}
    {/each}

    {#if lot?.boundary}
      <polygon points={pts(lot.boundary)} fill="#EEF2E8" fill-opacity={map ? (siteTool ? 0.35 : 0.2) : siteTool ? 0.9 : 0.6} stroke="#5E7A4E" stroke-dasharray={`${6 / scale} ${4 / scale}`} stroke-width={(siteTool ? 2.5 : 1.5) / scale} />
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
            <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.8} text-anchor="middle" fill={sel ? '#A4502F' : '#3E5A30'} font-weight="600" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale} style="pointer-events:none">{fmtLen(tag.len)} · {site.edgeFacing(lot, i, true)}</text>
          {/if}
        {/each}
      {/if}
    {/if}

    <!-- the floors below this one, as silhouettes -->
    {#each editor.plan.floors.slice(0, editor.floorIdx) as f, i (f.level)}
      {#if f.footprint}
        {@const last = i === editor.floorIdx - 1}
        <polygon points={pts(f.footprint)} fill={last ? 'url(#hatch-below)' : '#EFECE6'} fill-opacity={last ? 0.95 : 0.6} stroke="#9C9384" stroke-width={(last ? 1.6 : 1) / scale} stroke-dasharray={last ? 'none' : `${4 / scale} ${3 / scale}`} />
        {#if last && !footprint}
          {@const c = polygonCentroid(f.footprint)}
          <text x={c[0]} y={c[1]} font-size={fs} text-anchor="middle" fill="#6B6458" font-weight="600" style="pointer-events:none">{floorLabel(f.level)} below</text>
        {/if}
      {/if}
    {/each}

    <!-- this floor's footprint -->
    {#if footprint}
      {@const bare = !floor.walls.length}
      <polygon points={pts(footprint)} fill={bare ? '#FFFFFF' : 'none'} fill-opacity={bare ? 0.92 : 0} stroke="#2F5D7C" stroke-width={(fpTool ? 2.5 : bare ? 2 : 1) / scale} stroke-dasharray={fpTool || bare ? 'none' : `${5 / scale} ${4 / scale}`} />
      {#if bare && !editor.drawingFootprint}
        {@const c = polygonCentroid(footprint)}
        <text x={c[0]} y={c[1]} font-size={fs} text-anchor="middle" fill="#2F5D7C" font-weight="700" style="pointer-events:none">{floorLabel(floor.level)}</text>
        <text x={c[0]} y={c[1] + fs * 1.3} font-size={fs * 0.85} text-anchor="middle" fill="#2F5D7C" style="pointer-events:none">{polygonArea(footprint).toFixed(0)} m²</text>
      {/if}
      {#if fpTool && !editor.drawingFootprint}
        {#each footprint as p, i}
          {@const q = footprint[(i + 1) % footprint.length]}
          {@const tag = edgeTag(p, q, site.signedAreaSign(footprint) * -1.1 * fs)}
          {@const sel = editor.siteSelection?.kind === 'fp-edge' && editor.siteSelection.i === i}
          {#if sel}<line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#A4502F" stroke-width={4 / scale} />{/if}
          {#if tag.len * scale > 40}
            <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.8} text-anchor="middle" fill={sel ? '#A4502F' : '#2F5D7C'} font-weight="600" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale} style="pointer-events:none">{fmtLen(tag.len)}</text>
          {/if}
        {/each}
      {/if}
    {/if}

    {#each roomsByArea as r (r.id)}
      <polygon points={pts(r.polygon)} fill={ROOM_COLORS[r.type] ?? '#eee'} fill-opacity={siteTool || fpTool ? 0.55 : 1}
        stroke={editor.selection?.id === r.id ? '#A4502F' : 'none'} stroke-width={editor.selection?.id === r.id ? 3 / scale : 0} />
    {/each}
    {#each floor.walls as w (w.id)}
      <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={editor.selection?.id === w.id ? '#A4502F' : '#1F2326'} stroke-opacity={siteTool || fpTool ? 0.5 : 1} stroke-width={w.thickness} stroke-linecap="square" />
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
      {@const col = draftColor}
      {#if draftPts.length >= 3}<polygon points={pts(draftPts)} fill={col} fill-opacity="0.12" stroke="none" />{/if}
      <polyline points={pts(draftPts)} fill="none" stroke={col} stroke-width={editor.tool === 'room' ? editor.newWallThickness : 2.5 / scale} stroke-opacity="0.8" stroke-linejoin="round" />
      {#if draftPts.length >= 3}
        {@const last = draftPts[draftPts.length - 1]}
        <line x1={last[0]} y1={last[1]} x2={draftPts[0][0]} y2={draftPts[0][1]} stroke={col} stroke-width={1.5 / scale} stroke-dasharray={`${5 / scale} ${4 / scale}`} />
        {@const c = polygonCentroid(draftPts)}
        <text x={c[0]} y={c[1]} font-size={fs} text-anchor="middle" fill={col} font-weight="700" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale}>{polygonArea(draftPts).toFixed(1)} m²</text>
      {/if}
      {#each draftPts.slice(1) as p, i}
        {@const tag = edgeTag(draftPts[i], p, -0.9 * fs)}
        {#if tag.len * scale > 40}
          <text x={tag.x} y={tag.y} transform={`rotate(${tag.ang} ${tag.x} ${tag.y})`} dy={fs * 0.35} font-size={fs * 0.8} text-anchor="middle" fill={col} font-weight="600" paint-order="stroke" stroke="#FBFAF7" stroke-width={3 / scale}>{fmtLen(tag.len)}</text>
        {/if}
      {/each}
      {#each editor.draft as p, i}
        <circle cx={p[0]} cy={p[1]} r={(i === 0 && editor.draft.length >= 3 ? 8 : 5) / scale} fill={i === 0 ? '#fff' : col} stroke={col} stroke-width={2 / scale} />
      {/each}
    {/if}

    {#each wallChain as p}<circle cx={p[0]} cy={p[1]} r={5 / scale} fill="#A4502F" />{/each}
    {#if hover}<circle cx={hover[0]} cy={hover[1]} r={5 / scale} fill="none" stroke={outlining ? draftColor : '#A4502F'} stroke-width={2 / scale} />{/if}
    {#if pressing}<circle cx={pressing[0]} cy={pressing[1]} r={22 / scale} fill="#A4502F22" stroke="#A4502F" stroke-width={2 / scale}><animate attributeName="r" from={8 / scale} to={26 / scale} dur="0.45s" fill="freeze" /></circle>{/if}

    <!-- drag handles -->
    {#each handles as h}
      {@const selV = (h.kind === 'vertex' && editor.selection?.kind === 'vertex' && dist(editor.selection.point, h.point) < 0.02) || ((h.kind === 'lot-vertex' || h.kind === 'fp-vertex') && editor.siteSelection?.kind === h.kind && editor.siteSelection.i === h.i)}
      {@const col = h.kind.startsWith('lot') ? '#5E7A4E' : h.kind.startsWith('fp') ? '#2F5D7C' : '#A4502F'}
      {#if h.kind === 'vertex' || h.kind === 'lot-vertex' || h.kind === 'fp-vertex'}
        <circle cx={h.point[0]} cy={h.point[1]} r={(selV ? 8 : 6.5) / scale} fill={selV ? '#A4502F' : '#fff'} stroke={col} stroke-width={2.5 / scale} />
      {:else if h.kind === 'mid' || h.kind === 'lot-mid' || h.kind === 'fp-mid'}
        {@const r = 6 / scale}
        <g opacity="0.85">
          <circle cx={h.point[0]} cy={h.point[1]} r={r} fill="#fff" stroke={col} stroke-width={1.5 / scale} stroke-dasharray={`${2 / scale} ${1.5 / scale}`} />
          <path d={`M${h.point[0] - r * 0.55} ${h.point[1]} h${r * 1.1} M${h.point[0]} ${h.point[1] - r * 0.55} v${r * 1.1}`} stroke={col} stroke-width={1.5 / scale} />
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
  {#if map}
    <a class="absolute right-1 bottom-1 text-[10px] bg-white/85 px-1.5 py-0.5 rounded text-ink-2 pointer-events-auto" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" onpointerdown={(e) => e.stopPropagation()}>{ATTRIBUTION}</a>
  {/if}
</div>
