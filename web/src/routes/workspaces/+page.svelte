<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { session, signIn } from '$lib/session';
  import { stdbState, myBoards } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { appHref, plural } from '$lib/boards';
  import { myWorkspaces, workspaceState, settingsWorkspace, workspaceMembers, workspaceTeams, workspaceInvites, workspaceServiceAccounts, boardPermissions, pendingInvite, rememberInvite, clearInvite, managesWorkspace } from '$lib/workspaces';
  import Button from '$lib/components/Button.svelte';
  // the workspace a page shows comes from its link (?workspace=)
  const chosen = $derived(page.url.searchParams.get('workspace') ?? '');
  let rename = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let invite = $state('');
  let attempted = $state('');
  const signedIn = $derived($session.status === 'signed-in');
  const workspace = $derived(settingsWorkspace(chosen, $myWorkspaces));
  const disabled = $derived($stdbState.status !== 'live' || busy);
  const id = $derived(workspace?.id.toString() ?? '');
  const members = $derived($workspaceMembers.filter(member => member.workspaceId === workspace?.id).length);
  const teams = $derived($workspaceTeams.filter(team => team.workspaceId === workspace?.id).length);
  const invites = $derived($workspaceInvites.filter(row => row.workspaceId === workspace?.id && row.boardId === 0n).length);
  const accounts = $derived($workspaceServiceAccounts.filter(account => account.workspaceId === workspace?.id).length);
  const boards = $derived($myBoards.filter(board => $boardPermissions.get(board.boardId)?.workspaceId === workspace?.id).length);
  $effect(() => { rename = workspace?.name ?? ''; });
  onMount(() => {
    invite = pendingInvite(location.search);
    if (invite) rememberInvite(invite);
    else if (new URLSearchParams(location.search).has('invite')) error = 'This invitation link is invalid.';
  });
  async function run(operation: Parameters<typeof callReducer>[0]) {
    if (busy) return;
    busy = true;
    error = '';
    try { await callReducer(operation); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function accept() {
    if (!invite || busy) return;
    attempted = invite;
    await run(c => c.reducers.acceptWorkspaceInvite({ token: invite }));
    if (!error) {
      clearInvite();
      invite = '';
      const url = new URL(location.href);
      url.searchParams.delete('invite');
      history.replaceState(history.state, '', url);
      message = 'Invitation accepted. Your access is ready.';
    }
  }
  $effect(() => {
    if (!signedIn || $workspaceState !== 'live' || disabled) return;
    if (invite && attempted !== invite) void accept();
  });
</script>
<svelte:head><title>{workspace ? `${workspace.name} · ` : ''}Workspace settings · Draw</title></svelte:head>
<div class="settings">
  {#if workspace}<p class="crumb">{workspace.name} › Settings</p>{/if}
  <header><h1>General</h1><p class="sub">{workspace ? `Settings for ${workspace.name}. Changes apply to everyone in this workspace.` : 'Keep personal, company, and client boards in their own workspaces.'}</p></header>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message} <a href={appHref('/dashboard')}>Open boards</a></p>{/if}
  {#if invite && attempted === invite && error}<Button disabled={disabled} onclick={accept}>retry invitation</Button>{/if}
  {#if !signedIn}
    <section class="workspace-panel"><p>Sign in to create a workspace or accept an invitation.</p><Button variant="primary" onclick={() => signIn()}>sign in</Button></section>
  {:else if $workspaceState === 'unavailable'}
    <p class="alert" role="alert">Workspaces need the latest board server. Update the server and reload.</p>
  {:else if $workspaceState !== 'live'}<p class="workspace-hint" role="status">Loading workspaces…</p>
  {:else if workspace}
    <div class="general">
      <div class="rows">
        <div class="setting">
          <div><h2>Workspace name</h2><p class="workspace-hint">Shown in the sidebar and on invitations.</p></div>
          {#if managesWorkspace(workspace)}
            <form class="workspace-fields" onsubmit={e => { e.preventDefault(); if (rename.trim()) void run(c => c.reducers.renameWorkspace({ workspaceId: workspace.id, name: rename.trim() })); }}>
              <input aria-label="Workspace name" bind:value={rename} maxlength="100" disabled={disabled} />
              <Button type="submit" disabled={disabled || !rename.trim() || rename.trim() === workspace.name}>rename workspace</Button>
            </form>
          {:else}<p class="value">{workspace.name}</p>{/if}
        </div>
        <div class="setting">
          <div><h2>Type</h2><p class="workspace-hint">{workspace.personal ? 'Personal boards stay separate from company and client work.' : 'Boards belong to this workspace when their creators leave.'}</p></div>
          <p class="value">{workspace.personal ? 'Personal workspace' : 'Shared workspace'}</p>
        </div>
        <div class="setting">
          <div><h2>Your role</h2><p class="workspace-hint">Owners and admins manage members, teams, and every workspace board.</p></div>
          <p class="value role">{workspace.role}</p>
        </div>
      </div>
      <aside class="glance" aria-label="{workspace.name} at a glance">
        <a href={appHref(`/dashboard?workspace=${id}`)}><span>Boards</span><b class="num">{boards}</b></a>
        {#if !workspace.personal}
          <a href={appHref(`/workspaces/members?workspace=${id}`)}><span>Members</span><b class="num">{members}</b></a>
          <a href={appHref(`/workspaces/members?workspace=${id}&tab=teams`)}><span>Teams</span><b class="num">{teams}</b></a>
          {#if managesWorkspace(workspace)}
            <a href={appHref(`/workspaces/members?workspace=${id}&tab=invitations`)}><span>Pending invitations</span><b class="num">{invites}</b></a>
            <a href={appHref(`/workspaces/keys?workspace=${id}`)}><span>Service accounts</span><b class="num">{plural(accounts, 'account')}</b></a>
          {/if}
        {/if}
      </aside>
    </div>
  {:else if chosen}
    <p class="workspace-hint">This workspace is not available to you. Choose another one in the sidebar.</p>
  {:else}
    <p class="workspace-hint">Your personal workspace is being created. You can also <a href={appHref('/workspaces/new')}>create a workspace</a> for your company or client.</p>
  {/if}
</div>
<style>
  .general { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
  .rows { flex: 1 1 520px; max-width: 820px; }
  .setting { display: grid; grid-template-columns: minmax(180px, 280px) minmax(0, 1fr); gap: 12px 32px; align-items: center;
    padding: 18px 0; border-bottom: 1px solid var(--rc-divider); }
  .setting h2 { margin: 0; font: 500 13px/1.4 var(--rc-sans); color: var(--rc-ink); }
  .setting .workspace-hint { margin: 2px 0 0; }
  .value { margin: 0; font: 400 13px/1.4 var(--rc-sans); color: var(--rc-ink); }
  .role { text-transform: capitalize; }
  .glance { flex: 0 1 300px; display: flex; flex-direction: column; border: 1px solid var(--rc-divider); border-radius: var(--rc-r-lg); background: var(--rc-card); padding: 6px 16px; }
  .glance a { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; color: var(--rc-muted); text-decoration: none; }
  .glance a + a { border-top: 1px solid var(--rc-divider); }
  .glance a:hover { color: var(--rc-ink); }
  .glance b { font-weight: 500; color: var(--rc-ink); }
  .notice { font: 400 13px/1.5 var(--rc-sans); padding: 12px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); margin: 0 0 16px; }
  @media (max-width: 600px) { .setting { grid-template-columns: minmax(0, 1fr); } }
</style>
