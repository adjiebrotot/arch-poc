<script lang="ts">
  import { route, href } from '@shared/router';
  import { role } from '@shared/stores/session';
  import { loadComments } from '@shared/comments/store';
  import Toasts from '@shared/ui/Toasts.svelte';
  import Landing from '@features/landing/Landing.svelte';
  import type { Component } from 'svelte';

  loadComments();

  // Route table. Heavy screens are lazy-loaded so the landing page stays lean;
  // Babylon.js and web-ifc only download on the viewer routes.
  const routes: Record<string, () => Promise<{ default: Component<any> }>> = {
    '/design': () => import('@features/design/DesignHome.svelte'),
    '/design/creative': () => import('@features/design/CreativeWizard.svelte'),
    '/design/chat': () => import('@features/design/ChatMode.svelte'),
    '/design/workspace': () => import('@features/design/workspace/Workspace.svelte'),
    '/viewer': () => import('@features/viewer/ViewerHome.svelte'),
    '/viewer/plan': () => import('@features/viewer/PlanView.svelte'),
    '/viewer/walk': () => import('@features/viewer/WalkView.svelte'),
    '/comments': () => import('@features/comments/CommentsPage.svelte'),
  };

  const fullBleed = $derived(['/design/workspace', '/viewer/walk', '/viewer/plan'].includes($route.path));
  const loader = $derived($route.path === '/' ? null : routes[$route.path]);
  const nav = [
    { to: '/design', label: 'Design', short: 'Design', match: '/design' },
    { to: '/viewer', label: 'Walk & Comment', short: 'Walk', match: '/viewer' },
    { to: '/comments', label: 'Comments', short: '💬', match: '/comments' },
  ];
</script>

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] btn btn-primary">Skip to content</a>
<header class="sticky top-0 z-40 bg-paper/90 backdrop-blur border-b border-line safe-t">
  <div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3">
    <a href={href('/')} class="flex items-center gap-2 font-semibold tracking-tight shrink-0" aria-label="Architect Tool POC home">
      <svg viewBox="0 0 64 64" class="w-7 h-7" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#1F2326"/><path d="M14 46V26l18-12 18 12v20" fill="none" stroke="#F7F5F1" stroke-width="4" stroke-linejoin="round"/><path d="M26 46V34h12v12" fill="none" stroke="#C8673F" stroke-width="4"/></svg>
      <span class="hidden sm:inline">Architect Tool POC</span>
    </a>
    <nav class="flex-1 flex items-center gap-1 overflow-x-auto text-sm" aria-label="Main">
      {#each nav as n}
        <a href={href(n.to)} class="px-2.5 sm:px-3 py-2 rounded-full whitespace-nowrap {$route.path.startsWith(n.match) ? 'bg-ink text-white' : 'hover:bg-paper-2'}"
          aria-current={$route.path.startsWith(n.match) ? 'page' : undefined} aria-label={n.label}><span class="sm:hidden" aria-hidden="true">{n.short}</span><span class="hidden sm:inline">{n.label}</span></a>
      {/each}
    </nav>
    <div class="flex items-center rounded-full border border-line bg-white p-0.5 text-xs font-semibold shrink-0" role="group" aria-label="Demo role (no login)">
      {#each ['client', 'architect'] as r}
        <button class="px-2 sm:px-2.5 min-h-9 rounded-full {$role === r ? 'bg-accent text-white' : 'text-ink-2'}" aria-pressed={$role === r}
          onclick={() => ($role = r as 'client' | 'architect')}>{r === 'client' ? 'Client' : 'Architect'}</button>
      {/each}
    </div>
  </div>
</header>

<main id="main" class={fullBleed ? '' : 'mx-auto max-w-6xl px-4 pb-16'}>
  {#if $route.path === '/'}
    <Landing />
  {:else if loader}
    {#await loader()}
      <div class="grid place-items-center h-[60vh] text-muted" role="status">
        <div class="flex items-center gap-3"><span class="w-5 h-5 rounded-full border-2 border-line border-t-accent animate-spin"></span> Loading…</div>
      </div>
    {:then mod}
      {#key $route.path}
        <mod.default />
      {/key}
    {:catch e}
      <div class="py-16 text-center" role="alert"><h1 class="text-xl font-semibold">Couldn't load this page</h1><p class="text-muted mt-2">{String(e?.message ?? e)}</p></div>
    {/await}
  {:else}
    <div class="py-24 text-center">
      <h1 class="text-2xl font-semibold">Page not found</h1>
      <p class="text-muted mt-2">That link doesn't lead anywhere. <a class="underline" href={href('/')}>Go home</a>.</p>
    </div>
  {/if}
</main>
<Toasts />
