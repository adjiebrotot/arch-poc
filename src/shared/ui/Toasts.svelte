<script lang="ts">
  import { toasts } from '../stores/session';
</script>
<div class="fixed z-[60] left-0 right-0 top-16 md:top-auto md:bottom-6 flex flex-col items-center gap-2 pointer-events-none px-4" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="pointer-events-auto rounded-full px-4 py-2.5 text-sm font-medium shadow-lg {t.kind === 'error' ? 'bg-danger text-white' : t.kind === 'success' ? 'bg-ok text-white' : 'bg-ink text-white'}" style="animation: fade .2s">{t.text}</div>
  {/each}
</div>
