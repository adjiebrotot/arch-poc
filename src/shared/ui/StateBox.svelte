<script lang="ts">
  import type { Snippet } from 'svelte';
  let { kind = 'empty', title, children }: { kind?: 'empty' | 'loading' | 'error'; title: string; children?: Snippet } = $props();
</script>
<div class="card p-8 text-center grid gap-3 justify-items-center" role={kind === 'error' ? 'alert' : 'status'}>
  <div class="text-4xl" aria-hidden="true">{kind === 'loading' ? '⏳' : kind === 'error' ? '⚠️' : '🗂️'}</div>
  <h2 class="font-semibold text-lg">{title}</h2>
  {#if children}<div class="text-muted max-w-md">{@render children()}</div>{/if}
</div>
