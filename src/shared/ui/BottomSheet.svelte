<script lang="ts">
  import type { Snippet } from 'svelte';
  let { open = $bindable(false), title = '', onclose, children, wide = false }: {
    open?: boolean; title?: string; onclose?: () => void; children: Snippet; wide?: boolean;
  } = $props();
  let panel: HTMLDivElement | undefined = $state();
  let openedAt = 0;
  function close() { open = false; onclose?.(); }
  // A tap that opens the sheet is followed by a synthesized click at the same spot:
  // ignore backdrop clicks right after opening so that "ghost click" doesn't close it.
  function backdrop() { if (Date.now() - openedAt > 400) close(); }
  $effect(() => {
    if (open) {
      openedAt = Date.now();
      queueMicrotask(() => panel?.querySelector<HTMLElement>('textarea,input:not([type=range]),button:not([aria-label=Close])')?.focus());
    }
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="presentation">
    <button class="absolute inset-0 bg-black/30 cursor-default" style="animation: fade .15s" aria-label="Close" tabindex="-1" onclick={backdrop}></button>
    <div bind:this={panel} role="dialog" aria-modal="true" aria-label={title}
      tabindex="-1"
      onkeydown={(e) => e.key === 'Escape' && close()}
      class="relative w-full {wide ? 'md:max-w-2xl' : 'md:max-w-lg'} max-h-[88vh] overflow-auto bg-card rounded-t-3xl md:rounded-3xl shadow-2xl safe-b"
      style="animation: rise .2s ease-out">
      <div class="sticky top-0 bg-card/95 backdrop-blur z-10 px-5 pt-3 pb-2 flex items-center gap-3 border-b border-line">
        <div class="absolute left-1/2 -translate-x-1/2 top-1.5 h-1 w-10 rounded-full bg-line md:hidden"></div>
        <h2 class="font-semibold text-lg flex-1 pt-2">{title}</h2>
        <button class="btn btn-ghost btn-icon btn-sm mt-1" aria-label="Close" onclick={close}>✕</button>
      </div>
      <div class="p-5">{@render children()}</div>
    </div>
  </div>
{/if}
