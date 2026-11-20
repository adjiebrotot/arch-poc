import { writable, derived } from 'svelte/store';

export interface Route {
  path: string;
  query: URLSearchParams;
}

function parse(): Route {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  const [p, q = ''] = (h || '/').split('?');
  const path = '/' + p.replace(/^\/+|\/+$/g, '');
  return { path, query: new URLSearchParams(q) };
}

export const route = writable<Route>(parse());
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.set(parse());
    window.scrollTo(0, 0);
  });
}
export const path = derived(route, (r) => r.path);

/** Hash-based navigation (GitHub Pages friendly: refresh never 404s). */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const target = '#' + (to.startsWith('/') ? to : '/' + to);
  if (opts.replace) {
    history.replaceState(null, '', target);
    route.set(parse());
  } else {
    location.hash = target;
  }
}

export const href = (to: string) => '#' + (to.startsWith('/') ? to : '/' + to);
