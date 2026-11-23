<script lang="ts">
  /**
   * The design-rule report for a plan (generator/rules.ts): rules that are broken, suggestions, and
   * every rule with why it exists. Used under the generated layouts and in the workspace.
   */
  import { designScore, type Report, type RuleKind } from './generator/rules';

  let { report, onroom }: { report: Report; onroom?: (roomId: string, level?: number) => void } = $props();

  const FAMILIES: { kind: RuleKind; label: string }[] = [
    { kind: 'shape', label: 'Geometry' },
    { kind: 'size', label: 'Size' },
    { kind: 'proportion', label: 'Proportion' },
    { kind: 'placement', label: 'Placement & adjacency' },
  ];
  const hardRules = $derived(report.results.filter((r) => r.severity === 'hard'));
  const broken = $derived(hardRules.filter((r) => !r.ok));
  const notes = $derived(report.results.filter((r) => r.severity === 'soft' && !r.ok));
</script>

<div class="grid gap-3 text-sm">
  {#if !broken.length}
    <p class="font-semibold text-ok">✓ Meets all {hardRules.length} design rules{notes.length ? ` · ${report.soft} suggestion${report.soft === 1 ? '' : 's'}` : ''}</p>
  {:else}
    <p class="font-semibold text-danger">⚠ {report.hard} problem{report.hard === 1 ? '' : 's'} with {broken.length} of {hardRules.length} design rules</p>
  {/if}

  {#if !broken.length}
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Score by family of rules">
      {#each FAMILIES as fam}
        <div class="rounded-xl bg-paper-2 px-3 py-2"><dt class="text-xs text-muted">{fam.label}</dt><dd class="font-semibold">{designScore(report, fam.kind)}<span class="text-muted font-normal text-xs">/100</span></dd></div>
      {/each}
    </dl>
  {/if}

  {#if broken.length}
    <ul class="grid gap-2" aria-label="Rules not met">
      {#each broken as r (r.id)}
        <li class="card p-3 grid gap-1 border-[color:var(--color-danger)]/40">
          <p class="font-semibold">{r.title}</p>
          <ul class="grid gap-0.5 text-ink-2">
            {#each r.issues as i}
              <li>
                {#if onroom && i.roomId}<button class="underline decoration-dotted text-left hover:text-ink" onclick={() => onroom?.(i.roomId!, i.level)}>{i.message}</button>{:else}{i.message}{/if}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}

  {#if notes.length}
    <details class="card p-3">
      <summary class="cursor-pointer font-semibold">Suggestions ({report.soft})</summary>
      <ul class="grid gap-2 mt-2">
        {#each notes as r (r.id)}
          <li class="grid gap-0.5">
            <p class="font-medium">{r.title}</p>
            <ul class="text-ink-2">
              {#each r.issues as i}
                <li>{#if onroom && i.roomId}<button class="underline decoration-dotted text-left hover:text-ink" onclick={() => onroom?.(i.roomId!, i.level)}>{i.message}</button>{:else}{i.message}{/if}</li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  <details class="card p-3">
    <summary class="cursor-pointer font-semibold">All design rules ({report.results.length})</summary>
    <div class="grid gap-3 mt-2">
      {#each FAMILIES as fam}
        <div class="grid gap-1">
          <p class="eyebrow">{fam.label}</p>
          <ul class="grid gap-1.5">
            {#each report.results.filter((r) => r.kind === fam.kind) as r (r.id)}
              <li class="grid grid-cols-[1.25rem_1fr] gap-x-1">
                <span aria-hidden="true" class={r.ok ? 'text-ok' : r.severity === 'hard' ? 'text-danger' : 'text-warn'}>{r.ok ? '✓' : r.severity === 'hard' ? '✗' : '•'}</span>
                <span><span class="font-medium">{r.title}</span>{r.severity === 'soft' ? ' (preference)' : ''}<span class="sr-only">{r.ok ? ': met' : ': not met'}</span><br /><span class="text-muted text-xs">{r.why}</span></span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  </details>
</div>
