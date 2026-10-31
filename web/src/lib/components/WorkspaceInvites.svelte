<script lang="ts">
  import { config } from '$lib/config';
  import { callReducer } from '$lib/reducer';
  import { newShareToken } from '$shared/share-link';
  import { workspaceInvites, inviteHref } from '$lib/workspaces';
  import Button from './Button.svelte';
  let { workspaceId, boardId = 0n, owner = false, disabled = false }: { workspaceId: bigint; boardId?: bigint; owner?: boolean; disabled?: boolean } = $props();
  let role = $state('member');
  $effect(() => { role = boardId === 0n ? 'member' : 'viewer'; });
  let busy = $state(false);
  let error = $state('');
  let copied = $state('');
  const database = config.spacetimeDb === import.meta.env.VITE_SPACETIME_DB ? '' : config.spacetimeDb;
  const invites = $derived($workspaceInvites.filter(invite => invite.workspaceId === workspaceId && invite.boardId === boardId));
  async function create() {
    if (busy) return;
    busy = true;
    error = '';
    try { await callReducer(c => c.reducers.createWorkspaceInvite({ workspaceId, boardId, role, token: newShareToken() })); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function revoke(token: string) {
    error = '';
    try { await callReducer(c => c.reducers.revokeWorkspaceInvite({ token })); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function copy(token: string) {
    error = '';
    try { await navigator.clipboard.writeText(inviteHref(token, location.origin, database)); copied = token; }
    catch { error = 'Copy failed. Select the invitation link below and copy it.'; }
  }
</script>
<div>
  <p class="workspace-hint">Invitation links can be used once and expire after seven days. Anyone with the link can accept it after signing in.</p>
  <div class="workspace-fields">
    <label class="workspace-field">Invitation role
      <select bind:value={role} disabled={busy || disabled}>
        {#if boardId === 0n}<option value="member">Member</option>{#if owner}<option value="admin">Admin</option>{/if}
        {:else}<option value="viewer">Viewer</option><option value="editor">Editor</option><option value="manager">Manager</option>{/if}
      </select>
    </label>
    <Button disabled={busy || disabled} onclick={create}>{busy ? 'creating…' : 'create invitation'}</Button>
  </div>
  <div class="workspace-list">
    {#each invites as invite (invite.token)}
      <div class="workspace-row">
        <span class="workspace-name">{invite.role} · expires {invite.expiresAt.toDate().toLocaleDateString()}</span>
        <Button {disabled} onclick={() => copy(invite.token)}>{copied === invite.token ? 'copied' : 'copy invitation'}</Button>
        <Button {disabled} onclick={() => revoke(invite.token)}>revoke invitation</Button>
        <input class="workspace-invite-url" aria-label="Invitation link" readonly value={typeof location === 'undefined' ? '' : inviteHref(invite.token, location.origin, database)} />
      </div>
    {/each}
  </div>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</div>
