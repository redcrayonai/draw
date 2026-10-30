<script lang="ts">
  import { page } from '$app/state';
  import { stdbState } from '$lib/stdb';
  import { myWorkspaces, workspaceState, settingsWorkspace, managesWorkspace } from '$lib/workspaces';
  import WorkspaceServiceAccounts from '$lib/components/WorkspaceServiceAccounts.svelte';
  // the workspace a page shows comes from its link (?workspace=)
  const chosen = $derived(page.url.searchParams.get('workspace') ?? '');
  const workspace = $derived(settingsWorkspace(chosen, $myWorkspaces));
  const disabled = $derived($stdbState.status !== 'live');
</script>
<svelte:head><title>{workspace ? `${workspace.name} · ` : ''}Service accounts &amp; keys · Draw</title></svelte:head>
<div class="settings">
  {#if workspace}<p class="crumb">{workspace.name} › Settings</p>{/if}
  <header><h1>Service accounts &amp; keys</h1><p class="sub">Workspace-owned access for automation. Accounts remain when employees leave. Their keys can read or edit boards, but cannot manage people or sharing.</p></header>
  {#if $workspaceState === 'unavailable'}
    <p class="alert" role="alert">Workspaces need the latest board server. Update the server and reload.</p>
  {:else if $workspaceState !== 'live'}<p class="workspace-hint" role="status">Loading workspaces…</p>
  {:else if !workspace}
    <p class="workspace-hint">This workspace is not available to you. Choose another one in the sidebar.</p>
  {:else if workspace.personal || !managesWorkspace(workspace)}
    <p class="workspace-hint">Owners and admins of a shared workspace manage its service accounts.</p>
  {:else}
    {#key workspace.id}<WorkspaceServiceAccounts {workspace} {disabled} />{/key}
  {/if}
</div>
