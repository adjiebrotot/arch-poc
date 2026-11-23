<script lang="ts">
  import { href } from '@shared/router';
  import { storage } from '@shared/storage/localAdapter';
  import type { PlanRecord } from '@shared/storage/StorageAdapter';
  import { pickFile } from '@shared/util/download';
  import { BundleSchema, savePlanAndOpen, startPlan, planPath } from './planStore';
  import { mergeComments } from '@shared/comments/store';
  import { PlanSpecSchema } from '@shared/planspec/schema';
  import { toast } from '@shared/stores/session';

  let recent: PlanRecord[] = $state([]);
  let loading = $state(true);
  storage.listPlans().then((r) => { recent = r.slice(0, 6); loading = false; });

  async function importFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const b = BundleSchema.safeParse(data);
      if (b.success) {
        const n = mergeComments(b.data.comments);
        toast(`Imported plan and ${n} comment${n === 1 ? '' : 's'}`, 'success');
        // keep plan id so imported comments stay attached
        return savePlanAndOpen(b.data.plan);
      }
      const p = PlanSpecSchema.parse(data);
      await savePlanAndOpen(p);
    } catch {
      toast("That file isn't a plan we recognise", 'error');
    }
  }

  async function openExample() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/example-design-bundle.json`);
      const b = BundleSchema.parse(await res.json());
      mergeComments(b.comments);
      await savePlanAndOpen(b.plan);
    } catch {
      toast("Couldn't open the example", 'error');
    }
  }


  async function remove(id: string) {
    await storage.deletePlan(id);
    recent = recent.filter((r) => r.id !== id);
  }

  const modes = [
    { key: 'pro', icon: '✏️', title: 'Sketch it yourself', tag: 'Pro', desc: 'You draw everything: your lot, the ground-floor footprint, then the rooms. Add more floors as you go.', steps: ['Lot', 'Ground floor', 'Draw rooms'], action: () => startPlan('pro'), cta: 'Start sketching' },
    { key: 'creative', icon: '🧩', title: 'Start from a template', tag: 'Creative', desc: 'Draw your lot and the footprint of every floor, pick a template, and we arrange the rooms inside your footprints.', steps: ['Lot', 'All floors', 'Template', 'Pick a layout'], action: () => startPlan('creative'), cta: 'Choose a template' },
    { key: 'chat', icon: '💬', title: 'Just tell us', tag: 'Tell us', desc: 'Draw your lot and floors, then describe what you need in your own words. We generate rooms that fit inside them.', steps: ['Lot', 'All floors', 'Describe', 'Pick a layout'], action: () => startPlan('chat'), cta: 'Start chatting' },
  ];
</script>

<section class="pt-8 md:pt-14 pb-6 grid gap-3 max-w-2xl">
  <p class="eyebrow">Design it yourself</p>
  <h1 class="text-3xl md:text-5xl font-semibold tracking-tight">How would you like to start?</h1>
  <p class="text-ink-2 text-lg">Every option starts the same way: you draw your lot and the footprint of your house. Then you either draw the rooms yourself or let us arrange them inside your footprints. All end in the same editor, where you can change anything and leave notes for your architect.</p>
</section>

<div class="grid md:grid-cols-3 gap-4">
  {#each modes as m}
    <div class="card p-6 grid gap-3 content-start">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-2xl bg-paper-2 grid place-items-center text-2xl" aria-hidden="true">{m.icon}</div>
        <span class="badge">{m.tag}</span>
      </div>
      <h2 class="text-xl font-semibold">{m.title}</h2>
      <p class="text-ink-2 text-sm">{m.desc}</p>
      <ol class="flex flex-wrap gap-1 text-xs text-ink-2" aria-label="Steps">
        {#each m.steps as st, i}<li class="badge">{i + 1}. {st}</li>{/each}
      </ol>
      <button class="btn btn-primary justify-self-start mt-2" onclick={m.action}>{m.cta} →</button>
    </div>
  {/each}
</div>

<section class="mt-12" aria-labelledby="recent-h">
  <div class="flex items-center gap-3 flex-wrap">
    <h2 id="recent-h" class="text-lg font-semibold flex-1">Your plans on this device</h2>
    <button class="btn btn-ghost btn-sm" onclick={openExample}>Open example with comments</button>
    <button class="btn btn-ghost btn-sm" onclick={importFile}>Import plan (.json)</button>
  </div>
  {#if loading}
    <p class="text-muted mt-4" role="status">Loading…</p>
  {:else if recent.length === 0}
    <p class="text-muted mt-4">No plans yet — pick one of the options above to create your first.</p>
  {:else}
    <ul class="mt-4 grid sm:grid-cols-2 md:grid-cols-3 gap-3">
      {#each recent as r}
        <li class="card p-4 flex items-center gap-3">
          <a class="flex-1 min-w-0" href={href(planPath(r.id, r.stage))}>
            <div class="font-medium truncate">{r.title}</div>
            <div class="text-xs text-muted">{({ pro: 'Sketch', creative: 'Template', chat: 'Tell us' } as Record<string, string>)[r.mode] ?? r.mode}{r.stage && r.stage !== 'design' ? ` · setting up (${r.stage === 'lot' ? 'lot' : r.stage === 'floors' ? 'floors' : 'brief'})` : ''} · {new Date(r.updatedAt).toLocaleString()}</div>
          </a>
          <button class="btn btn-ghost btn-sm btn-icon" aria-label={`Delete ${r.title}`} onclick={() => remove(r.id)}>🗑</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
