<script lang="ts">
  import type { PlanSpec } from '@shared/planspec/schema';
  import { floorToSvg } from './engine/planSvg';
  let { plan, labels = true }: { plan: PlanSpec; labels?: boolean } = $props();
</script>
<div class="grid gap-2 {plan.floors.length > 1 ? 'grid-cols-2' : ''}" aria-hidden="true">
  {#each plan.floors as f}
    <div class="relative">
      {@html floorToSvg(f, { labels })}
      {#if plan.floors.length > 1}<span class="absolute top-1 left-1 badge">{f.level === 0 ? 'Ground' : `Level ${f.level + 1}`}</span>{/if}
    </div>
  {/each}
</div>
<style>
  div :global(svg) { width: 100%; height: auto; display: block; border-radius: 12px; }
</style>
