<script lang="ts">
  import { authenticatedHref } from '$lib/session';
  import type { ArchitectureHistory, ArchitectureVersion, PinnedRef } from '$lib/history';
  import { canvasHref } from '$lib/boards';
  import Button from './Button.svelte';
  let { histories, versions, slugs = new Map(), ondelete, disabled = false }: {
    histories: ArchitectureHistory[];
    versions: ArchitectureVersion[];
    /** board id → its #b= link id */
    slugs?: Map<bigint, string>;
    /** rejects with the reducer's sentence */
    ondelete?: (historyId: bigint) => Promise<void>;
    disabled?: boolean;
  } = $props();
  const statuses: Record<string, string> = { queued: 'Queued', running: 'Importing…', ready: 'Ready', partial: 'Partially imported', failed: 'Import failed' };
  // BoardCard's inline confirm, for one history at a time.
  let deleting = $state<bigint | null>(null);
  let confirmation = $state('');
  let busy = $state(false);
  let deleteError = $state('');
  let input = $state<HTMLInputElement>();
  $effect(() => input?.focus());

  function manage(id: bigint | null) {
    if (busy) return;
    confirmation = '';
    deleteError = '';
    deleting = id;
  }

  async function submit(e: SubmitEvent, history: ArchitectureHistory) {
    e.preventDefault();
    if (busy || disabled || confirmation !== history.name) return;
    busy = true;
    deleteError = '';
    try {
      await ondelete?.(history.id);
      deleting = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<section class="histories" aria-label="Architecture histories">
  <h2 class="eyebrow">Architecture histories</h2>
  {#each histories as history (history.id)}
    {@const refs = JSON.parse(history.refsJson) as PinnedRef[]}
    {@const snapshots = new Map(versions.filter((v) => v.historyId === history.id && v.assertionMode === 'fact').map((v) => [v.index, v]))}
    <article class="history">
      <div class="head"><h3>{history.name}</h3><span role="status">{statuses[history.status] ?? history.status}</span></div>
      <a class="repo" href={history.repository}>{history.repository.replace('https://github.com/', '')}</a>
      <p class="progress num">{snapshots.size} of {refs.length} snapshots imported</p>
      <ol>
        {#each refs as ref, index (index)}
          {@const snapshot = snapshots.get(index)}
          {@const slug = snapshot && slugs.get(snapshot.boardId)}
          <li>{#if slug}<a href={authenticatedHref(canvasHref(slug))}>{ref.ref}</a>{:else}<span>{ref.ref}</span>{/if}<span class="sha num">{ref.sha.slice(0, 7)}</span></li>
        {/each}
      </ol>
      {#if history.error}<p class="alert">{history.error}</p>{/if}
      {#if ondelete}
        <div class="manage">
          {#if deleting === history.id}
            <form aria-label={`Delete ${history.name}`} onsubmit={(e) => submit(e, history)}>
              <p class="prose">Delete “{history.name}”, its versions and their boards permanently? This cannot be undone.</p>
              <label class="field"><span>History name to confirm deletion</span><input bind:this={input} bind:value={confirmation} placeholder={history.name} disabled={busy || disabled} onkeydown={(e) => e.key === 'Escape' && manage(null)} /></label>
              <div class="actions">
                <Button type="button" disabled={busy} onclick={() => manage(null)}>cancel</Button>
                <Button variant="primary" type="submit" disabled={busy || disabled || confirmation !== history.name}>{busy ? 'deleting…' : 'delete permanently'}</Button>
              </div>
              {#if deleteError}<p class="alert" role="alert">{deleteError}</p>{/if}
            </form>
          {:else}
            <Button variant="ghost" {disabled} aria-label={`Delete history ${history.name}`} onclick={() => manage(history.id)}>delete history</Button>
          {/if}
        </div>
      {/if}
    </article>
  {/each}
</section>

<style>
  .histories { margin: 0 0 24px; }
  .history { margin-top: 12px; padding: 16px 20px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-lg); background: var(--rc-card); }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
  h3 { margin: 0; font: 400 20px/1.2 var(--rc-serif); }
  .head span, .repo, .progress, li { font: 400 12px/1.5 var(--rc-sans); }
  .repo, .progress, .sha { color: var(--rc-muted); }
  .progress { margin: 8px 0; }
  ol { margin: 0; padding-left: 20px; }
  .sha { margin-left: 12px; font-family: var(--rc-mono); }
  .alert { margin: 12px 0; }
  .manage { margin-top: 12px; }
  .manage form { border-top: 1px solid var(--rc-divider); padding-top: 12px; }
  .prose { margin: 0 0 12px; font: 400 12px/1.5 var(--rc-sans); color: var(--rc-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font: 500 12px/1.5 var(--rc-sans); color: var(--rc-muted); }
  input { width: 100%; min-width: 0; box-sizing: border-box; height: 36px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised); padding: 0 12px; font: 400 13px/1 var(--rc-sans); color: var(--rc-ink); }
</style>
