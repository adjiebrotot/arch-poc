<script lang="ts">
  /** Small drawing of the envelope: the lot with each floor's footprint (upper floors darker). */
  import type { PlanSpec } from '@shared/planspec/schema';
  import { bounds } from '@shared/planspec/site';
  import type { Vec2 } from '@shared/util/geometry';

  let { plan }: { plan: PlanSpec } = $props();
  const pts = (p: Vec2[]) => p.map((q) => q.join(',')).join(' ');
  const box = $derived.by(() => {
    const all = [...(plan.site?.boundary ?? []), ...plan.floors.flatMap((f) => f.footprint ?? [])];
    const b = bounds(all.length ? all : [[0, 0], [10, 10]]);
    const pad = Math.max(b.w, b.h) * 0.06;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2, s: Math.max(b.w, b.h) };
  });
  const fills = ['#DCE7EF', '#B9CFDE', '#93B2C8'];
</script>

<svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} class="w-full h-auto block rounded-xl bg-[#FBFAF7]" role="img" aria-label="Your lot and floors">
  {#if plan.site?.boundary}
    <polygon points={pts(plan.site.boundary)} fill="#EEF2E8" stroke="#7F9A6E" stroke-width={box.s * 0.006} stroke-dasharray={`${box.s * 0.02} ${box.s * 0.012}`} />
  {/if}
  {#each plan.floors as f, i}
    {#if f.footprint}<polygon points={pts(f.footprint)} fill={fills[i] ?? fills[2]} stroke="#2F5D7C" stroke-width={box.s * 0.006} />{/if}
  {/each}
</svg>
