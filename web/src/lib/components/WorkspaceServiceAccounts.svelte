<script lang="ts">
  import { myBoards } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { workspaceServiceAccounts, boardPermissions, serviceAccountState, managesWorkspace, type Workspace } from '$lib/workspaces';
  import Button from './Button.svelte';
  import ServiceAccountScope from './ServiceAccountScope.svelte';
  import WorkspaceServiceAccount from './WorkspaceServiceAccount.svelte';
  let { workspace, disabled = false }: { workspace: Workspace; disabled?: boolean } = $props();
  let name = $state('');
  let role = $state('viewer');
  let allBoards = $state(true);
  let boardIds = $state<string[]>([]);
  let busy = $state(false);
  let error = $state('');
  const accounts = $derived($workspaceServiceAccounts.filter(account => account.workspaceId === workspace.id));
  const boards = $derived($myBoards.filter(board => $boardPermissions.get(board.boardId)?.workspaceId === workspace.id));
  const blocked = $derived(disabled || busy || $serviceAccountState !== 'live');
  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (blocked || !name.trim() || (!allBoards && !boardIds.length)) return;
    busy = true;
    error = '';
    try {
      await callReducer(c => c.reducers.createWorkspaceServiceAccount({ workspaceId: workspace.id, name: name.trim(), role, allBoards, boardIds: allBoards ? [] : boardIds.map(BigInt) }));
      name = '';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>
{#if !workspace.personal && managesWorkspace(workspace)}
  <section class="workspace-panel">
    <h2>Service accounts</h2>
    {#if $serviceAccountState === 'unavailable'}
      <p class="workspace-hint">Update the board server to manage service accounts.</p>
    {:else if $serviceAccountState !== 'live'}<p class="workspace-hint" role="status">Loading service accounts…</p>
    {:else}
      <form onsubmit={create} aria-label="Create service account">
        <label class="workspace-field">Service account name<input bind:value={name} maxlength="100" disabled={blocked} placeholder="Build automation" /></label>
        <ServiceAccountScope label="Service account" bind:role bind:allBoards bind:boardIds {boards} disabled={blocked} />
        <Button type="submit" disabled={blocked || !name.trim() || (!allBoards && !boardIds.length)}>create service account</Button>
      </form>
      {#each accounts as account (account.id)}
        <WorkspaceServiceAccount {account} {workspace} {boards} disabled={blocked} />
      {:else}<p class="workspace-hint">No service accounts yet.</p>{/each}
    {/if}
    {#if error}<p class="alert" role="alert">{error}</p>{/if}
  </section>
{/if}
<style>
  form { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
</style>
