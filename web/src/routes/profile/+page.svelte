<script lang="ts">
  import { session, accountLabel } from '$lib/session';
  import { myBoards, myAgentLinks, identityHex, stdbState, boardSlugs, myActivity } from '$lib/stdb';
  import { idTail, linkedAgents } from '$lib/boards';
  import { filterFeed } from '$lib/activity';
  import StatTile from '$lib/components/StatTile.svelte';
  import ActivityList from '$lib/components/ActivityList.svelte';
  import Button from '$lib/components/Button.svelte';

  // your own part of the live feed, newest first
  const recent = $derived(filterFeed($myActivity, (e) => e.actor === $identityHex, 10));
  const count = (access: string) => $myBoards.filter((b) => b.access === access).length;
  const names = $derived(new Map($myBoards.map((b) => [b.boardId.toString(), b.name])));
  const name = $derived(accountLabel($session));
  let copied = $state('');

  async function copyIdentity() {
    try {
      await navigator.clipboard.writeText($identityHex);
      copied = 'Copied';
    } catch {
      copied = 'Copy failed'; // clipboard blocked: the full hex is still in the tooltip
    }
    setTimeout(() => (copied = ''), 2000);
  }
</script>

<svelte:head><title>Profile · Draw</title></svelte:head>

<div class="page">
  <h1>Profile</h1>
  <section class="card">
    <div class="name">{name}</div>
    {#if $session.email}<div class="email">{$session.email}</div>{/if}
    {#if $identityHex}
      <div class="identity">
        <span class="id" title={$identityHex}>identity {idTail($identityHex)}</span>
        <Button variant="ghost" onclick={copyIdentity}>copy</Button>
        <span class="copied" role="status">{copied}</span>
      </div>
    {/if}
    <div class="rule"></div>
    <div class="stats">
      <StatTile value={count('owner')} label="your boards" />
      <StatTile value={count('team')} label="team boards" />
      <StatTile value={count('agent')} label="agent boards" />
      <StatTile value={count('public')} label="public boards" />
      <StatTile value={linkedAgents($myAgentLinks, $identityHex).length} label="linked agents" />
    </div>
  </section>
  <section class="card">
    <h2 class="eyebrow">Your recent activity</h2>
    <ActivityList
      result={recent}
      {names}
      slugs={$boardSlugs}
      me={$identityHex}
      idle={!recent && $stdbState.status !== 'live' ? 'Activity appears once the dashboard is connected.' : undefined}
    />
  </section>
</div>

<style>
  .page { max-width: 640px; margin: 0 auto; padding: 32px; display: flex; flex-direction: column; gap: 16px; }
  h1 { font: 400 34px/1 var(--rc-serif); color: var(--rc-ink); margin: 0 0 8px; }
  .card { border: 1px solid var(--rc-border); border-radius: var(--rc-r-lg); background: var(--rc-card); padding: 20px; }
  .name { font: 400 24px/1.1 var(--rc-serif); color: var(--rc-ink); overflow-wrap: anywhere; }
  .email { font: 400 13px/1.4 var(--rc-sans); color: var(--rc-muted); margin-top: 6px; }
  .identity { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
  .id { font: 400 12px/1 var(--rc-mono); color: var(--rc-faint); }
  .copied { font: 400 12px/1 var(--rc-sans); color: var(--rc-muted); }
  .rule { height: 1px; background: var(--rc-divider); margin: 16px 0 20px; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
  .card > .eyebrow { margin-bottom: 4px; }
  @media (max-width: 600px) {
    .page { padding: 24px 16px; }
    .stats { grid-template-columns: repeat(3, 1fr); row-gap: 20px; }
  }
</style>
