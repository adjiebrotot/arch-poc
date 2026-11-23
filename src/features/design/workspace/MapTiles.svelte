<script lang="ts">
  /** OpenStreetMap tiles under the plan (SVG group in plan metres; the plan may be turned). */
  import { tilesFor, type GeoOrigin } from '@shared/geo/osm';

  let { geo, rotation = 0, view, scale, opacity = 1 }: {
    geo: GeoOrigin; rotation?: number; view: { x: number; y: number; w: number; h: number }; scale: number; opacity?: number;
  } = $props();

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const set = $derived(tilesFor(geo, rotation, view, scale, dpr));
</script>

<g transform={`rotate(${rotation})`} opacity={opacity} style="pointer-events:none">
  {#each set.tiles as t (t.key)}
    <!-- a hair of overlap hides seams between tiles -->
    <image href={t.url} x={t.x} y={t.y} width={t.size * 1.002} height={t.size * 1.002} preserveAspectRatio="none" />
  {/each}
</g>
