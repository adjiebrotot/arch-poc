<script lang="ts">
  /**
   * Step 3 (Just tell us): describe the home in your own words. The floors are already drawn, so
   * the conversation is about what goes inside them: bedrooms, bathrooms, extra rooms, and how
   * rooms relate (main bedroom downstairs, living facing the garden…).
   */
  import { uuid } from '@shared/util/id';
  import { floorLabel } from '@shared/planspec/schema';
  import { footprintArea } from '@shared/planspec/envelope';
  import { createChatProvider, SCHEMA_VERSION, MAX_HISTORY, emptyRequirements, missingOf, type ChatMessage, type ParsedRequirements } from '../llm';
  import { checkFeasibility, nearestFeasible, EXTRAS, describe as describeBrief, envelopeOf } from '../generator/feasibility';
  import type { Brief } from '../generator/generator';
  import type { Editor } from '../workspace/editor.svelte';
  import EnvelopeThumb from './EnvelopeThumb.svelte';
  import { tick, untrack } from 'svelte';

  let { editor, planId, onback, ongenerate }: { editor: Editor; planId: string; onback: () => void; ongenerate: (b: Brief & { style?: string; notes?: string }) => void } = $props();

  interface UiMsg extends ChatMessage { suggestion?: { label: string; apply: () => void }[] }

  const plan0 = untrack(() => editor.plan);
  const env = envelopeOf(plan0);
  const floorsText = plan0.floors.map((f) => `${floorLabel(f.level).toLowerCase()} ${footprintArea(f.footprint).toFixed(0)} m²`).join(', ');
  const provider = createChatProvider();
  const KEY = `al:chat:${untrack(() => planId)}`;
  const sessionId = (() => { try { return sessionStorage.getItem(KEY + ':sid') ?? (sessionStorage.setItem(KEY + ':sid', uuid()), sessionStorage.getItem(KEY + ':sid')!); } catch { return uuid(); } })();
  const greeting: UiMsg = {
    role: 'assistant',
    content: `Your floors are drawn: ${env.floors === 1 ? 'one level' : `${env.floors} floors`}, ${env.area} m² in all (${floorsText}). Now tell me what should go inside: how many bedrooms and bathrooms, any rooms you need (study, garage, laundry…) and how they should relate, e.g. "main bedroom downstairs" or "living facing the back garden".`,
  };

  function restore(): { msgs: UiMsg[]; req: ParsedRequirements } {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
      if (s?.msgs?.length) return { msgs: s.msgs.map((m: ChatMessage) => ({ role: m.role, content: m.content })), req: s.req };
    } catch { /* noop */ }
    const r = plan0.requirements;
    return { msgs: [greeting], req: r ? { ...emptyRequirements(), bedrooms: r.bedrooms, bathrooms: r.bathrooms, extras: r.extras, style: r.style ?? null, notes: r.notes } : emptyRequirements() };
  }
  const init = restore();
  let messages = $state<UiMsg[]>(init.msgs);
  let req = $state<ParsedRequirements>(init.req);
  let input = $state('');
  let busy = $state(false);
  let offline = $state(!provider.online);
  let list: HTMLElement | undefined = $state();

  $effect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify({ msgs: messages.map(({ role, content }) => ({ role, content })), req })); } catch { /* noop */ }
  });

  async function scroll() { await tick(); list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); }

  async function send(text = input) {
    text = text.trim();
    if (!text || busy) return;
    input = '';
    messages.push({ role: 'user', content: text });
    busy = true;
    scroll();
    const history: ChatMessage[] = messages.slice(1).map(({ role, content }) => ({ role, content })).slice(-MAX_HISTORY);
    const res = await provider.parse({ sessionId, messages: history, schemaVersion: SCHEMA_VERSION, locale: 'en-AU' });
    if (res.degraded) offline = true;
    const r = res.requirements;
    req = {
      area: r.area ?? req.area, floors: r.floors ?? req.floors, bedrooms: r.bedrooms ?? req.bedrooms, bathrooms: r.bathrooms ?? req.bathrooms,
      extras: r.extras.length || res.provider !== 'rule-based' ? r.extras : req.extras, style: r.style ?? req.style, notes: r.notes || req.notes,
    };
    let reply = res.assistantMessage;
    // size and storeys come from the drawn footprints, not from the conversation
    const saysOther = (r.area !== null && Math.abs(r.area - env.area) > 10) || (r.floors !== null && r.floors !== env.floors);
    if (saysOther) reply += `\n(Your footprints set the size: ${env.area} m² over ${env.floors === 1 ? 'one level' : `${env.floors} floors`}. To change that, go back to Floors.)`;
    messages.push({ role: 'assistant', content: reply });
    busy = false;
    scroll();
  }

  const missing = $derived(missingOf(req));
  const ready = $derived(missing.length === 0);

  function generate() {
    const brief = { ...env, bedrooms: req.bedrooms!, bathrooms: req.bathrooms!, extras: req.extras };
    const f = checkFeasibility(brief);
    if (!f.ok) {
      const n = nearestFeasible(brief);
      const options: UiMsg['suggestion'] = [];
      if (n.suggestion) { const s = n.suggestion; options.push({ label: `Use ${describeBrief(s)}`, apply: () => { req = { ...req, bedrooms: s.bedrooms, bathrooms: s.bathrooms, extras: s.extras }; generate(); } }); }
      options.push({ label: 'Make the floors bigger', apply: onback });
      messages.push({ role: 'assistant', content: `That's a squeeze: ${describeBrief(brief)} doesn't fit in your ${env.area} m² (${f.reason}). ${n.message}`, suggestion: options });
      scroll();
      return;
    }
    editor.pushHistory();
    editor.plan.requirements = { area: env.area, floors: env.floors, bedrooms: brief.bedrooms, bathrooms: brief.bathrooms, extras: [...req.extras], ...(req.style ? { style: req.style } : {}), notes: req.notes };
    editor.onChange?.();
    ongenerate({ bedrooms: brief.bedrooms, bathrooms: brief.bathrooms, extras: [...req.extras], style: req.style ?? undefined, notes: req.notes });
  }

  function reset() { messages = [greeting]; req = emptyRequirements(); }
  const step = (k: 'bedrooms' | 'bathrooms', d: number, lo: number, hi: number) => { req[k] = Math.min(hi, Math.max(lo, (req[k] ?? lo) + d)); };
  const examples = ['3 bedrooms, 2 bathrooms and a study', '4 bed 2 bath, main bedroom downstairs, garage', '2 bedrooms, open-plan living facing the back garden'];
  const rooms = EXTRAS.filter((e) => e.kind === 'room');
  const prefs = EXTRAS.filter((e) => e.kind === 'pref' && (e.id !== 'master-ground' || env.floors > 1));
  const toggle = (id: string) => (req.extras = req.extras.includes(id) ? req.extras.filter((x) => x !== id) : [...req.extras, id]);
