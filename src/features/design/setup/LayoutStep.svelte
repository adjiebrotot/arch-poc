<script lang="ts">
  /**
   * Last setup step (Template / Tell us): generated layouts inside the client's floors; pick one.
   * Only layouts that meet every hard design rule are offered (generator/rules.ts). When none can,
   * the step says why and offers the closest briefs that do fit, each checked by generating it.
   */
  import { onMount, untrack } from 'svelte';
  import type { PlanSpec } from '@shared/planspec/schema';
  import type { Editor } from '../workspace/editor.svelte';
  import { generateLayouts, suggestBriefs, envelopeOfPlan, applyLayout, type Brief, type Layouts, type BriefSuggestion } from '../generator/generator';
  import { describe, envelopeOf } from '../generator/feasibility';
  import PlanThumb from '../PlanThumb.svelte';
  import DesignCheck from '../DesignCheck.svelte';

  let { editor, brief, onback, onopen, onbrief }: {
    editor: Editor;
    brief: Brief & { style?: string; notes?: string };
    onback: () => void;
    onopen: (p: PlanSpec) => void;
    /** switch to another brief (a suggestion that fits) */
    onbrief?: (b: Brief) => void;
  } = $props();

  let result = $state<Layouts | null>(null);
  let chosen = $state(0);
  let busy = $state(true);
  let error = $state('');
  let batch = $state(0);
  let suggestions = $state<BriefSuggestion[] | null>(null);
  const env = untrack(() => envelopeOf(editor.plan));
  const variants = $derived(result?.plans ?? []);
  const reports = $derived(result?.reports ?? []);
  const blockers = $derived(result?.closest ? result.closest.report.results.filter((r) => r.severity === 'hard' && !r.ok) : []);

  function input() {
    const plan = $state.snapshot(editor.plan) as PlanSpec;
    return { envelope: envelopeOfPlan(plan), ...brief, mode: plan.meta.mode, title: plan.meta.title };
  }

  function run() {
    busy = true;
    error = '';
    suggestions = null;
    // let the spinner paint before the (synchronous) generator runs
    setTimeout(() => {
      try {
        result = generateLayouts(input(), 4, 1 + batch * 32, 16);
        chosen = 0;
      } catch (e) {
        error = e instanceof Error ? e.message : 'No layout fits these floors.';
        result = null;
      }
      busy = false;
      if (result && !result.plans.length) setTimeout(() => { suggestions = suggestBriefs(input(), 3); }, 40);
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
      <p class="text-ink-2">Every layout fills exactly the floors you drew ({env.area} m²) and meets every design rule: room shapes and sizes, sensible proportions, and rooms placed for privacy, security and convenience. Pick one to open in the editor, where you can change anything.</p>
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
    {:else if !variants.length}
      <div class="card p-5 grid gap-3" role="status">
        <p class="font-semibold text-lg">No sound layout for {describe({ ...brief, floors: env.floors })} fits these floors</p>
        <p class="text-ink-2">We only offer layouts that meet every design rule, and none of the arrangements we tried could. The closest one still broke:</p>
        <ul class="grid gap-1 text-sm">
          {#each blockers.slice(0, 4) as r (r.id)}
            <li><span class="font-medium">{r.title}</span><span class="text-muted"> · {r.issues[0]?.message}{r.issues.length > 1 ? ` (and ${r.issues.length - 1} more)` : ''}</span></li>
          {/each}
        </ul>
        {#if suggestions === null}
          <p class="text-sm text-muted flex items-center gap-2" role="status"><span class="w-4 h-4 rounded-full border-2 border-line border-t-accent animate-spin"></span> Looking for the closest brief that fits…</p>
        {:else if suggestions.length}
          <div class="grid gap-2">
            <p class="font-semibold">These fit, with layouts that meet every rule:</p>
            <div class="grid sm:grid-cols-3 gap-2">
              {#each suggestions as sg}
                <button class="card p-3 text-left grid gap-1 hover:border-ink" onclick={() => onbrief?.(sg.brief)} disabled={!onbrief}>
                  <span class="font-semibold">{sg.label}</span>
                  <span class="text-sm text-muted">{sg.change}</span>
                </button>
              {/each}
            </div>
          </div>
        {:else}
          <p class="text-ink-2">No smaller brief fits either: make the floors bigger or simpler (fewer narrow parts), or add a floor.</p>
        {/if}
        <p class="text-sm text-muted">Or change the floors: more area, or a simpler outline, gives the rooms room to work.</p>
        <div class="flex gap-2 flex-wrap"><button class="btn btn-soft btn-sm" onclick={onback}>← Change the brief</button></div>
      </div>
    {:else}
      <div class="grid md:grid-cols-2 gap-4" role="radiogroup" aria-label="Layout variants">
        {#each variants as v, i}
          {@const rep = reports[i]}
          <button class="card p-3 text-left grid gap-2 {chosen === i ? 'outline outline-3 outline-accent border-accent' : 'hover:border-ink'}" role="radio" aria-checked={chosen === i} onclick={() => (chosen = i)} ondblclick={open}>
            <PlanThumb plan={v} />
            <div class="px-1 text-sm flex justify-between gap-2"><span class="font-semibold">Layout {String.fromCharCode(65 + i)}</span><span class="text-muted">{v.floors.reduce((s, f) => s + f.rooms.filter((r) => r.type !== 'hallway' && r.type !== 'stairs').length, 0)} rooms</span></div>
            {#if rep}
              <div class="px-1 text-xs font-semibold text-ok">✓ All design rules met{rep.soft ? ` · ${rep.soft} suggestion${rep.soft === 1 ? '' : 's'}` : ''}</div>
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
