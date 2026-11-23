<script lang="ts">
  /**
   * The design workflow before the workspace. Every mode starts by defining the envelope:
   *
   *   Sketch it yourself   Lot → Ground floor → (workspace: draw rooms, add floors as you go)
   *   Start from a template Lot → All floors → Template → Pick a layout → (workspace)
   *   Just tell us          Lot → All floors → Describe → Pick a layout → (workspace)
   *
   * The lot and the footprints are the client's geometry; in Template and Tell us the rooms are
   * generated inside them afterwards.
   */
  import { route, href, navigate } from '@shared/router';
  import { storage } from '@shared/storage/localAdapter';
  import { toast } from '@shared/stores/session';
  import type { PlanSpec, Stage } from '@shared/planspec/schema';
  import { envelopeComplete } from '@shared/planspec/envelope';
  import StateBox from '@shared/ui/StateBox.svelte';
  import { Editor } from '../workspace/editor.svelte';
  import LotStep from './LotStep.svelte';
  import FloorsStep from './FloorsStep.svelte';
  import TemplateBrief from './TemplateBrief.svelte';
  import ChatBrief from './ChatBrief.svelte';
  import LayoutStep from './LayoutStep.svelte';
  import type { Brief } from '../generator/generator';

  let status = $state<'loading' | 'ready' | 'missing'>('loading');
  let editor = $state<Editor | null>(null);
  let planId = $state('');
  let saved = $state<'saved' | 'saving'>('saved');
  /** the brief the layouts were generated from (kept while the client picks one) */
  let brief = $state<(Brief & { style?: string; notes?: string }) | null>(null);

  async function load() {
    const id = $route.query.get('id');
    const plan = id ? await storage.getPlan(id) : null;
    if (!id || !plan) { status = 'missing'; return; }
    if (!plan.meta.stage || plan.meta.stage === 'design') { navigate(`/design/workspace?id=${id}`, { replace: true }); return; }
    planId = id;
    const ed = new Editor(plan);
    let timer: ReturnType<typeof setTimeout>;
    ed.onChange = () => {
      saved = 'saving';
      clearTimeout(timer);
      timer = setTimeout(async () => { await storage.savePlan(planId, $state.snapshot(ed.plan) as PlanSpec); saved = 'saved'; }, 300);
    };
    editor = ed;
    if (plan.requirements && (plan.meta.stage === 'layout')) {
      const r = plan.requirements;
      brief = { bedrooms: r.bedrooms, bathrooms: r.bathrooms, extras: r.extras, style: r.style, notes: r.notes };
    }
    status = 'ready';
  }
  load();

  const mode = $derived(editor?.plan.meta.mode ?? 'pro');
  const steps = $derived(
    mode === 'pro'
      ? [{ id: 'lot', label: 'Lot' }, { id: 'floors', label: 'Ground floor' }, { id: 'design', label: 'Rooms' }]
      : [{ id: 'lot', label: 'Lot' }, { id: 'floors', label: 'Floors' }, { id: 'brief', label: mode === 'creative' ? 'Template' : 'Describe' }, { id: 'layout', label: 'Pick a layout' }],
  );
  const stage = $derived((editor?.plan.meta.stage ?? 'lot') as Stage);
  const stageIdx = $derived(steps.findIndex((s) => s.id === stage));
  const hasLot = $derived(!!editor?.plan.site?.boundary);
  const envelopeDone = $derived(!!editor && envelopeComplete(editor.plan));

  function canGo(id: string): boolean {
    if (!editor) return false;
    if (id === 'lot') return true;
    if (id === 'floors') return hasLot;
    if (id === 'brief') return envelopeDone;
    if (id === 'layout') return envelopeDone && !!brief;
    if (id === 'design') return envelopeDone;
    return false;
  }

  function go(id: string) {
    if (!editor || !canGo(id)) return;
    if (id === 'design') return finishSketch();
    const ed = editor;
    ed.selection = null; ed.siteSelection = null; ed.draft = []; ed.drawingLot = false; ed.drawingFootprint = false;
    if (id === 'lot') ed.floorIdx = 0;
    ed.plan.meta.stage = id as Stage;
    ed.onChange?.();
  }

  /** Sketch mode: the ground floor is set, rooms are drawn in the workspace. */
  async function finishSketch() {
    if (!editor) return;
    editor.plan.meta.stage = 'design';
    await storage.savePlan(planId, $state.snapshot(editor.plan) as PlanSpec);
    navigate(`/design/workspace?id=${planId}`);
  }

  /** A generated layout was chosen: it becomes the plan, and the workspace opens. */
  async function openLayout(plan: PlanSpec) {
    if (!editor) return;
    await storage.savePlan(planId, plan);
    toast('Layout ready: change anything you like', 'success');
    navigate(`/design/workspace?id=${planId}`);
  }

  function generated(b: Brief & { style?: string; notes?: string }) {
    brief = b;
    go('layout');
  }

  /** The client took one of the briefs that fit (offered when theirs has no sound layout). */
  function rebrief(b: Brief) {
    if (!editor || !brief) return;
    brief = { ...brief, bedrooms: b.bedrooms, bathrooms: b.bathrooms, extras: [...b.extras] };
    const r = editor.plan.requirements;
    if (r) editor.plan.requirements = { ...r, bedrooms: b.bedrooms, bathrooms: b.bathrooms, extras: [...b.extras] };
    editor.onChange?.();
  }

  function onkeydown(e: KeyboardEvent) {
    if (!editor || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
  }
</script>

<svelte:window {onkeydown} />

{#if status === 'loading'}
  <div class="p-8"><StateBox kind="loading" title="Opening your plan…" /></div>
{:else if status === 'missing' || !editor}
  <div class="p-8 max-w-xl mx-auto"><StateBox kind="error" title="We couldn't find that plan">It may have been created on another device. <a class="underline" href={href('/design')}>Start a new plan</a>.</StateBox></div>
{:else}
  {@const ed = editor}
  <div class="relative flex flex-col h-[calc(100dvh-3.5rem)] overflow-hidden">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper z-20 flex-wrap">
      <a href={href('/design')} class="text-sm text-muted hover:text-ink shrink-0" aria-label="All plans">←</a>
      <label class="sr-only" for="flow-title">Plan name</label>
      <input id="flow-title" class="bg-transparent font-semibold min-w-0 flex-1 basis-28 px-1 py-1 rounded-lg hover:bg-paper-2 focus:bg-white" value={ed.plan.meta.title}
        onchange={(e) => { ed.plan.meta.title = (e.target as HTMLInputElement).value || 'My plan'; ed.onChange?.(); }} />
      <span class="text-xs text-muted hidden md:inline" aria-live="polite">{saved === 'saving' ? 'Saving…' : '✓ Saved on this device'}</span>
      <ol class="flex items-center gap-1 text-sm order-last md:order-none w-full md:w-auto overflow-x-auto" aria-label="Steps">
        {#each steps as s, i}
          {@const current = s.id === stage}
          {@const done = i < stageIdx}
          <li class="flex items-center gap-1 shrink-0">
            {#if i > 0}<span class="text-line" aria-hidden="true">›</span>{/if}
            <button class="px-2.5 py-1 rounded-full whitespace-nowrap {current ? 'bg-ink text-white font-semibold' : done ? 'text-ink hover:bg-paper-2' : 'text-muted'} disabled:cursor-not-allowed"
              aria-current={current ? 'step' : undefined} disabled={!current && !canGo(s.id)} onclick={() => go(s.id)}>
              <span class="tabular-nums">{i + 1}.</span> {s.label}{#if done}<span aria-hidden="true"> ✓</span>{/if}
            </button>
          </li>
        {/each}
      </ol>
      <div class="flex gap-1">
        <button class="btn btn-ghost btn-sm btn-icon" aria-label="Undo" disabled={!ed.canUndo} onclick={() => ed.undo()}>↶</button>
        <button class="btn btn-ghost btn-sm btn-icon" aria-label="Redo" disabled={!ed.canRedo} onclick={() => ed.redo()}>↷</button>
      </div>
    </div>

    <div class="relative flex-1 min-h-0">
      {#if stage === 'lot'}
        <LotStep editor={ed} onnext={() => go('floors')} />
      {:else if stage === 'floors'}
        <FloorsStep editor={ed} {mode} onback={() => go('lot')} onnext={() => (mode === 'pro' ? finishSketch() : go('brief'))} />
      {:else if stage === 'brief' && mode === 'creative'}
        <TemplateBrief editor={ed} onback={() => go('floors')} ongenerate={generated} />
      {:else if stage === 'brief'}
        <ChatBrief editor={ed} {planId} onback={() => go('floors')} ongenerate={generated} />
      {:else if stage === 'layout' && brief}
        {#key brief}<LayoutStep editor={ed} {brief} onback={() => go('brief')} onopen={openLayout} onbrief={rebrief} />{/key}
      {:else}
        <div class="p-8 max-w-xl mx-auto"><StateBox kind="empty" title="Nothing to show here yet"><button class="underline" onclick={() => go('brief')}>Back to the brief</button></StateBox></div>
      {/if}
    </div>
  </div>
{/if}