</script>

<div class="max-w-3xl mx-auto px-4 pt-3 flex flex-col h-full">
  <div class="flex items-center gap-2 flex-wrap">
    <button class="text-sm text-muted hover:text-ink" onclick={onback}>← Floors</button>
    <h1 class="font-semibold text-xl flex-1 ml-2">Describe your home</h1>
    {#if offline}<span class="badge badge-poc" title="The AI assistant isn't reachable, so a simpler built-in parser is used.">● Offline mode – simplified parsing</span>{/if}
    <button class="btn btn-ghost btn-sm" onclick={reset}>Start over</button>
  </div>

  <div bind:this={list} class="flex-1 overflow-y-auto py-4 grid content-start gap-3" aria-live="polite" aria-label="Conversation">
    <div class="flex justify-start"><div class="w-40 card p-1.5"><EnvelopeThumb plan={editor.plan} /></div></div>
    {#each messages as m}
      <div class="flex {m.role === 'user' ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[88%] rounded-3xl px-4 py-3 whitespace-pre-line {m.role === 'user' ? 'bg-ink text-white rounded-br-md' : 'bg-card border border-line rounded-bl-md'}">
          <span class="sr-only">{m.role === 'user' ? 'You' : 'Assistant'}:</span>{m.content}
          {#if m.suggestion?.length}
            <div class="flex flex-wrap gap-2 mt-3">{#each m.suggestion as s}<button class="btn btn-soft btn-sm" onclick={s.apply}>{s.label}</button>{/each}</div>
          {/if}
        </div>
      </div>
    {/each}
    {#if busy}
      <div class="flex"><div class="bg-card border border-line rounded-3xl rounded-bl-md px-4 py-3 typing text-xl leading-none" role="status" aria-label="Assistant is typing"><span>•</span><span>•</span><span>•</span></div></div>
    {/if}
    {#if messages.length === 1}
      <div class="flex flex-wrap gap-2 mt-2">{#each examples as e}<button class="chip text-left" onclick={() => send(e)}>“{e}”</button>{/each}</div>
    {/if}
  </div>

  {#if req.bedrooms !== null || req.bathrooms !== null || req.extras.length}
    <section class="card p-3 mb-2" aria-label="What we understood (editable)">
      <div class="text-xs font-semibold text-muted mb-2">What we understood — tap to adjust</div>
      <div class="flex flex-wrap gap-2 items-center">
        <span class="chip on" title="From your footprints">{env.area} m² · {env.floors === 1 ? '1 floor' : `${env.floors} floors`}</span>
        {#each [['bedrooms', 'Bedrooms', 1, 6], ['bathrooms', 'Bathrooms', 1, 4]] as [k, label, lo, hi]}
          {@const key = k as 'bedrooms' | 'bathrooms'}
          <span class="chip !px-1 {req[key] === null ? 'border-accent border-dashed' : ''}">
            <button class="w-8 h-8 rounded-full hover:bg-paper-2" aria-label={`Fewer ${label}`} onclick={() => step(key, -1, lo as number, hi as number)}>−</button>
            {label}: <strong>{req[key] ?? '?'}</strong>
            <button class="w-8 h-8 rounded-full hover:bg-paper-2" aria-label={`More ${label}`} onclick={() => step(key, 1, lo as number, hi as number)}>+</button>
          </span>
        {/each}
        {#each rooms as e}
          <button class="chip" aria-pressed={req.extras.includes(e.id)} onclick={() => toggle(e.id)}>{e.icon} {e.label}</button>
        {/each}
        {#each prefs as e}
          <button class="chip" aria-pressed={req.extras.includes(e.id)} onclick={() => toggle(e.id)}>{e.icon} {e.label}</button>
        {/each}
        {#if req.style}<span class="chip">Style: {req.style} <button aria-label="Remove style" onclick={() => (req.style = null)}>✕</button></span>{/if}
      </div>
      <div class="flex items-center gap-2 mt-3">
        <p class="text-xs text-muted flex-1">{ready ? 'All set.' : `Still need: ${missing.join(', ')}`}</p>
        <button class="btn btn-accent btn-sm" disabled={!ready || busy} onclick={generate}>Generate layouts →</button>
      </div>
    </section>
  {/if}

  <form class="flex gap-2 pb-3 safe-b" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <label class="sr-only" for="chat-in">Message</label>
    <input id="chat-in" class="input !rounded-full flex-1" placeholder="e.g. 3 bedrooms, a study and the main bedroom downstairs…" bind:value={input} autocomplete="off" />
    <button class="btn btn-primary" disabled={!input.trim() || busy}>Send</button>
  </form>
</div>
