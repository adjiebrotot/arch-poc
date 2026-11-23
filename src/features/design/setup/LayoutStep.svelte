<script lang="ts">
  /** Last setup step (Template / Tell us): generated layouts inside the client's floors; pick one. */
  import { onMount, untrack } from 'svelte';
  import type { PlanSpec } from '@shared/planspec/schema';
  import type { Editor } from '../workspace/editor.svelte';
  import { generateVariants, envelopeOfPlan, applyLayout, type Brief } from '../generator/generator';
  import { describe, envelopeOf } from '../generator/feasibility';
  import { checkPlan } from '../generator/rules';
  import PlanThumb from '../PlanThumb.svelte';
  import DesignCheck from '../DesignCheck.svelte';

  let { editor, brief, onback, onopen }: { editor: Editor; brief: Brief & { style?: string; notes?: string }; onback: () => void; onopen: (p: PlanSpec) => void } = $props();

  let variants = $state<PlanSpec[]>([]);
  let chosen = $state(0);
  let busy = $state(true);
  let error = $state('');
  let batch = $state(0);
  const env = untrack(() => envelopeOf(editor.plan));
  // every layout is judged against the design rules (generator/rules.ts)
  const reports = $derived(variants.map((v) => checkPlan(v)));
  const anyClean = $derived(reports.some((r) => r.hard === 0));

  function run() {
    busy = true;
    error = '';
    // let the spinner paint before the (synchronous) generator runs
    setTimeout(() => {
      try {
        const plan = $state.snapshot(editor.plan) as PlanSpec;
        variants = generateVariants({ envelope: envelopeOfPlan(plan), ...brief, mode: plan.meta.mode, title: plan.meta.title }, 4, 1 + batch * 24, 16);
        chosen = 0;
      } catch (e) {
        error = e instanceof Error ? e.message : 'No layout fits these floors.';
        variants = [];
      }
      busy = false;
    }, 40);
  }
  onMount(run);

  function more() { batch++; run(); }
  function open() {
    const v = variants[chosen];
    if (!v) return;
    onopen(applyLayout($state.snapshot(editor.plan) as PlanSpec, v));
  }
</script>

<div class="h-full overflow-y-auto">
  <div class="max-w-5xl mx-auto px-4 py-6 md:py-10 grid gap-4">
    <div class="grid gap-1">
      <p class="eyebrow">Step 4 · Pick a layout</p>
      <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Layouts for {describe({ ...brief, floors: env.floors })}</h1>
      <p class="text-ink-2">Every layout fills exactly the floors you drew ({env.area} m²): rooms, hallways and stairs are arranged inside them. Pick one to open in the editor, where you can change anything.</p>
    </div>
    {#if busy}
      <div class="card p-10 grid place-items-center text-muted" role="status">
        <div class="flex items-center gap-3"><span class="w-5 h-5 rounded-full border-2 border-line border-t-accent animate-spin"></span> Fitting rooms into your floors…</div>
      </div>
    {:else if error}
      <div class="card p-6 grid gap-3" role="alert">
        <p class="font-semibold">We couldn't fit a layout</p>
        <p class="text-ink-2">{error}</p>
        <div class="flex gap-2"><button class="btn btn-soft btn-sm" onclick={onback}>← Change the brief</button></div>
      </div>
    {:else}
      {#if !anyClean}
        <div class="card p-4 grid gap-2 border-[color:var(--color-warn)]" role="status">
          <p class="font-semibold text-warn">None of these layouts meets every design rule</p>
          <p class="text-ink-2">These floors are tight for {describe({ ...brief, floors: env.floors })}: the rooms can't all get their minimum size, shape and position at once. Each layout below says what it breaks. Try <b>More options</b>, a smaller brief (fewer bedrooms or extras), or bigger or simpler floor shapes.</p>
          <div class="flex gap-2 flex-wrap"><button class="btn btn-soft btn-sm" onclick={onback}>← Change the brief</button></div>
        </div>
      {/if}
      <div class="grid md:grid-cols-2 gap-4" role="radiogroup" aria-label="Layout variants">
        {#each variants as v, i}
          {@const rep = reports[i]}
          <button class="card p-3 text-left grid gap-2 {chosen === i ? 'outline outline-3 outline-accent border-accent' : 'hover:border-ink'}" role="radio" aria-checked={chosen === i} onclick={() => (chosen = i)} ondblclick={open}>
            <PlanThumb plan={v} />
            <div class="px-1 text-sm flex justify-between gap-2"><span class="font-semibold">Layout {String.fromCharCode(65 + i)}</span><span class="text-muted">{v.floors.reduce((s, f) => s + f.rooms.filter((r) => r.type !== 'hallway' && r.type !== 'stairs').length, 0)} rooms</span></div>
            {#if rep}
              <div class="px-1 text-xs font-semibold {rep.hard ? 'text-danger' : 'text-ok'}">
                {rep.hard ? `⚠ ${rep.results.filter((r) => r.severity === 'hard' && !r.ok).length} design rule${rep.results.filter((r) => r.severity === 'hard' && !r.ok).length === 1 ? '' : 's'} not met` : '✓ All design rules met'}{rep.soft ? ` · ${rep.soft} suggestion${rep.soft === 1 ? '' : 's'}` : ''}
              </div>
            {/if}
          </button>
        {/each}
      </div>
      {#if reports[chosen]}
        <section class="card p-4 grid gap-2" aria-label="Design check for the chosen layout">
          <h2 class="font-semibold">Design check · Layout {String.fromCharCode(65 + chosen)}</h2>
          <DesignCheck report={reports[chosen]} />
        </section>
      {/if}
    {/if}
    <div class="flex justify-between gap-2 sticky bottom-3">
      <button class="btn btn-ghost bg-paper" onclick={onback}>← Brief</button>
      <div class="flex gap-2">
        <button class="btn btn-ghost bg-paper" disabled={busy} onclick={more}>↻ More options</button>
        <button class="btn btn-accent" disabled={busy || !variants.length} onclick={open}>Open in editor →</button>
      </div>
    </div>
  </div>
</div>
