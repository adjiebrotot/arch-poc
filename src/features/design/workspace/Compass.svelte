<script lang="ts">
  /**
   * North arrow for the plan. Drag it round to set where north is; tap it to
   * open the lot & road settings.
   */
  let { northAngle, caption = '', onstart, onrotate, onopen }: {
    northAngle: number; caption?: string;
    onstart: () => void; onrotate: (deg: number) => void; onopen: () => void;
  } = $props();

  let el: HTMLButtonElement;
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let active = $state(false);

  function angleAt(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const a = (Math.atan2(dx, -dy) * 180) / Math.PI;
    return (Math.round(a / 5) * 5 + 360) % 360;
  }
  function down(e: PointerEvent) {
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }
  function move(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.moved) { drag.moved = true; active = true; onstart(); }
    onrotate(angleAt(e));
  }
  function up(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    const tap = !drag.moved;
    drag = null; active = false;
    if (tap) onopen();
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      onstart();
      onrotate((northAngle + (e.key === 'ArrowRight' ? step : -step) + 360) % 360);
    }
  }
</script>

<div class="flex flex-col items-center gap-1 select-none">
  <button bind:this={el} type="button"
    class="relative w-[68px] h-[68px] rounded-full bg-white/95 border border-line shadow-sm touch-none cursor-grab {active ? 'cursor-grabbing ring-2 ring-accent' : ''}"
    aria-label={`Compass: north is ${Math.round(northAngle)}° from the top of the plan. Drag to rotate, arrow keys to adjust, click for lot and road settings.`}
    title="Drag to set north · click for lot & road settings"
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={key}>
    <svg viewBox="-34 -34 68 68" class="absolute inset-0 w-full h-full" aria-hidden="true">
      <g transform={`rotate(${northAngle})`}>
        {#each Array(24) as _, i}
          <line x1="0" y1={i % 6 === 0 ? -30 : -31.5} x2="0" y2="-33" stroke="#B9B3A8" stroke-width={i % 6 === 0 ? 1.6 : 0.8} transform={`rotate(${i * 15})`} />
        {/each}
        <path d="M0 -24 L6 0 L0 3 L-6 0 Z" fill="#A4502F" />
        <path d="M0 24 L6 0 L0 -3 L-6 0 Z" fill="#CFC9BE" />
        <circle r="2.2" fill="#fff" stroke="#1F2326" stroke-width="1" />
        <text y="-25.5" font-size="8.5" font-weight="800" text-anchor="middle" fill="#A4502F" transform={`rotate(${-northAngle} 0 -28.5)`} dy="0">N</text>
        <text y="31" font-size="6" font-weight="700" text-anchor="middle" fill="#8A8F93" transform={`rotate(${-northAngle} 0 28.5)`}>S</text>
        <text x="29" y="2.2" font-size="6" font-weight="700" text-anchor="middle" fill="#8A8F93" transform={`rotate(${-northAngle} 28.5 0)`}>E</text>
        <text x="-29" y="2.2" font-size="6" font-weight="700" text-anchor="middle" fill="#8A8F93" transform={`rotate(${-northAngle} -28.5 0)`}>W</text>
      </g>
    </svg>
  </button>
  {#if active}
    <span class="rounded-full bg-ink text-white text-[11px] font-semibold px-2 py-0.5 tabular-nums">N {Math.round(northAngle)}°</span>
  {:else if caption}
    <span class="rounded-full bg-white/90 border border-line text-[11px] font-semibold text-ink-2 px-2 py-0.5 whitespace-nowrap">{caption}</span>
  {/if}
</div>
