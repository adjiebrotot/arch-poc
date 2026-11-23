<script lang="ts">
  /** `#/design/creative`, `#/design/chat`, `#/design/sketch`: start a new plan in that mode (it begins with the lot). */
  import { route } from '@shared/router';
  import { startPlan } from '../planStore';
  const MODES: Record<string, 'pro' | 'creative' | 'chat'> = { '/design/sketch': 'pro', '/design/creative': 'creative', '/design/chat': 'chat' };
  // the router can briefly re-mount this component on the way out (new path): only act on our own paths
  const mode = MODES[$route.path];
  if (mode) startPlan(mode, { replace: true });
</script>

<div class="grid place-items-center h-[60vh] text-muted" role="status">Starting a new plan…</div>
