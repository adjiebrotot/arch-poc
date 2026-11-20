<script lang="ts">
  import { loading } from './model/modelStore';
</script>
{#if $loading.active}
  <div class="card p-5 grid gap-3" role="status" aria-live="polite">
    <div class="flex justify-between text-sm"><span>{$loading.message || 'Loading…'}</span><span class="tabular-nums text-muted">{Math.round($loading.progress * 100)}%</span></div>
    <div class="h-2 rounded-full bg-paper-2 overflow-hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round($loading.progress * 100)}>
      <div class="h-full bg-accent transition-[width] duration-200" style="width:{Math.max(3, $loading.progress * 100)}%"></div>
    </div>
  </div>
{/if}
