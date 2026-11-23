<script lang="ts">
  let { ondone }: { ondone: () => void } = $props();
  let step = $state(0);
  const steps = [
    { icon: '⬛', title: '1 · Draw rooms', text: 'Your footprint is already drawn and its outside walls are in place. Pick “Add a room” and tap each corner (it snaps to the 1 m grid). Rooms always stay inside the footprint.' },
    { icon: '🚪', title: '2 · Add doors & windows', text: 'Choose “Add door” or “Add window”, then tap on a wall. Drag them along the wall later with “Move”.' },
    { icon: '🏷️', title: '3 · Name your rooms', text: 'Tap a room and choose what it is — bedroom, kitchen… The size in m² updates as you go.' },
    { icon: '🏠', title: '4 · More floors', text: '“+ Add floor” starts a new storey as a copy of the floor below. Drag its corners with 🏠 Footprint to make it smaller, then draw its rooms. Upper floors can never reach outside the floor below.' },
  ];

</script>
<div class="absolute inset-0 z-30 bg-black/25 grid items-end md:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Quick tour">
  <div class="card p-6 max-w-sm w-full shadow-2xl grid gap-3">
    <div class="text-4xl" aria-hidden="true">{steps[step].icon}</div>
    <h2 class="text-lg font-semibold">{steps[step].title}</h2>
    <p class="text-ink-2">{steps[step].text}</p>
    <div class="flex items-center gap-2 mt-2">
      <div class="flex gap-1 flex-1" aria-hidden="true">{#each steps as _, i}<span class="h-1.5 w-6 rounded-full {i <= step ? 'bg-accent' : 'bg-line'}"></span>{/each}</div>
      <button class="btn btn-ghost btn-sm" onclick={ondone}>Skip</button>
      <button class="btn btn-primary btn-sm" onclick={() => (step < steps.length - 1 ? step++ : ondone())}>{step < steps.length - 1 ? 'Next' : "Let's go"}</button>
    </div>
  </div>
</div>
