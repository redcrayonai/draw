<script lang="ts">
  import { session, signIn } from '$lib/session';
  import { stdbState } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { appHref } from '$lib/boards';
  import { myWorkspaces, workspaceState } from '$lib/workspaces';
  import Button from '$lib/components/Button.svelte';
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  // ids that existed before the create, so the new row can be found when it arrives
  let before = $state<Set<string> | null>(null);
  let made = $state('');
  const created = $derived(before && $myWorkspaces.find(w => w.name === made && w.role === 'owner' && !before!.has(w.id.toString())));
  const disabled = $derived($stdbState.status !== 'live' || busy);
  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    busy = true;
    error = '';
    const ids = new Set($myWorkspaces.map(w => w.id.toString()));
    try {
      await callReducer(c => c.reducers.createWorkspace({ name: name.trim() }));
      before = ids;
      made = name.trim();
      name = '';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>
<svelte:head><title>New workspace · Draw</title></svelte:head>
<div class="settings">
  <header><h1>New workspace</h1><p class="sub">Keep personal, company, and client boards in their own workspaces.</p></header>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
  {#if made}
    <p class="notice" role="status">Workspace created. {#if created}<a href={appHref(`/workspaces/members?workspace=${created.id}&tab=invitations`)}>Invite people to {created.name}</a>{/if}</p>
  {/if}
  {#if $session.status !== 'signed-in'}
    <p class="workspace-hint">Sign in to create a workspace.</p><Button variant="primary" onclick={() => signIn()}>sign in</Button>
  {:else if $workspaceState === 'unavailable'}
    <p class="alert" role="alert">Workspaces need the latest board server. Update the server and reload.</p>
  {:else}
    <form class="workspace-fields" onsubmit={create}>
      <label class="workspace-field">New workspace name<input bind:value={name} maxlength="100" disabled={disabled} placeholder="Company or client name" /></label>
      <Button variant="primary" type="submit" disabled={disabled || !name.trim()}>create workspace</Button>
    </form>
  {/if}
</div>
<style>
  .notice { font: 400 13px/1.5 var(--rc-sans); padding: 12px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); margin: 0 0 16px; }
  input { width: 280px; }
</style>
