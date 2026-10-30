<script lang="ts">
  import { Timestamp } from 'spacetimedb';
  import { identityHex } from '$lib/stdb';
  import { plural } from '$lib/boards';
  import { callReducer } from '$lib/reducer';
  import { newWorkspaceApiKey } from '$lib/service-keys';
  import { workspaceApiKeys, managesWorkspace, type Workspace, type WorkspaceServiceAccount, type WorkspaceApiKey } from '$lib/workspaces';
  import Button from './Button.svelte';
  import ServiceAccountScope from './ServiceAccountScope.svelte';
  let { account, workspace, boards, disabled = false }: { account: WorkspaceServiceAccount; workspace: Workspace; boards: { boardId: bigint; name: string }[]; disabled?: boolean } = $props();
  let name = $state('');
  let role = $state('viewer');
  let allBoards = $state(true);
  let boardIds = $state<string[]>([]);
  let accountDisabled = $state(false);
  let keyName = $state('');
  let keyRole = $state('viewer');
  let keyAllBoards = $state(true);
  let keyBoardIds = $state<string[]>([]);
  let expires = $state('');
  let secret = $state('');
  let copied = $state(false);
  let busy = $state(false);
  let error = $state('');
  let rotation = $state('');
  const keys = $derived($workspaceApiKeys.filter(key => key.serviceAccountId === account.id));
  const accountBoards = $derived(boards.filter(board => account.allBoards || account.boardIds.includes(board.boardId)));
  const blocked = $derived(disabled || busy);
  $effect(() => {
    name = account.name;
    role = account.role;
    allBoards = account.allBoards;
    boardIds = account.boardIds.map(String);
    accountDisabled = account.disabled;
  });
  $effect(() => {
    // A mounted shared-workspace panel can survive a switch between two admins.
    void $identityHex;
    void workspace.id;
    void workspace.role;
    secret = '';
    copied = false;
  });
  $effect(() => { if (account.role === 'viewer') keyRole = 'viewer'; });
  async function run(operation: Parameters<typeof callReducer>[0]) {
    if (blocked) return false;
    busy = true;
    error = '';
    try { await callReducer(operation); return true; }
    catch (e) { error = e instanceof Error ? e.message : String(e); return false; }
    finally { busy = false; }
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || (!accountDisabled && !allBoards && !boardIds.length)) return;
    // Disabling still works after every selected board has moved out of the workspace.
    const preserveScope = accountDisabled && !allBoards && !boardIds.length;
    await run(c => c.reducers.updateWorkspaceServiceAccount({ serviceAccountId: account.id, name: name.trim(), role, allBoards: preserveScope ? account.allBoards : allBoards, boardIds: preserveScope ? account.boardIds : allBoards ? [] : boardIds.map(BigInt), disabled: accountDisabled }));
  }
  async function createKey(e: SubmitEvent) {
    e.preventDefault();
    if (blocked || account.disabled || !keyName.trim() || (!keyAllBoards && !keyBoardIds.length)) return;
    secret = '';
    copied = false;
    busy = true;
    error = '';
    const identity = $identityHex, workspaceId = workspace.id;
    try {
      const { keyId, keyHash, token } = await newWorkspaceApiKey();
      const expiresAt = expires ? new Timestamp(BigInt(new Date(expires).getTime()) * 1000n) : undefined;
      if (identity !== $identityHex || workspaceId !== workspace.id || !managesWorkspace(workspace)) return;
      await callReducer(c => c.reducers.createWorkspaceApiKey({ serviceAccountId: account.id, keyId, keyHash, name: keyName.trim(), role: keyRole, allBoards: keyAllBoards, boardIds: keyAllBoards ? [] : keyBoardIds.map(BigInt), expiresAt }));
      if (identity === $identityHex && workspaceId === workspace.id && managesWorkspace(workspace)) {
        secret = token;
        keyName = '';
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function copy() {
    error = '';
    try { await navigator.clipboard.writeText(secret); copied = true; }
    catch { error = 'Select the API key and copy it.'; }
  }
  function rotate(key: WorkspaceApiKey) {
    secret = '';
    copied = false;
    keyName = `${key.name} replacement`.slice(0, 100);
    keyRole = account.role === 'viewer' ? 'viewer' : key.role;
    keyAllBoards = key.allBoards;
    keyBoardIds = key.boardIds.filter(id => accountBoards.some(board => board.boardId === id)).map(String);
    expires = '';
    rotation = key.name;
  }
</script>
<details ontoggle={e => { if (!e.currentTarget.open) { secret = ''; copied = false; } }}>
  <summary>{account.name}</summary>
  <p class="workspace-hint">{account.disabled ? 'Disabled · all keys are blocked.' : `${account.role === 'editor' ? 'Edit' : 'Read'} · ${account.allBoards ? 'all workspace boards' : plural(account.boardIds.length, 'selected board')}`}</p>
  <form aria-label={`Edit service account ${account.name}`} onsubmit={save}>
    <label class="workspace-field">Account name<input bind:value={name} maxlength="100" disabled={blocked} /></label>
    <ServiceAccountScope label="Account" bind:role bind:allBoards bind:boardIds {boards} disabled={blocked} />
    <label class="workspace-check"><input type="checkbox" bind:checked={accountDisabled} disabled={blocked} />Disable service account</label>
    <Button type="submit" disabled={blocked || !name.trim() || (!accountDisabled && !allBoards && !boardIds.length)}>save</Button>
  </form>
  <h3>API keys</h3>
  <p class="workspace-hint">Every key is limited by this account’s current access. Create a replacement before revoking an old key.</p>
  <div class="workspace-list">
    {#each keys as key (key.id)}
      {@const expired = key.expiresAt && key.expiresAt.toDate().getTime() <= Date.now()}
      <div class="workspace-row">
        <span class="workspace-name">{key.name} · {key.role === 'editor' ? 'edit' : 'read'} · {key.allBoards ? 'all account boards' : plural(key.boardIds.length, 'selected board')}<br /><span class="workspace-hint">{key.revoked ? 'Revoked' : expired ? 'Expired' : key.expiresAt ? `Expires ${key.expiresAt.toDate().toLocaleString()}` : 'No expiry'}</span></span>
        {#if !key.revoked}<Button aria-label={`rotate ${key.name}`} disabled={blocked || account.disabled} onclick={() => rotate(key)}>rotate</Button><Button aria-label={`revoke ${key.name}`} disabled={blocked} onclick={() => run(c => c.reducers.revokeWorkspaceApiKey({ keyId: key.id }))}>revoke</Button>{/if}
      </div>
    {:else}<p class="workspace-hint">No API keys yet.</p>{/each}
  </div>
  <form aria-label={`Create API key for ${account.name}`} onsubmit={createKey}>
    {#if rotation}<p class="workspace-hint">Create the replacement for {rotation}, update your automation, then revoke the old key.</p>{/if}
    <label class="workspace-field">Key name<input bind:value={keyName} maxlength="100" disabled={blocked || account.disabled} placeholder="CI production" /></label>
    <ServiceAccountScope label="Key" bind:role={keyRole} bind:allBoards={keyAllBoards} bind:boardIds={keyBoardIds} boards={accountBoards} editor={account.role === 'editor'} disabled={blocked || account.disabled} />
    <label class="workspace-field">Expires at (optional)<input type="datetime-local" bind:value={expires} disabled={blocked || account.disabled} /></label>
    <Button type="submit" disabled={blocked || account.disabled || !keyName.trim() || (!keyAllBoards && !keyBoardIds.length)}>create API key</Button>
  </form>
  {#if secret}
    <div class="new-key" role="status">
      <p class="workspace-hint">Save this API key now. You will not be able to see it again.</p>
      <label class="workspace-field">New API key<input class="workspace-invite-url" readonly value={secret} spellcheck="false" autocomplete="off" /></label>
      <div class="workspace-fields"><Button onclick={copy}>{copied ? 'copied' : 'copy API key'}</Button><Button onclick={() => { secret = ''; copied = false; }}>I saved this key</Button></div>
    </div>
  {/if}
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</details>
<style>
  details { border-top: 1px solid var(--rc-divider); padding-top: 16px; overflow-wrap: anywhere; }
  form { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin-top: 16px; }
  h3 { margin-top: 24px; }
  .new-key { margin-top: 16px; padding: 12px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); }
  .new-key .workspace-fields { margin-top: 12px; }
  .new-key input { min-width: 0; }
</style>
