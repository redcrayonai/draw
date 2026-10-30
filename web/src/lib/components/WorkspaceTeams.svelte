<script lang="ts">
  import { workspaceTeams, workspaceMembers, workspaceTeamMembers, managesWorkspace, memberLabel, type Workspace } from '$lib/workspaces';
  import { callReducer } from '$lib/reducer';
  import Button from './Button.svelte';
  let { workspace, disabled = false }: { workspace: Workspace; disabled?: boolean } = $props();
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  const teams = $derived($workspaceTeams.filter(team => team.workspaceId === workspace.id));
  const members = $derived($workspaceMembers.filter(member => member.workspaceId === workspace.id && member.role !== 'guest'));
  const admin = $derived(managesWorkspace(workspace));
  async function run(operation: Parameters<typeof callReducer>[0]) {
    busy = true;
    error = '';
    try { await callReducer(operation); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    await run(c => c.reducers.createWorkspaceTeam({ workspaceId: workspace.id, name: name.trim() }));
    if (!error) name = '';
  }
</script>
<section class="workspace-panel" aria-label="Teams">
  {#if admin}
    <form class="workspace-fields" onsubmit={create} aria-label="Create team">
      <label class="workspace-field">Team name<input bind:value={name} maxlength="100" disabled={disabled || busy} /></label>
      <Button type="submit" disabled={disabled || busy || !name.trim()}>create team</Button>
    </form>
  {/if}
  {#each teams as team (team.id)}
    <details>
      <summary>{team.name}</summary>
      {#if admin}
        <form class="workspace-fields" onsubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const next = String(data.get('name') ?? '').trim(); if (next) void run(c => c.reducers.renameWorkspaceTeam({ teamId: team.id, name: next })); }}>
          <label class="workspace-field">Team name<input name="name" value={team.name} maxlength="100" disabled={disabled || busy} /></label>
          <Button disabled={disabled || busy} type="submit">rename team</Button>
          <Button disabled={disabled || busy} type="button" onclick={() => run(c => c.reducers.deleteWorkspaceTeam({ teamId: team.id }))}>delete team</Button>
        </form>
      {/if}
      <div class="workspace-list">
        {#each members as member (member.id)}
          {@const included = $workspaceTeamMembers.some(row => row.teamId === team.id && row.member.toHexString() === member.member.toHexString())}
          {#if admin}<label class="workspace-check"><input type="checkbox" checked={included} disabled={disabled || busy} onchange={e => run(c => c.reducers.setWorkspaceTeamMember({ teamId: team.id, member: member.member, enabled: e.currentTarget.checked }))} />{memberLabel(member)}</label>
          {:else if included}<span class="workspace-name">{memberLabel(member)}</span>{/if}
        {/each}
      </div>
    </details>
  {:else}<p class="workspace-hint">No teams yet. Teams give a group of members access to the same boards.</p>{/each}
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</section>
