<script lang="ts">
  import { CATEGORIES, CATEGORY_ICON, CATEGORY_LABEL, type Category } from './model';
  import { authorName, role } from '../stores/session';
  import { fileToThumbnail, pickFile } from '../util/download';

  let { context = '', thumbnail = undefined, onsubmit, oncancel }: {
    context?: string; thumbnail?: string;
    onsubmit: (d: { text: string; category: Category; attachments: string[]; author: string }) => void; oncancel: () => void;
  } = $props();

  let text = $state('');
  let category = $state<Category>('change');
  let attachments = $state<string[]>([]);
  let name = $state($authorName || ($role === 'architect' ? 'Architect' : ''));

  async function addPhoto() {
    const f = await pickFile('image/*');
    if (f) attachments = [...attachments, await fileToThumbnail(f)];
  }
  function submit(e: Event) {
    e.preventDefault();
    if (!text.trim()) return;
    $authorName = name.trim();
    onsubmit({ text: text.trim(), category, attachments, author: name.trim() || ($role === 'architect' ? 'Architect' : 'Client') });
  }
</script>

<form class="grid gap-4" onsubmit={submit}>
  {#if context || thumbnail}
    <div class="flex items-center gap-3 rounded-2xl bg-paper-2 p-2">
      {#if thumbnail}<img src={thumbnail} alt="View where the comment was placed" class="w-20 h-14 object-cover rounded-xl" />{/if}
      <div class="text-sm"><div class="text-xs text-muted">Pinned to</div><div class="font-medium">{context}</div></div>
    </div>
  {/if}
  <div class="flex gap-2" role="radiogroup" aria-label="Kind of comment">
    {#each CATEGORIES as c}
      <button type="button" role="radio" aria-checked={category === c} class="chip flex-1 justify-center" class:on={category === c} onclick={() => (category = c)}>{CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}</button>
    {/each}
  </div>
  <label class="field"><span>Your comment</span>
    <textarea class="input min-h-24" bind:value={text} placeholder={category === 'like' ? 'What do you love about this?' : category === 'change' ? 'What would you like changed?' : 'What would you like to know?'} required></textarea>
  </label>
  <div class="flex items-center gap-2 flex-wrap">
    {#each attachments as a, i}
      <div class="relative"><img src={a} alt="Attached reference" class="w-16 h-16 object-cover rounded-xl" /><button type="button" class="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-ink text-white text-xs" aria-label="Remove photo" onclick={() => (attachments = attachments.filter((_, j) => j !== i))}>✕</button></div>
    {/each}
    <button type="button" class="btn btn-ghost btn-sm" onclick={addPhoto}>📷 Add photo / reference</button>
  </div>
  <label class="field"><span>Your name</span><input class="input" bind:value={name} placeholder="e.g. Sam" autocomplete="name" /></label>
  <div class="flex justify-end gap-2">
    <button type="button" class="btn btn-ghost" onclick={oncancel}>Cancel</button>
    <button class="btn btn-accent" disabled={!text.trim()}>Post comment</button>
  </div>
</form>
