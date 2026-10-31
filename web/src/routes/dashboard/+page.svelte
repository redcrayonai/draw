<script lang="ts">
  import { page } from '$app/state';
  import { authenticatedHref } from '$lib/session';
  import { stdbState, myBoards, identityHex, myArchitectureHistories, architectureVersions, myAgentLinks, myAgentGrants, boardSlugs, myActivity } from '$lib/stdb';
  import { myWorkspaces, boardPermissions } from '$lib/workspaces';
  import { Identity } from 'spacetimedb';
  import { callReducer } from '$lib/reducer';
  import { createBoard } from '$lib/create-board';
  import { newShareToken } from '$shared/share-link';
  import { session, signIn } from '$lib/session';
  import { config } from '$lib/config';
  import {
    accessFacets,
    ago,
    canvasHref,
    cardState,
    filterBoards,
    grantedAgents,
    linkedAgents,
    plural,
    sortBoards,
    type Sort,
  } from '$lib/boards';
  import { filterFeed } from '$lib/activity';
  import BoardCard from '$lib/components/BoardCard.svelte';
  import BoardTile from '$lib/components/BoardTile.svelte';
  import TagChip from '$lib/components/TagChip.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import Segmented from '$lib/components/Segmented.svelte';
  import ActivityList from '$lib/components/ActivityList.svelte';
  import NewBoardDialog from '$lib/components/NewBoardDialog.svelte';
  import Button from '$lib/components/Button.svelte';
  import ArchitectureHistories from '$lib/components/ArchitectureHistories.svelte';

  // the workspace a page shows comes from its link (?workspace=)
  const chosen = $derived(page.url.searchParams.get('workspace') ?? '');
  const SORTS = ['recent', 'name'] as const;

  let query = $state('');
  let facet = $state('all');
  let sort = $state<Sort>('recent');
  let creating = $state(false);
  let created = $state<{ name: string; boardId: bigint } | null>(null);

  const scopedBoards = $derived(chosen ? $myBoards.filter(board => ($boardPermissions.get(board.boardId)?.workspaceId ?? 0n).toString() === chosen) : $myBoards);
  const facets = $derived(accessFacets(scopedBoards, []));
  const shown = $derived(sortBoards(filterBoards(scopedBoards, query, facet), sort));
  const versionByBoard = $derived(new Map($architectureVersions.map((v) => [v.boardId, v])));
  const workspace = $derived($myWorkspaces.find(workspace => workspace.id.toString() === chosen));
  const scope = $derived(chosen === '0' ? 'outside every workspace' : workspace ? `in ${workspace.name}` : '');
  // sessions an agent checkpointed in the last hour, newest first; the minute tick ages them on a quiet tab
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const sessions = $derived(scopedBoards
    .filter((b) => cardState(b) === 'session' && now - b.sessionUpdatedAt.toDate().getTime() < 3_600_000)
    .sort((a, b) => Number(b.sessionUpdatedAt.microsSinceUnixEpoch - a.sessionUpdatedAt.microsSinceUnixEpoch))
    .slice(0, 3));
  let selected = $state<bigint | null>(null);
  // a different account closes the details; the first identity arriving after a click does not
  let selectedFor = '';
  $effect.pre(() => {
    const id = $identityHex;
    if (selectedFor && id !== selectedFor) selected = null;
    selectedFor = id;
  });
  const selectedBoard = $derived(selected === null ? undefined : scopedBoards.find((b) => b.boardId === selected));
  const names = $derived(new Map($myBoards.map((b) => [b.boardId.toString(), b.name])));
  // the live feed, narrowed to the boards this page shows
  const scopedIds = $derived(new Set(scopedBoards.map((b) => b.boardId.toString())));
  const activity = $derived(filterFeed($myActivity, (e) => scopedIds.has(e.boardId)));
  const gated = $derived($session.status === 'signed-out' && !!config.accounts);
  const destinationWorkspace = $derived($myWorkspaces.find(workspace => workspace.id.toString() === chosen && workspace.role !== 'guest')
    ?? $myWorkspaces.find(workspace => workspace.personal)
    ?? $myWorkspaces.find(workspace => workspace.role !== 'guest'));
  const createDestination = $derived(destinationWorkspace ? `workspace:${destinationWorkspace.id}` : '');
  const agents = $derived(linkedAgents($myAgentLinks, $identityHex).map((l) => l.agent.toHexString()));

  // The new card is highlighted for 6 s, then the class goes and the CSS transition fades it.
  // Keyed on the id (a bigint compares by value), so stats updates do not restart the timer.
  const newId = $derived(created?.boardId);
  // its link id arrives with its my_boards row; open the canvas once it has
  const newSlug = $derived(newId === undefined ? undefined : $boardSlugs.get(newId));
  let lit = $state(false);
  $effect(() => {
    if (newId === undefined || !newSlug) return;
    lit = true;
    location.assign(authenticatedHref(canvasHref(newSlug)));
    const t = setTimeout(() => (lit = false), 6000);
    return () => clearTimeout(t);
  });

  // per-account state: drop it the moment the identity changes (sign-out or a
  // direct account A -> B switch keeps this page mounted)
  $effect.pre(() => {
    void $identityHex;
    created = null;
    creating = false;
  });

  async function create(name: string, orgId: string) {
    const identity = $identityHex;
    const boardId = orgId.startsWith('workspace:')
      ? await createBoard(name, '', BigInt(orgId.slice(10)))
      : await createBoard(name, orgId);
    if ($identityHex !== identity) return;
    created = { name, boardId };
    creating = false;
  }

  const share = (boardId: bigint, orgId: string, on: boolean) =>
    callReducer((c) =>
      on ? c.reducers.shareBoardWithTeam({ boardId, orgId }) : c.reducers.unshareBoardFromTeam({ boardId, orgId })
    );

  const setLink = (boardId: bigint, mode: 'view' | 'edit' | null) =>
    callReducer((c) =>
      mode === null ? c.reducers.stopLinkShare({ boardId }) : c.reducers.setLinkShare({ boardId, mode, token: newShareToken() })
    );
  const shareWithAgent = (boardId: bigint, agentHex: string, on: boolean) => {
    const agent = new Identity(agentHex);
    return callReducer((c) =>
      on ? c.reducers.grantAgentBoard({ boardId, agent }) : c.reducers.revokeAgentBoard({ boardId, agent })
    );
  };
