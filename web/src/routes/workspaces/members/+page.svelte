<script lang="ts">
  import { page } from '$app/state';
  import { stdbState } from '$lib/stdb';
  import { myWorkspaces, workspaceState, settingsWorkspace, workspaceMembers, workspaceTeams, workspaceInvites, managesWorkspace } from '$lib/workspaces';
  import Button from '$lib/components/Button.svelte';
  import WorkspaceMembers from '$lib/components/WorkspaceMembers.svelte';
  import WorkspaceTeams from '$lib/components/WorkspaceTeams.svelte';
  import WorkspaceInvites from '$lib/components/WorkspaceInvites.svelte';
  // the workspace a page shows comes from its link (?workspace=)
  const chosen = $derived(page.url.searchParams.get('workspace') ?? '');
  const workspace = $derived(settingsWorkspace(chosen, $myWorkspaces));
  const disabled = $derived($stdbState.status !== 'live');
  const admin = $derived(!!workspace && managesWorkspace(workspace));
  const tabs = $derived([
    { id: 'members', label: 'Members', n: $workspaceMembers.filter(row => row.workspaceId === workspace?.id).length },
    ...(workspace?.personal ? [] : [{ id: 'teams', label: 'Teams', n: $workspaceTeams.filter(row => row.workspaceId === workspace?.id).length }]),
    ...(admin && !workspace?.personal ? [{ id: 'invitations', label: 'Invitations', n: $workspaceInvites.filter(row => row.workspaceId === workspace?.id && row.boardId === 0n).length }] : []),
  ]);
  let picked = $state(page.url.searchParams.get('tab') ?? 'members');
  const tab = $derived(tabs.some(t => t.id === picked) ? picked : 'members');
  let query = $state('');
  $effect(() => { void workspace?.id; query = ''; });
  function step(e: KeyboardEvent) {
    const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!move) return;
    const next = tabs[(tabs.findIndex(t => t.id === tab) + move + tabs.length) % tabs.length];
    picked = next.id;
    document.getElementById(`tab-${next.id}`)?.focus();
  }
</script>
<svelte:head><title>{workspace ? `${workspace.name} · ` : ''}Members &amp; access · Draw</title></svelte:head>
<div class="settings">
  {#if workspace}<p class="crumb">{workspace.name} › Settings</p>{/if}
  <header><h1>Members &amp; access</h1><p class="sub">Members see boards shared with them, their teams, or the workspace. Owners and admins manage every workspace board.</p></header>
  {#if $workspaceState === 'unavailable'}
    <p class="alert" role="alert">Workspaces need the latest board server. Update the server and reload.</p>
  {:else if $workspaceState !== 'live'}<p class="workspace-hint" role="status">Loading workspaces…</p>
  {:else if !workspace}
    <p class="workspace-hint">This workspace is not available to you. Choose another one in the sidebar.</p>
  {:else}
    <div class="settings-tabs" role="tablist" aria-label="Members and access" tabindex="-1" onkeydown={step}>
      {#each tabs as t (t.id)}
        <button role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel" tabindex={tab === t.id ? 0 : -1} onclick={() => (picked = t.id)}>{t.label} <span class="n num">{t.n}</span></button>
      {/each}
    </div>
    {#key workspace.id}
      <div id="panel" role="tabpanel" aria-labelledby="tab-{tab}">
        {#if tab === 'members'}
          <div class="settings-toolbar">
            <input type="search" aria-label="Search members" placeholder="Search members" bind:value={query} />
            <span class="grow"></span>
            {#if admin && !workspace.personal}<Button variant="primary" onclick={() => (picked = 'invitations')}>invite members</Button>{/if}
          </div>
          <WorkspaceMembers {workspace} {disabled} {query} />
        {:else if tab === 'teams'}
          <WorkspaceTeams {workspace} {disabled} />
        {:else}
          <WorkspaceInvites workspaceId={workspace.id} owner={workspace.role === 'owner'} {disabled} />
        {/if}
      </div>
    {/key}
  {/if}
</div>
<style>
  input[type='search'] { width: 280px; }
</style>
