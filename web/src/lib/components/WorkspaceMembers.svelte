<script lang="ts">
  import { workspaceMembers, workspaceTeams, workspaceTeamMembers, managesWorkspace, memberLabel, type Workspace } from '$lib/workspaces';
  import { callReducer } from '$lib/reducer';
  import { identityHex } from '$lib/stdb';
  import type { Identity } from 'spacetimedb';
  import Button from './Button.svelte';
  let { workspace, disabled = false, query = '' }: { workspace: Workspace; disabled?: boolean; query?: string } = $props();
  const members = $derived($workspaceMembers.filter(member => member.workspaceId === workspace.id));
  // you first, then by name
  const shown = $derived(members
    .filter(member => memberLabel(member).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.member.toHexString() === $identityHex) - Number(a.member.toHexString() === $identityHex) || memberLabel(a).localeCompare(memberLabel(b))));
  const teams = $derived($workspaceTeams.filter(team => team.workspaceId === workspace.id));
  const admin = $derived(managesWorkspace(workspace));
  const owners = $derived(members.filter(member => member.role === 'owner').length);
  let busy = $state(false);
  let error = $state('');
  async function setRole(member: Identity, role: string) {
    busy = true;
    error = '';
    try { await callReducer(c => c.reducers.setWorkspaceMember({ workspaceId: workspace.id, member, role })); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  const teamsOf = (member: Identity) => teams.filter(team => $workspaceTeamMembers.some(row => row.teamId === team.id && row.member.toHexString() === member.toHexString()));
</script>
<section class="workspace-panel" aria-label="Members">
  <table class="workspace-table">
    <thead><tr><th>Name</th><th>Role</th><th>Teams</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>
      {#each shown as member (member.id)}
        {@const me = member.member.toHexString() === $identityHex}
        {@const lastOwner = member.role === 'owner' && owners <= 1}
        {@const editable = admin && !workspace.personal && (workspace.role === 'owner' || !['owner', 'admin'].includes(member.role))}
        <tr>
          <td><span class="who"><span class="avatar" aria-hidden="true">{memberLabel(member).trim().charAt(0).toUpperCase()}</span><span class="workspace-name">{memberLabel(member)}{me ? ' (you)' : ''}</span></span></td>
          <td>
            {#if editable}
              <select aria-label={`Role for ${memberLabel(member)}`} value={member.role} disabled={disabled || busy || lastOwner} onchange={e => setRole(member.member, e.currentTarget.value)}>
                {#if workspace.role === 'owner'}<option value="owner">Owner</option><option value="admin">Admin</option>{/if}
                <option value="member">Member</option><option value="guest">Guest</option>
              </select>
            {:else}<span class="role">{member.role}</span>{/if}
          </td>
          <td>{#each teamsOf(member.member) as team (team.id)}<span class="chip">{team.name}</span>{:else}<span class="none">None</span>{/each}</td>
          <td class="end">
            {#if !lastOwner && (editable || me || (admin && member.role === 'guest'))}
              <Button variant="ghost" disabled={disabled || busy} onclick={() => setRole(member.member, '')}>{me ? 'leave workspace' : `remove ${memberLabel(member)}`}</Button>
            {/if}
          </td>
        </tr>
      {:else}<tr><td colspan="4" class="none">{members.length ? `No members match “${query.trim()}”.` : 'No visible members.'}</td></tr>{/each}
    </tbody>
  </table>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</section>
<style>
  .who { display: flex; align-items: center; gap: 10px; }
  .avatar { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%;
    background: var(--rc-hover); border: 1px solid var(--rc-border); font: 600 10px/1 var(--rc-sans); color: var(--rc-ink); }
  .role { text-transform: capitalize; }
  .chip { display: inline-block; margin-right: 4px; font: 500 11px/1 var(--rc-sans); color: var(--rc-muted); background: var(--rc-raised);
    border: 1px solid var(--rc-divider); border-radius: var(--rc-r-xs); padding: 4px 6px; }
  .none { color: var(--rc-muted); }
  .end { text-align: right; }
</style>