</script>

<svelte:head><title>Boards · Draw</title></svelte:head>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && selected !== null && !(e.target instanceof HTMLInputElement)) selected = null; }} />

<div class="page" class:inspecting={selectedBoard}>
  <section class="content">
    <header class="header">
      <div class="title">
        <h1>Boards</h1>
        <span class="count num">{plural(scopedBoards.length, 'board')}{scope ? ` ${scope}` : ''}{shown.length !== scopedBoards.length ? ` · ${shown.length} shown` : ''}</span>
      </div>
      <div class="tools">
        <SearchBar value={query} oninput={(v) => (query = v)} />
        <Segmented label="Sort" options={SORTS} value={sort} onchange={(v) => (sort = v)} />
        <Button variant="primary" disabled={$stdbState.status !== 'live'} onclick={() => (creating = true)}>new board</Button>
      </div>
    </header>

    {#if creating}
      <NewBoardDialog teams={[]} workspaces={$myWorkspaces} destination={createDestination} {create} onclose={() => (creating = false)} />
    {/if}
    {#if created}
      <div class="notice created" role="status">Created {created.name}.{#if newSlug} <a href={authenticatedHref(canvasHref(newSlug))}>Open in canvas</a>{/if}</div>
    {/if}

    {#if gated}
      <div class="state">
        <p>Sign in to see your boards.</p>
        <Button variant="primary" onclick={() => signIn()}>sign in</Button>
      </div>
    {:else if $stdbState.status === 'error'}
      <div class="alert failed">
        <p role="alert">{$stdbState.error}</p>
        <Button onclick={() => location.reload()}>reload</Button>
      </div>
    {:else if $stdbState.status !== 'live' && $myBoards.length === 0}
      <p class="quiet" role="status">{$stdbState.status === 'reconnecting' ? 'Connection lost. Retrying…' : 'Connecting…'}</p>
      <div class="gallery" aria-hidden="true">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="skel-tile"><span class="skel thumb"></span><span class="skel title"></span><span class="skel line"></span></div>
        {/each}
      </div>
    {:else}
      {#if $stdbState.status === 'reconnecting'}
        <div class="notice" role="status">Connection lost. Showing the last boards received; retrying…</div>
      {/if}
      {#if $myArchitectureHistories.length}
        <ArchitectureHistories
          histories={$myArchitectureHistories}
          versions={$architectureVersions}
          slugs={$boardSlugs}
          disabled={$stdbState.status !== 'live'}
          ondelete={(historyId) => callReducer((c) => c.reducers.deleteArchitectureHistory({ historyId }))}
        />
      {/if}
      <div class="facets" role="group" aria-label="Show">
        {#each facets as f (f.key)}
          <TagChip label={f.label} count={f.count} active={facet === f.key} onclick={() => (facet = f.key)} />
        {/each}
      </div>
      {#if sessions.length}
        <section class="sessions" aria-labelledby="sessions-label">
          <h2 id="sessions-label">Agent sessions</h2>
          <ul>
            {#each sessions as b (b.boardId)}
              {@const slug = $boardSlugs.get(b.boardId)}
              <li>
                <span class="pulse" aria-hidden="true"></span>
                {#if slug}<a href={authenticatedHref(canvasHref(slug))}>{b.name}</a>{:else}<span class="pending">{b.name}</span>{/if}
                <span class="num">{b.sessionCheckpoint ? `checkpoint ${b.sessionCheckpoint}` : 'no checkpoint yet'} · {ago(b.sessionUpdatedAt.toDate())}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <div class="gallery">
        {#each shown as b (b.boardId)}
          <BoardTile
            board={b}
            slug={$boardSlugs.get(b.boardId)}
            version={versionByBoard.get(b.boardId)}
            selected={b.boardId === selected}
            highlight={lit && b.boardId === newId}
            onselect={() => (selected = selected === b.boardId ? null : b.boardId)}
          />
        {:else}
          <div class="state">
            {#if scopedBoards.length === 0}
              <p>No boards yet.</p>
              <Button variant="primary" disabled={$stdbState.status !== 'live'} onclick={() => (creating = true)}>new board</Button>
            {:else if query.trim()}
              <p>No boards match “{query.trim()}”.</p>
              <Button variant="ghost" onclick={() => (query = '')}>clear search</Button>
            {:else}
              <p>No boards match this filter.</p>
              <Button variant="ghost" onclick={() => (facet = 'all')}>show all</Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if !gated}
    <aside class="inspector" aria-label={selectedBoard ? `${selectedBoard.name} details` : 'Activity'}>
      {#if selectedBoard}
        {@const b = selectedBoard}
        {#key b.boardId}
          <BoardCard
            board={b}
            permission={$boardPermissions.get(b.boardId)}
            workspaces={$myWorkspaces}
            slug={$boardSlugs.get(b.boardId)}
            version={versionByBoard.get(b.boardId)}
            teams={[]}
            disabled={$stdbState.status !== 'live'}
            onclose={() => (selected = null)}
            onrename={(name) => callReducer((c) => c.reducers.renameBoard({ boardId: b.boardId, name }))}
            ondelete={() => callReducer((c) => c.reducers.deleteBoard({ boardId: b.boardId }))}
            onshare={(orgId, on) => share(b.boardId, orgId, on)}
            onlink={(mode) => setLink(b.boardId, mode)}
            {agents}
            granted={grantedAgents($myAgentGrants, b.boardId)}
            onagent={(agent, on) => shareWithAgent(b.boardId, agent, on)}
          />
        {/key}
      {:else}
        <section class="activity">
          <h2>Activity</h2>
          <ActivityList result={activity} {names} slugs={$boardSlugs} me={$identityHex} />
        </section>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .page { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 100vh; }
  .content { min-width: 0; padding: 24px 28px 40px; }
  .header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; margin-bottom: 16px; }
  .title { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  h1 { font: 600 22px/1.2 var(--rc-sans); letter-spacing: -0.01em; color: var(--rc-ink); margin: 0; }
  .count { font: 400 13px/1.2 var(--rc-sans); color: var(--rc-muted); }
  .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .facets { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
  .sessions { margin-bottom: 16px; }
  .sessions h2 { font: 600 13px/1 var(--rc-sans); color: var(--rc-ink); margin: 0 0 8px; }
  .sessions ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; list-style: none; margin: 0; padding: 0; }
  .sessions li { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 44px; padding: 0 14px;
    border: 1px solid var(--rc-divider); border-radius: var(--rc-r-md); background: var(--rc-card); font: 400 12px/1.3 var(--rc-sans); color: var(--rc-muted); }
  .sessions li a, .sessions .pending { font: 600 13px/1.3 var(--rc-sans); color: var(--rc-ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessions li a:hover { text-decoration: underline; }
  .sessions .num { margin-left: auto; flex: none; }
  /* agent presence: the canvas uses the focal accent for it */
  .pulse { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--rc-accent); box-shadow: 0 0 0 4px var(--rc-accent-soft); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .gallery > .state { grid-column: 1 / -1; }
  .inspector { position: sticky; top: 0; height: 100vh; overflow-y: auto; border-left: 1px solid var(--rc-divider); background: var(--rc-page); }
  .activity { padding: 18px; }
  .activity h2 { font: 600 13px/1 var(--rc-sans); color: var(--rc-ink); margin: 0 0 8px; }
  .state { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: space-between;
    border: 1px solid var(--rc-border); border-radius: var(--rc-r-lg); background: var(--rc-card); padding: 16px 20px; }
  .state p { margin: 0; font: 400 13px/1.5 var(--rc-sans); color: var(--rc-ink); }
  .failed { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: space-between; padding: 12px 16px; }
  .failed p { margin: 0; }
  .notice { font: 400 13px/1.5 var(--rc-sans); color: var(--rc-ink); border: 1px solid var(--rc-border); background: var(--rc-card);
    border-radius: var(--rc-r-md); padding: 10px 12px; margin-bottom: 16px; }
  .notice.created { border-color: var(--rc-sel); background: var(--rc-sel-soft); }
  .quiet { font: 400 13px/1.5 var(--rc-sans); color: var(--rc-muted); margin: 0 0 12px; }
  .skel-tile { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--rc-divider); border-radius: var(--rc-r-lg);
    background: var(--rc-card); padding: 0 0 16px; overflow: hidden; }
  .skel.thumb { height: 128px; border-radius: 0; }
  .skel.title { width: 55%; height: 12px; margin: 0 14px; }
  .skel.line { width: 35%; margin: 0 14px; }
  @media (max-width: 1180px) {
    .page { grid-template-columns: minmax(0, 1fr); }
    .inspector { position: static; height: auto; border-left: 0; border-top: 1px solid var(--rc-divider); }
    /* a chosen board's details slide over the gallery instead of landing below it */
    .inspecting .inspector { position: fixed; z-index: 25; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); height: auto;
      border-left: 1px solid var(--rc-divider); box-shadow: var(--rc-shadow); }
  }
  @media (max-width: 600px) {
    .content { padding: 20px 16px 32px; }
    .tools { width: 100%; }
    .tools :global(.wrap) { flex: 1 1 100%; }
  }
</style>
