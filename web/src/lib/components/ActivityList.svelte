<script lang="ts">
  import type { ActivityResult } from '$lib/activity';
  import ActivityItem from './ActivityItem.svelte';
  import Button from './Button.svelte';
  const NEWEST = 8;
  let { result, names, slugs = new Map(), me = '', idle }: {
    /** null while loading */
    result: ActivityResult | null;
    /** board id → name, for the link text */
    names: Map<string, string>;
    /** board id → its #b= link id, for the link */
    slugs?: Map<bigint, string>;
    me?: string;
    /** shown instead of the loading rows when nothing is being fetched */
    idle?: string;
  } = $props();
  let all = $state(false);
  const events = $derived(result && 'events' in result ? result.events : []);
  const shown = $derived(all ? events : events.slice(0, NEWEST));
</script>

{#if idle}
  <p class="hint">{idle}</p>
{:else if !result}
  <div role="status">
    <span class="sr-only">Loading activity…</span>
    {#each [0, 1] as i (i)}
      <div class="skel-row" aria-hidden="true">
        <span class="skel avatar"></span>
        <span class="lines"><span class="skel"></span><span class="skel short"></span></span>
      </div>
    {/each}
  </div>
{:else if 'error' in result}
  <p class="alert" role="alert">{result.error}</p>
{:else if events.length === 0}
  <p class="hint">No activity yet.</p>
{:else}
  <ul>
    {#each shown as e (e.id)}
      <li><ActivityItem event={e} boardName={names.get(e.boardId) ?? `board ${e.boardId}`} slug={slugs.get(BigInt(e.boardId))} {me} /></li>
    {/each}
  </ul>
  {#if !all && events.length > NEWEST}
    <div class="more"><Button variant="ghost" onclick={() => (all = true)}>show all ({events.length})</Button></div>
  {/if}
{/if}

<style>
  ul { list-style: none; margin: 4px 0 0; padding: 0; }
  /* the ghost button's own inline padding would indent its label past the rows */
  .more { margin: 4px 0 0 -10px; }
  li + li { border-top: 1px solid var(--rc-divider); }
  .hint { font: 400 13px/1.5 var(--rc-sans); color: var(--rc-muted); margin: 12px 0 0; }
  .alert { margin-top: 12px; }
  .skel-row { display: flex; gap: 10px; padding: 12px 0; }
  .skel-row + .skel-row { border-top: 1px solid var(--rc-divider); }
  .avatar { width: 20px; height: 20px; border-radius: 50%; flex: none; }
  .lines { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
  .short { width: 40%; }
</style>
