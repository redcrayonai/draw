<script lang="ts">
  import { authenticatedHref } from '$lib/session';
  import type { Team } from '$lib/api-types';
  import type { ArchitectureVersion } from '$lib/history';
  import { accessLabel, ago, canvasHref, cardState, idTail, isEpoch, plural, shareLink, type MyBoard } from '$lib/boards';
  import type { Workspace, BoardPermission } from '$lib/workspaces';
  import BoardWorkspaceAccess from './BoardWorkspaceAccess.svelte';
  import BoardVersions from './BoardVersions.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  let { board, permission, workspaces = [], slug = '', teams = [], onclose, onshare, onlink, onrename, ondelete, version, disabled = false, agents = [], granted = [], onagent }: {
    board: MyBoard;
    permission?: BoardPermission;
    workspaces?: Workspace[];
    /** the board's #b= link id; no link until it arrives */
    slug?: string;
    teams?: Team[];
    /** hides the inspector */
    onclose?: () => void;
    version?: ArchitectureVersion;
    /** owner cards only; rejects with the reducer's sentence */
    onshare?: (orgId: string, share: boolean) => Promise<void>;
    /** owner cards only; null stops sharing; rejects with the reducer's sentence */
    onlink?: (mode: 'view' | 'edit' | null) => Promise<void>;
    onrename?: (name: string) => Promise<void>;
    ondelete?: () => Promise<void>;
    disabled?: boolean;
    /** hex ids of the agents the owner linked */
    agents?: string[];
    /** hex ids of the agents that hold a grant on this board */
    granted?: string[];
    /** owner cards only; rejects with the reducer's sentence */
    onagent?: (agent: string, grant: boolean) => Promise<void>;
  } = $props();
  const manager = $derived(permission?.canManage ?? board.access === 'owner');
  const native = $derived(permission?.workspaceId !== undefined && permission.workspaceId !== 0n);
  const workspace = $derived(workspaces.find(workspace => workspace.id === permission?.workspaceId));
  const kind = $derived(cardState(board));
  const href = $derived(slug ? authenticatedHref(canvasHref(slug)) : undefined);
  const intent = $derived(version?.assertionMode === 'intent');
  const refs = $derived(board.refsOk + board.refsStale + board.refsAmbiguous);
  const empty = $derived(board.shownNodes === 0 && board.shownEdges === 0);
  // shares with teams the owner has left: the module still lets the owner take them back
  const leftOrgs = $derived(board.sharedWith.filter((id) => !teams.some((t) => t.id === id)));
  let shareError = $state('');
  let agentError = $state('');
  let linkError = $state('');
  let copied = $state(false);
  const link = $derived(board.linkToken ? shareLink(board.linkToken) : '');
  let action = $state<'rename' | 'delete' | null>(null);
  let name = $state('');
  let confirmation = $state('');
  let busy = $state(false);
  let actionError = $state('');
  let input = $state<HTMLInputElement>();
  $effect(() => input?.focus());

  function manage(next: 'rename' | 'delete' | null) {
    if (busy) return;
    name = board.name;
    confirmation = '';
    actionError = '';
    action = next;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || disabled || !action) return;
    if (action === 'rename' ? !name.trim() || name.trim() === board.name : confirmation !== board.name) return;
    busy = true;
    actionError = '';
    try {
      if (action === 'rename') await onrename?.(name.trim());
      else await ondelete?.();
      action = null;
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggle(orgId: string, share: boolean) {
    shareError = '';
    try {
      await onshare?.(orgId, share);
    } catch (e) {
      shareError = e instanceof Error ? e.message : String(e);
    }
  }

  async function setLink(mode: 'view' | 'edit' | null) {
    linkError = '';
    try {
      await onlink?.(mode);
    } catch (e) {
      linkError = e instanceof Error ? e.message : String(e);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      linkError = 'Copy failed. Select the link and copy it.';
    }
  }

  async function toggleAgent(agent: string, grant: boolean) {
    agentError = '';
    try {
      await onagent?.(agent, grant);
    } catch (e) {
      agentError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="card" data-testid="board-card">
  <div class="head">
    <h2 class="name">{board.name}</h2>
    {#if onclose}<button class="close" aria-label="Close details" onclick={onclose}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>{/if}
  </div>
  <div class="badges">
    <Badge label={native ? `${permission?.role || 'viewer'}${workspace ? ` · ${workspace.name}` : ''}` : accessLabel(board, teams)} agent={board.access === 'agent'} />
    {#if version}<Badge label={intent ? 'intent' : 'snapshot'} />{/if}
  </div>
  <div class="open">
    {#if href}<Button variant="primary" {href}>Open in canvas</Button>{/if}
    {#if !isEpoch(board.updatedAt)}<span class="when num">updated {ago(board.updatedAt.toDate())}</span>{/if}
  </div>

  <dl class="facts num">
    {#if intent}<dt>Proposal</dt><dd>{version?.status}</dd>{/if}
    <dt>Contents</dt><dd>{!board.statsReady ? 'Counts are not computed for this board yet.' : empty ? 'empty board' : `${plural(board.shownNodes, 'node')} · ${plural(board.shownEdges, 'edge')}${refs > 0 ? ` · ${plural(refs, 'code ref')}` : ''}`}</dd>
    {#if kind === 'session'}<dt>Session</dt><dd>{board.sessionCheckpoint ? `checkpoint ${board.sessionCheckpoint}` : 'no checkpoint yet'}{isEpoch(board.sessionUpdatedAt) ? '' : ` · ${ago(board.sessionUpdatedAt.toDate())}`}</dd>{/if}
    {#if version && !intent}<dt>Version</dt><dd>{version.ref} · {version.sha.slice(0, 7)}</dd>{/if}
  </dl>

  {#if manager && !version && (onrename || ondelete)}
    <div class="manage">
      {#if action}
        <form aria-label={`${action === 'rename' ? 'Rename' : 'Delete'} ${board.name}`} onsubmit={submit}>
          {#if action === 'rename'}
            <label class="field"><span>Board name</span><input bind:this={input} bind:value={name} maxlength="100" disabled={busy || disabled} onkeydown={(e) => e.key === 'Escape' && manage(null)} /></label>
          {:else}
            <p class="prose">Delete “{board.name}” and its drawing permanently? This cannot be undone.</p>
            <label class="field"><span>Board name to confirm deletion</span><input bind:this={input} bind:value={confirmation} placeholder={board.name} disabled={busy || disabled} onkeydown={(e) => e.key === 'Escape' && manage(null)} /></label>
          {/if}
          <div class="actions">
            <Button type="button" disabled={busy} onclick={() => manage(null)}>cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || disabled || (action === 'rename' ? !name.trim() || name.trim() === board.name : confirmation !== board.name)}>{busy ? action === 'rename' ? 'saving…' : 'deleting…' : action === 'rename' ? 'save name' : 'delete permanently'}</Button>
          </div>
          {#if actionError}<p class="alert" role="alert">{actionError}</p>{/if}
        </form>
      {:else}
        <div class="actions">
          {#if onrename}<Button variant="ghost" disabled={disabled} aria-label={`Rename ${board.name}`} onclick={() => manage('rename')}>rename</Button>{/if}
          {#if ondelete}<Button variant="ghost" disabled={disabled} aria-label={`Delete ${board.name}`} onclick={() => manage('delete')}>delete</Button>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if manager && !native && onshare && (teams.length > 0 || board.sharedWith.length > 0)}
    <details class="share">
      <summary>
        {board.sharedWith.length ? `shared with ${plural(board.sharedWith.length, 'team')}` : 'share with a team'}
        <svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
      </summary>
      <div class="share-list">
        {#each teams as t (t.id)}
          {@const on = board.sharedWith.includes(t.id)}
          <Button {disabled} onclick={() => toggle(t.id, !on)}>{on ? `unshare from ${t.name}` : `share with ${t.name}`}</Button>
        {/each}
        {#each leftOrgs as orgId (orgId)}
          <Button {disabled} onclick={() => toggle(orgId, false)}>unshare from team {orgId}</Button>
        {/each}
      </div>
      {#if shareError}<p class="alert" role="alert">{shareError}</p>{/if}
    </details>
  {/if}

  {#if manager && onlink && version?.assertionMode !== 'fact'}
    <details class="share">
      <summary>
        {board.linkMode ? `shared by link · can ${board.linkMode}` : 'share with a link'}
        <svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
      </summary>
      {#if board.linkMode}
        <div class="share-list">
          <Button {disabled} aria-pressed={board.linkMode === 'view'} onclick={() => setLink('view')}>can view</Button>
          <Button {disabled} aria-pressed={board.linkMode === 'edit'} onclick={() => setLink('edit')}>can edit</Button>
        </div>
        <div class="share-list">
          <input class="link num" readonly value={link} aria-label="Share link" onfocus={(e) => e.currentTarget.select()} />
          <Button onclick={copyLink}>{copied ? 'copied ✓' : 'copy'}</Button>
          <Button variant="ghost" {disabled} onclick={() => setLink(null)}>stop sharing</Button>
        </div>
      {:else}
        <div class="share-list">
          <Button {disabled} onclick={() => setLink('view')}>turn on link sharing</Button>
        </div>
        <p class="prose faint">Anyone with the link can view. Editing needs sign-in.</p>
      {/if}
      {#if linkError}<p class="alert" role="alert">{linkError}</p>{/if}
    </details>
  {/if}

  {#if (board.access === 'owner' || (native && permission?.canEdit && board.access !== 'link')) && onagent && agents.length > 0}
    <details class="share">
      <summary>
        {granted.length ? `shared with ${plural(granted.length, 'agent')}` : 'share with an agent'}
        <svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
      </summary>
      <div class="share-list">
        {#each agents as agent (agent)}
          {@const on = granted.includes(agent)}
          <Button {disabled} onclick={() => toggleAgent(agent, !on)}>{on ? `remove agent ${idTail(agent)}` : `let agent ${idTail(agent)} edit`}</Button>
        {/each}
      </div>
      {#if agentError}<p class="alert" role="alert">{agentError}</p>{/if}
    </details>
  {/if}
  {#if native && permission}
    <BoardVersions boardId={board.boardId} workspaceId={permission.workspaceId} canEdit={permission.canEdit} {disabled} />
  {/if}
  {#if manager && workspaces.length}
    <BoardWorkspaceAccess boardId={board.boardId} {permission} {workspaces} {disabled} />
  {/if}
</div>

<style>
  .card { display: flex; flex-direction: column; gap: 12px; padding: 18px; }
  .head { display: flex; align-items: flex-start; gap: 8px; }
  .name { flex: 1; min-width: 0; margin: 0; font: 600 16px/1.3 var(--rc-sans); color: var(--rc-ink); overflow-wrap: anywhere; }
  .close { display: grid; place-items: center; flex: none; width: 28px; height: 28px; margin: -4px -6px 0 0; padding: 0; border: 0; border-radius: var(--rc-r-sm);
    background: transparent; color: var(--rc-muted); cursor: pointer; }
  .close:hover { color: var(--rc-ink); background: var(--rc-hover); }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .open { display: flex; align-items: center; gap: 12px; }
  .when { font: 400 12px/1 var(--rc-sans); color: var(--rc-faint); }
  .facts { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px 12px; margin: 4px 0 0; padding-top: 14px; border-top: 1px solid var(--rc-divider);
    font: 400 13px/1.4 var(--rc-sans); }
  .facts dt { color: var(--rc-muted); }
  .facts dd { margin: 0; color: var(--rc-ink); overflow-wrap: anywhere; }
  .prose { font: 400 12px/1.5 var(--rc-sans); color: var(--rc-muted); margin: 12px 0 0; }
  .prose.faint { color: var(--rc-faint); }
  .manage, .share { padding-top: 12px; border-top: 1px solid var(--rc-divider); }
  .share summary { display: flex; align-items: center; gap: 6px; min-height: 28px; list-style: none;
    cursor: pointer; font: 500 13px/1 var(--rc-sans); color: var(--rc-ink); border-radius: var(--rc-r-sm);
    transition: color var(--rc-dur) var(--rc-ease); }
  .share summary::-webkit-details-marker { display: none; }
  .share summary:hover { color: var(--rc-ink); }
  .chev { margin-left: auto; color: var(--rc-faint); transition: transform var(--rc-dur) var(--rc-ease); }
  .share[open] .chev { transform: rotate(90deg); }
  .share-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .share .link { flex: 1 1 24ch; min-width: 0; font: 12px/1 var(--rc-mono); color: var(--rc-muted); background: transparent;
    border: 1px solid var(--rc-divider); border-radius: var(--rc-r-md); padding: 7px 8px; text-overflow: ellipsis; }
  .alert { margin-top: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .manage form .prose { margin: 0 0 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font: 500 12px/1.5 var(--rc-sans); color: var(--rc-muted); }
  input { width: 100%; min-width: 0; box-sizing: border-box; height: 36px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised); padding: 0 12px; font: 400 13px/1 var(--rc-sans); color: var(--rc-ink); }
  .card :global(details.board-workspace) { padding: 12px 0 0; border: 0; border-top: 1px solid var(--rc-divider); border-radius: 0; background: none; }
</style>
