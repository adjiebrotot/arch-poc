<script lang="ts">
  let { onmove }: { onmove: (x: number, y: number) => void } = $props();
  let knob = $state({ x: 0, y: 0 });
  let base: HTMLDivElement;
  let id: number | null = null;
  const R = 48;
  function update(e: PointerEvent) {
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
    knob = { x: dx, y: dy };
    onmove(dx / R, -dy / R);
  }
</script>
<div bind:this={base} class="w-32 h-32 rounded-full bg-white/25 border border-white/60 backdrop-blur-sm touch-none relative shadow-lg"
  role="slider" aria-label="Move joystick" aria-valuenow={0} tabindex="-1"
  onpointerdown={(e) => { id = e.pointerId; try { base.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } update(e); e.stopPropagation(); }}
  onpointermove={(e) => { if (e.pointerId === id) update(e); }}
  onpointerup={(e) => { if (e.pointerId === id) { id = null; knob = { x: 0, y: 0 }; onmove(0, 0); } }}
  onpointercancel={() => { id = null; knob = { x: 0, y: 0 }; onmove(0, 0); }}>
  <div class="absolute w-14 h-14 rounded-full bg-white/90 shadow left-1/2 top-1/2 -ml-7 -mt-7" style="transform: translate({knob.x}px, {knob.y}px)"></div>
</div>
