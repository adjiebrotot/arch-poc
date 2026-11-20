<script lang="ts">
  import { href } from '@shared/router';
  import { layoutOptions, extraOptions, checkFeasibility, FEASIBILITY } from './generator/feasibility';
  import { generateVariants } from './generator/generator';
  import { TEMPLATES, templatePlan } from './generator/templates';
  import { savePlanAndOpen } from './planStore';
  import PlanThumb from './PlanThumb.svelte';
  import type { PlanSpec } from '@shared/planspec/schema';

  let step = $state(1);
  let area = $state(120);
  let floors = $state(1);
  let bedrooms = $state(3);
  let bathrooms = $state(2);
  let extras = $state<string[]>(['laundry']);
  let variants = $state<PlanSpec[]>([]);
  let chosen = $state(0);
  let batch = $state(1);

  const layouts = $derived(layoutOptions(area, floors, extras));
  const extraOpts = $derived(extraOptions(area, floors, bedrooms, bathrooms, extras));
  const current = $derived(checkFeasibility({ area, floors, bedrooms, bathrooms, extras }));

  // If the current choice stops fitting (e.g. area reduced), fall back to the biggest layout that fits.
  $effect(() => {
    if (!current.ok) {
      const ok = layouts.filter((l) => l.enabled);
      if (ok.length) {
        const best = ok[ok.length - 1];
        bedrooms = best.bedrooms; bathrooms = best.bathrooms;
      }
    }
  });

  function toggleExtra(id: string) {
    extras = extras.includes(id) ? extras.filter((e) => e !== id) : [...extras, id];
  }

  function generate() {
    variants = generateVariants({ area, floors, bedrooms, bathrooms, extras }, 4, batch * 10);
    chosen = 0;
    step = 3;
  }
  function more() { batch++; generate(); }
  const plateWarning = $derived(area / floors < FEASIBILITY.minFloorPlate);
</script>

