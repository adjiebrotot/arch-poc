<script lang="ts">
  import { href } from '@shared/router';
  import { uuid } from '@shared/util/id';
  import { createChatProvider, SCHEMA_VERSION, MAX_HISTORY, emptyRequirements, missingOf, type ChatMessage, type ParsedRequirements } from './llm';
  import { checkFeasibility, nearestFeasible, EXTRAS, describe as describeBrief, FEASIBILITY } from './generator/feasibility';
  import { generateVariants } from './generator/generator';
  import { savePlanAndOpen } from './planStore';
  import PlanThumb from './PlanThumb.svelte';
  import type { PlanSpec } from '@shared/planspec/schema';
  import { tick } from 'svelte';

  interface UiMsg extends ChatMessage { variants?: PlanSpec[]; suggestion?: { label: string; apply: () => void }[] }

  const provider = createChatProvider();
  const KEY = 'al:chat';
  const sessionId = (() => { try { return sessionStorage.getItem(KEY + ':sid') ?? (sessionStorage.setItem(KEY + ':sid', uuid()), sessionStorage.getItem(KEY + ':sid')!); } catch { return uuid(); } })();
  const greeting: UiMsg = { role: 'assistant', content: "Hi! I'm here to help sketch your first layout. Tell me about the home you're dreaming of — how many bedrooms, roughly how big, anything you can't live without?" };

  function restore(): { msgs: UiMsg[]; req: ParsedRequirements } {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
      if (s?.msgs?.length) return { msgs: s.msgs.map((m: ChatMessage) => ({ role: m.role, content: m.content })), req: s.req };
    } catch { /* noop */ }
    return { msgs: [greeting], req: emptyRequirements() };
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
    // Merge: newer non-null values win; chips edited by the user stay unless the AI states a new value.
    const r = res.requirements;
    req = {
      area: r.area ?? req.area, floors: r.floors ?? req.floors, bedrooms: r.bedrooms ?? req.bedrooms, bathrooms: r.bathrooms ?? req.bathrooms,
      extras: r.extras.length || res.provider !== 'rule-based' ? r.extras : req.extras, style: r.style ?? req.style, notes: r.notes || req.notes,
    };
    messages.push({ role: 'assistant', content: res.assistantMessage });
    busy = false;
    scroll();
  }

  const missing = $derived(missingOf(req));
  const ready = $derived(missing.length === 0);

  function generate() {
    const brief = { area: req.area!, floors: req.floors!, bedrooms: req.bedrooms!, bathrooms: req.bathrooms!, extras: req.extras };
    const f = checkFeasibility(brief);
    if (!f.ok) {
      const n = nearestFeasible(brief);
      const options: UiMsg['suggestion'] = [];
      if (n.suggestion) { const s = n.suggestion; options.push({ label: `Use ${describeBrief(s)}`, apply: () => { req = { ...req, ...s }; generate(); } }); }
      if (n.areaNeeded <= FEASIBILITY.ranges.area.max) options.push({ label: `Make it ${n.areaNeeded} m²`, apply: () => { req = { ...req, area: n.areaNeeded }; generate(); } });
      messages.push({ role: 'assistant', content: `That's a squeeze: ${describeBrief(brief)} in ${brief.area} m² doesn't leave enough room (${f.reason}). ${n.message}`, suggestion: options });
      scroll();
      return;
    }
    const variants = generateVariants({ ...brief, style: req.style ?? undefined, notes: req.notes, mode: 'chat' }, 3, 1);
    messages.push({ role: 'assistant', content: `Here are ${variants.length} first layouts for ${describeBrief(brief)} at ${brief.area} m². Tap one to open it in the editor — you can change everything.`, variants });
    scroll();
  }

  function open(p: PlanSpec) {
    savePlanAndOpen({ ...p, meta: { ...p.meta, mode: 'chat', title: `My ${req.bedrooms}-bedroom ${req.style ?? ''} home`.replace(/\s+/g, ' ') } });
  }

  function reset() { messages = [greeting]; req = emptyRequirements(); }
  const step = (k: 'floors' | 'bedrooms' | 'bathrooms', d: number, lo: number, hi: number) => { req[k] = Math.min(hi, Math.max(lo, (req[k] ?? lo) + d)); };
  const examples = ['3 bed 2 bath, about 150 m², single level with a study', 'Modern two-storey home, 4 bedrooms, garage', '60 m² cottage with 3 bedrooms'];
</script>

