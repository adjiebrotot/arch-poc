<script lang="ts">
  import type { ViewerEngine } from './engine/ViewerEngine';
  import { sliceModel } from './model/slice';
  import { onMount } from 'svelte';
  import { Vector3 } from '@babylonjs/core';

  let { engine }: { engine: ViewerEngine } = $props();
  // svelte-ignore state_referenced_locally
  let canvas: HTMLCanvasElement;
  const S = 150;
  const cache = new Map<string, number[][]>();
  const b = engine.model.bbox;
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) + 4;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const toPx = (x: number, z: number) => [S / 2 + ((x - cx) / span) * S, S / 2 + ((z - cz) / span) * S];
  const storeys = [...engine.model.storeys].sort((a, b) => a.elevation - b.elevation);

  function storeyAt(y: number) {
    let s = storeys[0];
    for (const st of storeys) if (st.elevation <= y - 1.0) s = st;
    return s;
  }

  onMount(() => {
    const ctx = canvas.getContext('2d')!;
    let raf = 0, last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 100) return;
      last = t;
      const cam = engine.scene.activeCamera!;
      const st = storeyAt(engine.mode === 'walk' ? cam.position.y : storeys[Math.min(1, storeys.length - 1)].elevation + 1.5);
      const key = st?.name ?? '';
      if (!cache.has(key)) cache.set(key, sliceModel(engine.model, (st?.elevation ?? 0) + 1.2));
      ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = '#1F2326';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const s of cache.get(key)!) { const a = toPx(s[0], s[1]), c = toPx(s[2], s[3]); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); }
      ctx.stroke();
      const p = toPx(cam.position.x, cam.position.z);
      const tgt = engine.mode === 'walk' ? engine.walkCam.getTarget() : engine.orbitCam.target;
      const dir = tgt.subtract(cam.position); dir.y = 0; dir.normalize();
      const ang = Math.atan2(dir.z, dir.x);
      ctx.fillStyle = 'rgba(164,80,47,0.25)';
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.arc(p[0], p[1], 26, ang - 0.5, ang + 0.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#A4502F'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1F2326'; ctx.font = '600 10px Inter Variable, sans-serif';
      ctx.fillText(key, 6, S - 6);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });

  function onclick(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    const x = cx + ((e.clientX - r.left) / r.width - 0.5) * span, z = cz + ((e.clientY - r.top) / r.height - 0.5) * span;
    if (engine.mode !== 'walk') engine.setMode('walk');
    engine.walkTo(new Vector3(x, engine.walkCam.position.y, z));
  }
</script>
<button class="block rounded-2xl" {onclick} aria-label="Minimap: your position on the floor plan. Tap to walk there.">
  <canvas bind:this={canvas} width={S} height={S} class="w-[110px] h-[110px] md:w-[150px] md:h-[150px] rounded-2xl shadow-lg border border-line"></canvas>
</button>
