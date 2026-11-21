<script lang="ts">
  import { onMount } from 'svelte';
  import type { PlanSpec } from '@shared/planspec/schema';
  import { planToModel } from '../engine/plan3d';
  import { ViewerEngine, isMobileDevice } from '@features/viewer/engine/ViewerEngine';

  let { plan }: { plan: PlanSpec } = $props();
  let canvas: HTMLCanvasElement;
  let error = $state('');
  let engine: ViewerEngine | null = null;
  let hour = $state(15);

  onMount(() => {
    try {
      const model = planToModel($state.snapshot(plan) as PlanSpec, { roof: false });
      if (!model.elements.length) { error = 'Draw some walls first — then come back to see them in 3D.'; return; }
      engine = new ViewerEngine(canvas, model, isMobileDevice() ? 'low' : 'medium');
      engine.setMode('orbit');
      engine.orbitCam.beta = 0.85;
      engine.orbitCam.radius = engine.size * 1.3;
      // show doors open so rooms read clearly from above
      engine.setAllOpen(true, ['door'], false);
    } catch (e) {
      error = '3D preview needs WebGL, which this device doesn’t support.';
      console.error(e);
    }
    return () => engine?.dispose();
  });
</script>

<canvas bind:this={canvas} class="absolute inset-0 w-full h-full touch-none outline-none" aria-label="3D preview of your plan"></canvas>
{#if error}
  <div class="absolute inset-0 grid place-items-center bg-paper p-6 text-center text-ink-2">{error}</div>
{:else}
  <label class="absolute left-3 bottom-3 card px-3 py-2 flex items-center gap-2 text-xs shadow-sm">☀️
    <input type="range" min="6" max="20" step="0.25" bind:value={hour} oninput={() => engine?.setTimeOfDay(hour)} class="accent-[#A4502F] w-32" aria-label="Time of day" />
  </label>
{/if}