<div class="max-w-3xl mx-auto pt-4 md:pt-8 flex flex-col h-[calc(100dvh-3.5rem)]">
  <div class="flex items-center gap-2 flex-wrap">
    <a href={href('/design')} class="text-sm text-muted hover:text-ink">← All options</a>
    <h1 class="font-semibold text-xl flex-1 ml-2">Tell us what you need</h1>
    {#if offline}<span class="badge badge-poc" title="The AI assistant isn't reachable, so a simpler built-in parser is used.">● Offline mode – simplified parsing</span>{/if}
    <button class="btn btn-ghost btn-sm" onclick={reset}>Start over</button>
  </div>

  <div bind:this={list} class="flex-1 overflow-y-auto py-4 grid content-start gap-3" aria-live="polite" aria-label="Conversation">
    {#each messages as m}
      <div class="flex {m.role === 'user' ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[88%] rounded-3xl px-4 py-3 whitespace-pre-line {m.role === 'user' ? 'bg-ink text-white rounded-br-md' : 'bg-card border border-line rounded-bl-md'}">
          <span class="sr-only">{m.role === 'user' ? 'You' : 'Assistant'}:</span>{m.content}
          {#if m.suggestion?.length}
            <div class="flex flex-wrap gap-2 mt-3">{#each m.suggestion as s}<button class="btn btn-soft btn-sm" onclick={s.apply}>{s.label}</button>{/each}</div>
          {/if}
          {#if m.variants}
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
              {#each m.variants as v, i}
                <button class="card p-2 hover:border-ink text-left" onclick={() => open(v)} aria-label={`Open variant ${i + 1} in the editor`}>
                  <PlanThumb plan={v} labels={false} /><div class="text-xs font-semibold mt-1 px-1">Option {i + 1} →</div>
                </button>
              {/each}
            </div>
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

  {#if req.area !== null || req.bedrooms !== null || req.bathrooms !== null || req.floors !== null}
    <section class="card p-3 mb-2" aria-label="What we understood (editable)">
      <div class="text-xs font-semibold text-muted mb-2">What we understood — tap to adjust</div>
      <div class="flex flex-wrap gap-2 items-center">
        <label class="chip !pr-1">Area <input class="w-16 bg-transparent font-semibold text-right" type="number" min="30" max="600" step="5" bind:value={req.area} aria-label="Area in square metres" placeholder="?" /> m²</label>
        {#each [['bedrooms', 'Bedrooms', 1, 6], ['bathrooms', 'Bathrooms', 1, 4], ['floors', 'Floors', 1, 3]] as [k, label, lo, hi]}
          {@const key = k as 'bedrooms' | 'bathrooms' | 'floors'}
          <span class="chip !px-1 {req[key] === null ? 'border-accent border-dashed' : ''}">
            <button class="w-8 h-8 rounded-full hover:bg-paper-2" aria-label={`Fewer ${label}`} onclick={() => step(key, -1, lo as number, hi as number)}>−</button>
            {label}: <strong>{req[key] ?? '?'}</strong>
            <button class="w-8 h-8 rounded-full hover:bg-paper-2" aria-label={`More ${label}`} onclick={() => step(key, 1, lo as number, hi as number)}>+</button>
          </span>
        {/each}
        {#each EXTRAS as e}
          <button class="chip" aria-pressed={req.extras.includes(e.id)} onclick={() => (req.extras = req.extras.includes(e.id) ? req.extras.filter((x) => x !== e.id) : [...req.extras, e.id])}>{e.icon} {e.label}</button>
        {/each}
        {#if req.style}<span class="chip">Style: {req.style} <button aria-label="Remove style" onclick={() => (req.style = null)}>✕</button></span>{/if}
      </div>
      <div class="flex items-center gap-2 mt-3">
        <p class="text-xs text-muted flex-1">{ready ? 'All set.' : `Still need: ${missing.join(', ')}`}</p>
        <button class="btn btn-accent btn-sm" disabled={!ready || busy} onclick={generate}>Generate layouts</button>
      </div>
    </section>
  {/if}

  <form class="flex gap-2 pb-3 safe-b" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <label class="sr-only" for="chat-in">Message</label>
    <input id="chat-in" class="input !rounded-full flex-1" placeholder="e.g. 3 bedrooms, a big kitchen and a study…" bind:value={input} autocomplete="off" />
    <button class="btn btn-primary" disabled={!input.trim() || busy}>Send</button>
  </form>
</div>
