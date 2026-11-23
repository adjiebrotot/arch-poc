<script lang="ts">
  import { untrack } from 'svelte';
  /**
   * Step 3 (Start from a template): choose a programme. Templates are briefs, not buildings: the
   * floors the client drew stay exactly as they are and the rooms are generated inside them.
   */
  import { floorLabel } from '@shared/planspec/schema';
  import { footprintArea } from '@shared/planspec/envelope';
  import type { Editor } from '../workspace/editor.svelte';
  import { layoutOptions, extraOptions, checkFeasibility, nearestFeasible, envelopeOf, describe } from '../generator/feasibility';
  import { TEMPLATES, fitTemplate } from '../generator/templates';
  import type { Brief } from '../generator/generator';
  import EnvelopeThumb from './EnvelopeThumb.svelte';

  let { editor, onback, ongenerate }: { editor: Editor; onback: () => void; ongenerate: (b: Brief) => void } = $props();

  const env = $derived(envelopeOf(editor.plan));
  const req = untrack(() => editor.plan.requirements);
  let picked = $state<string | null>(null);
  let bedrooms = $state(req?.bedrooms ?? 3);
  let bathrooms = $state(req?.bathrooms ?? 2);
  let extras = $state<string[]>(req?.extras ?? ['laundry']);

  const fits = $derived(TEMPLATES.map((t) => ({ t, fit: fitTemplate(t, env) })));
  const layouts = $derived(layoutOptions(env.area, env.floors, extras, env.plates));
  const extraOpts = $derived(extraOptions(env.area, env.floors, bedrooms, bathrooms, extras, env.plates));
  const current = $derived(checkFeasibility({ ...env, bedrooms, bathrooms, extras }));
  const near = $derived(current.ok ? null : nearestFeasible({ ...env, bedrooms, bathrooms, extras }));

  function choose(id: string) {
    const f = fits.find((x) => x.t.id === id)!;
    picked = id;
    bedrooms = f.fit.brief.bedrooms;
    bathrooms = f.fit.brief.bathrooms;
    extras = [...f.fit.brief.extras];
  }
  function toggle(id: string) { picked = null; extras = extras.includes(id) ? extras.filter((e) => e !== id) : [...extras, id]; }
  function generate() {
    editor.pushHistory();
    editor.plan.requirements = { area: env.area, floors: env.floors, bedrooms, bathrooms, extras: [...extras], notes: editor.plan.requirements?.notes ?? '' };
    editor.onChange?.();
    ongenerate({ bedrooms, bathrooms, extras: [...extras] });
  }
  const rooms = $derived(extraOpts.filter((e) => e.kind === 'room'));
  const prefs = $derived(extraOpts.filter((e) => e.kind === 'pref'));
</script>

<div class="h-full overflow-y-auto">
  <div class="max-w-4xl mx-auto px-4 py-6 md:py-10 grid gap-6">
    <div class="grid md:grid-cols-[1fr_220px] gap-5 items-start">
      <div class="grid gap-2">
        <p class="eyebrow">Step 3 · Template</p>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">What should go inside?</h1>
        <p class="text-ink-2">Pick a starting point. Your lot and floors stay exactly as you drew them: we arrange the rooms, hallways and stairs to fit inside them.</p>
        <div class="flex flex-wrap gap-2 mt-1 text-sm">
          {#each editor.plan.floors as f}<span class="chip">{floorLabel(f.level)} · {footprintArea(f.footprint).toFixed(0)} m²</span>{/each}
          <span class="chip on">{env.area} m² in all</span>
        </div>
      </div>
      <div class="card p-2"><EnvelopeThumb plan={editor.plan} /></div>
    </div>

    <section aria-labelledby="tpl-h" class="grid gap-3">
      <h2 id="tpl-h" class="font-semibold text-lg">Templates</h2>
      <div class="grid sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Templates">
        {#each fits as { t, fit }}
          <button class="card p-4 text-left grid gap-1.5 {picked === t.id ? 'outline outline-3 outline-accent border-accent' : 'hover:border-ink'} disabled:opacity-50" role="radio" aria-checked={picked === t.id} disabled={!fit.ok} onclick={() => choose(t.id)}>
            <div class="flex items-center gap-2"><span class="font-semibold flex-1">{t.title}</span>
              {#if !fit.ok}<span class="badge">Doesn't fit</span>{:else if fit.adapted}<span class="badge badge-poc">Adapted</span>{:else}<span class="badge">Fits</span>{/if}
            </div>
            <span class="text-sm text-ink-2">{t.blurb}</span>
            {#if fit.adapted}<span class="text-xs text-muted">Adapted to your floors: {describe({ ...fit.brief, floors: env.floors })} ({fit.reason?.replace('+', '')} as designed)</span>{/if}
            {#if !fit.ok}<span class="text-xs text-muted">{fit.reason}</span>{/if}
          </button>
        {/each}
      </div>
    </section>

    <section class="card p-5 grid gap-5" aria-labelledby="tune-h">
      <h2 id="tune-h" class="font-semibold text-lg">Fine-tune</h2>
      <div class="field">
        <span id="lay-l">Bedrooms and bathrooms</span>
        <p class="text-sm text-muted -mt-1">Options that don't fit in your {env.area} m² are greyed out with the reason.</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-labelledby="lay-l">
          {#each layouts as l}
            <button class="chip flex-col !items-start !py-2 !rounded-2xl h-auto" role="radio" aria-checked={bedrooms === l.bedrooms && bathrooms === l.bathrooms}
              class:on={bedrooms === l.bedrooms && bathrooms === l.bathrooms} disabled={!l.enabled}
              onclick={() => { picked = null; bedrooms = l.bedrooms; bathrooms = l.bathrooms; }}>
              <span class="font-semibold">{l.label}</span>
              {#if !l.enabled}<span class="text-[11px] font-normal">{l.reason}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <span>Extra rooms</span>
        <div class="flex flex-wrap gap-2">
          {#each rooms as e}
            <button class="chip" aria-pressed={e.selected} disabled={!e.enabled} onclick={() => toggle(e.id)} title={e.reason}>
              <span aria-hidden="true">{e.icon}</span> {e.label}{#if !e.enabled}<span class="text-[11px] font-normal">· {e.reason}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <span>Preferences</span>
        <div class="flex flex-wrap gap-2">
          {#each prefs as e}
            <button class="chip" aria-pressed={e.selected} onclick={() => toggle(e.id)}><span aria-hidden="true">{e.icon}</span> {e.label}</button>
          {/each}
        </div>
      </div>
      {#if near}
        <p class="text-sm text-warn" role="status">{current.reason}. {near.message}</p>
      {/if}
    </section>

    <div class="flex justify-between gap-2 sticky bottom-3">
      <button class="btn btn-ghost bg-paper" onclick={onback}>← Floors</button>
      <button class="btn btn-accent" disabled={!current.ok} onclick={generate}>Generate layouts →</button>
    </div>
  </div>
</div>
