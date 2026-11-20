<script lang="ts">
  import { href } from '@shared/router';
</script>

<section class="pt-10 md:pt-20 pb-10 grid gap-5 max-w-3xl">
  <p class="eyebrow">Atelier Linea · Residential architecture</p>
  <h1 class="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">Your home, designed together.</h1>
  <p class="text-lg text-ink-2 max-w-2xl">
    You know how you want to live. We know how to build it. Sketch a rough layout, pick a starting point or simply tell us
    what you need — then walk through the design and leave comments right where they matter.
  </p>
</section>

<section class="grid md:grid-cols-2 gap-5" aria-label="What you can do">
  <a href={href('/design')} class="card group p-6 md:p-8 grid gap-4 hover:border-ink transition-colors">
    <div class="aspect-[16/9] rounded-2xl bg-paper-2 overflow-hidden grid place-items-center" aria-hidden="true">
      <svg viewBox="0 0 320 180" class="w-full h-full">
        <rect x="0" y="0" width="320" height="180" fill="#EFECE6"/>
        <g transform="translate(60 25)" stroke="#1F2326" fill="none" stroke-linecap="square">
          <rect x="0" y="0" width="200" height="130" fill="#FBFAF7" stroke-width="6"/>
          <path d="M0 55h200M80 0v55M140 0v55M90 55v75" stroke-width="2.5"/>
          <rect x="0" y="0" width="80" height="55" fill="#E2D7EF" stroke="none" transform="translate(3 3) scale(.97)"/>
          <rect x="93" y="58" width="104" height="69" fill="#F3EBDD" stroke="none"/>
          <rect x="3" y="58" width="85" height="69" fill="#F4E6CF" stroke="none"/>
          <circle cx="170" cy="30" r="10" fill="#A4502F" stroke="#fff" stroke-width="3"/>
        </g>
      </svg>
    </div>
    <div>
      <p class="eyebrow">Feature 1</p>
      <h2 class="text-2xl font-semibold mt-1">Design it yourself</h2>
      <p class="text-ink-2 mt-2">Sketch your own layout, start from a template that fits your budget, or just chat with us about what you need.</p>
    </div>
    <span class="btn btn-primary justify-self-start">Start designing →</span>
  </a>

  <a href={href('/viewer')} class="card group p-6 md:p-8 grid gap-4 hover:border-ink transition-colors">
    <div class="aspect-[16/9] rounded-2xl overflow-hidden" aria-hidden="true">
      <svg viewBox="0 0 320 180" class="w-full h-full">
        <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9D9E6"/><stop offset="1" stop-color="#F3EFE7"/></linearGradient></defs>
        <rect width="320" height="180" fill="url(#sky)"/>
        <rect y="130" width="320" height="50" fill="#9CB28A"/>
        <path d="M70 130V80l90-40 90 40v50z" fill="#FBFAF7" stroke="#1F2326" stroke-width="2"/>
        <rect x="100" y="92" width="40" height="38" fill="#7FA6BF" opacity=".7"/>
        <rect x="175" y="92" width="50" height="26" fill="#7FA6BF" opacity=".7"/>
        <path d="M60 82l100-46 100 46" fill="none" stroke="#1F2326" stroke-width="5"/>
        <g transform="translate(200 70)"><path d="M0 0c-9 0-16 7-16 16 0 12 16 26 16 26s16-14 16-26C16 7 9 0 0 0z" fill="#A4502F"/><circle cy="16" r="5" fill="#fff"/></g>
      </svg>
    </div>
    <div>
      <p class="eyebrow">Feature 2</p>
      <h2 class="text-2xl font-semibold mt-1">Walk &amp; comment</h2>
      <p class="text-ink-2 mt-2">Explore your architect's model as drawings or a lifelike 3D walkthrough, and drop comments exactly where you mean.</p>
    </div>
    <span class="btn btn-accent justify-self-start">Open the walkthrough →</span>
  </a>
</section>

<section class="mt-14 grid md:grid-cols-3 gap-6 text-ink-2" aria-label="How it works">
  {#each [
    ['1', 'Describe', 'Sketch, choose a template or chat — no drawing skills needed.'],
    ['2', 'Review', 'We turn your ideas into a model you can walk through on your phone.'],
    ['3', 'Comment', 'Tap any wall, window or room to tell us what you love or want changed.'],
  ] as [n, t, d]}
    <div class="flex gap-4">
      <div class="w-9 h-9 shrink-0 rounded-full bg-ink text-white grid place-items-center font-semibold">{n}</div>
      <div><h3 class="font-semibold text-ink">{t}</h3><p class="text-sm mt-1">{d}</p></div>
    </div>
  {/each}
</section>
<p class="mt-14 text-xs text-muted">Proof of concept. Everything runs in your browser and is stored on this device only. Use the header switch to try the Client or Architect view.</p>
