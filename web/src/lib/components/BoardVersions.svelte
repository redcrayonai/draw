<script lang="ts">
  import { authenticatedHref } from '$lib/session';
  import { ago, canvasHref, idTail } from '$lib/boards';
  import { boardVersions, offered, pluginCatalog, pluginOn, workspacePlugins } from '$lib/plugins';
  import { restoreKey, restoreVersion, saveVersion } from '$lib/versions';
  import { myWorkspaces } from '$lib/workspaces';
  import Button from './Button.svelte';
  let { boardId, workspaceId, canEdit, disabled = false }: { boardId: bigint; workspaceId: bigint; canEdit: boolean; disabled?: boolean } = $props();
  const on = $derived(offered($pluginCatalog, 'versions') && pluginOn($workspacePlugins, workspaceId, 'versions'));
  const rows = $derived($boardVersions.filter((s) => s.boardId === boardId));
  // Guests save but never restore: a restore makes a workspace board (module/src/versions.ts restorable).
  const canRestore = $derived(canEdit && $myWorkspaces.find((w) => w.id === workspaceId)?.role !== 'guest');
  let busy = $state('');
  let error = $state('');
  let restored = $state<{ href: string } | null>(null);

  async function run(what: string, f: () => Promise<void>) {
    if (busy) return;
    busy = what;
    error = '';
    try { await f(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = ''; }
  }
  const save = () => run('save', async () => { restored = null; await saveVersion(boardId); });
  // A retry after a failure reuses its key: if the first try made the board, the server returns that one.
  const keys = new Map<bigint, string>();
  const restore = (id: bigint) => run(`restore ${id}`, async () => {
    if (!keys.has(id)) keys.set(id, restoreKey());
    const board = await restoreVersion(id, keys.get(id)!);
    keys.delete(id);
    restored = { href: authenticatedHref(canvasHref(board.slug)) };
  });
</script>

{#if on}
  <details class="board-versions workspace-panel">
    <summary>{rows.length ? `Versions · ${rows.length}` : 'Versions'}</summary>
    {#if canEdit}
      <div><Button disabled={disabled || !!busy} onclick={save}>{busy === 'save' ? 'saving…' : 'save version'}</Button></div>
    {/if}
    {#if rows.length}
      <ul>
        {#each rows as s (s.id)}
          {@const when = s.createdAt.toDate()}
          <li>
            <span><time datetime={when.toISOString()} title={when.toLocaleString()}>{ago(when)}</time> · {s.creatorName || `member ${idTail(s.createdBy.toHexString())}`}</span>
            {#if canRestore}<Button variant="ghost" disabled={disabled || !!busy} aria-label={`Restore the version from ${when.toLocaleString()} as a new board`} onclick={() => restore(s.id)}>{busy === `restore ${s.id}` ? 'restoring…' : 'restore as copy'}</Button>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="workspace-hint">No saved versions yet.{canEdit ? ' Restoring one makes a new private board; this board stays as it is.' : ''}</p>
    {/if}
    {#if restored}<p class="workspace-hint" role="status">Restored as a new private board. <a href={restored.href}>Open it</a></p>{/if}
    {#if error}<p class="alert" role="alert">{error}</p>{/if}
  </details>
{/if}

<style>
  .board-versions { padding: 12px 0 0; border: 0; border-top: 1px solid var(--rc-divider); border-radius: 0; background: transparent; }
  .board-versions > summary { margin-bottom: 8px; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; font: 400 13px/1.4 var(--rc-sans); color: var(--rc-ink); }
  li + li { border-top: 1px solid var(--rc-divider); }
</style>
