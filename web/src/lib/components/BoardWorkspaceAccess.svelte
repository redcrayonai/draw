<script lang="ts">
  import { callReducer } from '$lib/reducer';
  import { workspaceMembers, workspaceTeams, workspaceBoardGrants, workspaceTeamGrants, memberLabel, type Workspace, type BoardPermission } from '$lib/workspaces';
  import Button from './Button.svelte';
  import WorkspaceInvites from './WorkspaceInvites.svelte';
  let { boardId, permission, workspaces, disabled = false }: { boardId: bigint; permission?: BoardPermission; workspaces: Workspace[]; disabled?: boolean } = $props();
  const workspaceId = $derived(permission?.workspaceId ?? 0n);
  const workspace = $derived(workspaces.find(workspace => workspace.id === workspaceId));
  const members = $derived.by(() => {
    const roster = $workspaceMembers.filter(member => member.workspaceId === workspaceId);
    const collaborators = new Map(roster.map(member => [member.member.toHexString(), member]));
    // Guest managers see a private roster, but can still manage everyone already granted this board.
    for (const grant of $workspaceBoardGrants.filter(grant => grant.boardId === boardId)) {
      const identity = grant.member.toHexString();
      if (!collaborators.has(identity)) collaborators.set(identity, { id: grant.id, workspaceId, member: grant.member, name: '', role: 'board collaborator' });
    }
    return [...collaborators.values()];
  });
  const teams = $derived.by(() => {
    const visible = $workspaceTeams.filter(team => team.workspaceId === workspaceId);
    const shared = new Map(visible.map(team => [team.id, team]));
    for (const grant of $workspaceTeamGrants.filter(grant => grant.boardId === boardId)) {
      if (!shared.has(grant.teamId)) shared.set(grant.teamId, { id: grant.teamId, workspaceId, name: `Team ${grant.teamId}` });
    }
    return [...shared.values()];
  });
  const destinations = $derived(workspaces.filter(workspace => workspace.role !== 'guest' && workspace.id !== workspaceId));
  let destination = $state('');
  // A shared workspace has no owner whose code consent the board follows, so the move removes stored snippets (RC-690).
  const destinationShared = $derived(destinations.some(workspace => workspace.id.toString() === destination && !workspace.personal));
  let confirmed = $state(false);
  let busy = $state(false);
  let error = $state('');
  const roles = ['viewer', 'editor', 'manager'];
  async function run(operation: Parameters<typeof callReducer>[0]) {
    if (busy) return;
    busy = true;
    error = '';
    try { await callReducer(operation); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function move(e: SubmitEvent) {
    e.preventDefault();
    if (!destination || !confirmed || busy) return;
    const workspaceId = BigInt(destination);
    await run(c => c.reducers.moveBoardToWorkspace({ boardId, workspaceId }));
    if (!error) { destination = ''; confirmed = false; }
  }
</script>
<details class="board-workspace workspace-panel">
  <summary>{workspace ? `Access · ${workspace.name}` : 'Move to a workspace'}</summary>
  {#if workspace}
    <p class="workspace-hint">Owners and admins manage this board. Other people receive the strongest role granted below. Guests need individual board access.</p>
    {#if !workspace.personal}
      <label class="workspace-field">Workspace members
        <select value={permission?.defaultRole ?? 'none'} disabled={disabled || busy} onchange={e => run(c => c.reducers.setWorkspaceBoardAccess({ boardId, role: e.currentTarget.value }))}>
          <option value="none">Private · invited people and teams</option><option value="viewer">Everyone can view</option><option value="editor">Everyone can edit</option>
        </select>
      </label>
    {/if}
    <div class="workspace-list">
      {#each teams as team (team.id)}
        {@const grant = $workspaceTeamGrants.find(grant => grant.boardId === boardId && grant.teamId === team.id)}
        <label class="workspace-row"><span class="workspace-name">Team · {team.name}</span>
          <select aria-label={`Board role for team ${team.name}`} value={grant?.role ?? ''} disabled={disabled || busy} onchange={e => run(c => c.reducers.setWorkspaceBoardTeam({ boardId, teamId: team.id, role: e.currentTarget.value }))}>
            <option value="">No team grant</option>{#each roles as role}<option value={role}>{role}</option>{/each}
          </select>
        </label>
      {/each}
      {#each members as member (member.member.toHexString())}
        {@const grant = $workspaceBoardGrants.find(grant => grant.boardId === boardId && grant.member.toHexString() === member.member.toHexString())}
        <label class="workspace-row"><span class="workspace-name">{memberLabel(member)} · {member.role}</span>
          <select aria-label={`Board role for ${memberLabel(member)}`} value={grant?.role ?? ''} disabled={disabled || busy} onchange={e => run(c => c.reducers.setWorkspaceBoardMember({ boardId, member: member.member, role: e.currentTarget.value }))}>
            <option value="">No individual grant</option>{#each roles as role}<option value={role}>{role}</option>{/each}
          </select>
        </label>
      {/each}
    </div>
    <details><summary>Invite someone to this board</summary><WorkspaceInvites {workspaceId} {boardId} disabled={disabled || busy} /></details>
  {/if}
  {#if destinations.length}
    <details open={!workspace}>
      <summary>Move board</summary>
      <p class="workspace-hint">Moves this board and its related architecture versions and branches. Existing board links stay the same. Membership, team, and individual access grants are reset for the destination.</p>
      <form onsubmit={move}>
        <label class="workspace-field">Destination workspace<select bind:value={destination} disabled={disabled || busy}><option value="">Choose a workspace</option>{#each destinations as workspace (workspace.id)}<option value={workspace.id.toString()}>{workspace.name}</option>{/each}</select></label>
        <label class="workspace-check"><input type="checkbox" bind:checked={confirmed} disabled={disabled || busy} />{destinationShared ? 'I understand that existing access grants will be reset and stored code snippets will be removed.' : 'I understand that existing access grants will be reset.'}</label>
        <Button type="submit" disabled={disabled || busy || !destination || !confirmed}>move board</Button>
      </form>
    </details>
  {/if}
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</details>
<style>
  .board-workspace { position: relative; z-index: 1; padding: 12px 0 0; border: 0; border-top: 1px solid var(--rc-divider); border-radius: 0; margin-top: 12px; background: transparent; }
  .board-workspace > summary { margin-bottom: 8px; }
  form { display: flex; align-items: flex-start; flex-direction: column; gap: 12px; }
</style>