<div class="pt-6 md:pt-10 max-w-4xl">
  <a href={href('/design')} class="text-sm text-muted hover:text-ink">← All options</a>
  <h1 class="text-3xl md:text-4xl font-semibold tracking-tight mt-2">Start from a template</h1>

  <ol class="flex gap-2 mt-5 text-sm" aria-label="Steps">
    {#each ['Size', 'Rooms', 'Pick a layout'] as s, i}
      <li class="flex-1">
        <button class="w-full text-left" onclick={() => { if (i + 1 < step || (i === 2 && variants.length)) step = i + 1; }} aria-current={step === i + 1 ? 'step' : undefined}>
          <div class="h-1.5 rounded-full {step >= i + 1 ? 'bg-accent' : 'bg-line'}"></div>
          <div class="mt-1.5 {step === i + 1 ? 'font-semibold' : 'text-muted'}">{i + 1}. {s}</div>
        </button>
      </li>
    {/each}
  </ol>

  {#if step === 1}
    <section class="card p-5 md:p-7 mt-5 grid gap-6">
      <label class="field">
        <span>Total floor area: <strong class="text-ink">{area} m²</strong></span>
        <input type="range" min={FEASIBILITY.ranges.area.min} max="320" step="5" bind:value={area} class="w-full accent-[#A4502F] h-11" aria-describedby="area-help" />
        <small id="area-help" class="text-muted">About the size of {area < 70 ? 'a cosy apartment' : area < 130 ? 'a typical family home' : area < 200 ? 'a generous family home' : 'a large home'}. Includes walls and hallways.</small>
      </label>
      <div class="field">
        <span id="floors-l">Number of floors</span>
        <div class="flex gap-2" role="radiogroup" aria-labelledby="floors-l">
          {#each [1, 2, 3] as n}
            <button class="chip flex-1 justify-center" role="radio" aria-checked={floors === n} class:on={floors === n} onclick={() => (floors = n)}>{n === 1 ? 'Single level' : `${n} storeys`}</button>
          {/each}
        </div>
        {#if plateWarning}<small class="text-warn">Each floor would be very small — fewer floors will work better.</small>{/if}
      </div>
      <button class="btn btn-primary justify-self-end" onclick={() => (step = 2)} disabled={plateWarning}>Next: rooms →</button>
    </section>

    <section class="mt-10" aria-labelledby="tpl-h">
      <h2 id="tpl-h" class="font-semibold text-lg">Or jump straight in with a ready-made home</h2>
      <div class="grid sm:grid-cols-3 gap-4 mt-4">
        {#each TEMPLATES as t}
          {@const p = templatePlan(t.id)}
          <button class="card p-3 text-left grid gap-2 hover:border-ink" onclick={() => savePlanAndOpen(p)}>
            <PlanThumb plan={p} labels={false} />
            <div class="px-1"><div class="font-semibold">{t.title}</div><div class="text-xs text-muted">{t.area} m² · {t.bedrooms} bed {t.bathrooms} bath · {t.blurb}</div></div>
          </button>
        {/each}
      </div>
    </section>
  {:else if step === 2}
    <section class="card p-5 md:p-7 mt-5 grid gap-6">
      <div class="field">
        <span id="lay-l">Layout</span>
        <p class="text-sm text-muted -mt-1">Options that don't fit in {area} m² over {floors} floor{floors > 1 ? 's' : ''} are greyed out with the reason.</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-labelledby="lay-l">
          {#each layouts as l}
            <button class="chip flex-col !items-start !py-2 !rounded-2xl h-auto" role="radio" aria-checked={bedrooms === l.bedrooms && bathrooms === l.bathrooms}
              class:on={bedrooms === l.bedrooms && bathrooms === l.bathrooms} disabled={!l.enabled}
              onclick={() => { bedrooms = l.bedrooms; bathrooms = l.bathrooms; }}
              aria-describedby={l.enabled ? undefined : `why-${l.id}`}>
              <span class="font-semibold">{l.label}</span>
              {#if !l.enabled}<span id="why-{l.id}" class="text-[11px] font-normal">{l.reason}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <span>Extras (optional)</span>
        <div class="flex flex-wrap gap-2">
          {#each extraOpts as e}
            <button class="chip" aria-pressed={e.selected} disabled={!e.enabled} onclick={() => toggleExtra(e.id)} title={e.reason}>
              <span aria-hidden="true">{e.icon}</span> {e.label}{#if !e.enabled}<span class="text-[11px] font-normal">· {e.reason}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="flex justify-between gap-2">
        <button class="btn btn-ghost" onclick={() => (step = 1)}>← Back</button>
        <button class="btn btn-accent" onclick={generate} disabled={!current.ok}>Show me layouts →</button>
      </div>
    </section>
  {:else}
    <section class="mt-5 grid gap-4">
      <p class="text-ink-2">Here are {variants.length} layouts for <strong>{bedrooms} bed {bathrooms} bath, {area} m²</strong>. Tap one, then open it in the editor.</p>
      <div class="grid sm:grid-cols-2 gap-4" role="radiogroup" aria-label="Layout variants">
        {#each variants as v, i}
          <button class="card p-3 text-left grid gap-2 {chosen === i ? 'outline outline-3 outline-accent border-accent' : 'hover:border-ink'}" role="radio" aria-checked={chosen === i} onclick={() => (chosen = i)}>
            <PlanThumb plan={v} />
            <div class="px-1 text-sm flex justify-between"><span class="font-semibold">Variant {String.fromCharCode(65 + i)}</span><span class="text-muted">seed {v.meta.seed}</span></div>
          </button>
        {/each}
      </div>
      <div class="flex justify-between gap-2 sticky bottom-3">
        <button class="btn btn-ghost bg-paper" onclick={more}>↻ More options</button>
        <button class="btn btn-accent" onclick={() => savePlanAndOpen({ ...variants[chosen], meta: { ...variants[chosen].meta, title: `My ${bedrooms}-bedroom home` } })}>Open in editor →</button>
      </div>
    </section>
  {/if}
</div>
