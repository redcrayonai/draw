<script lang="ts">
  import { stdbState } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { session, signIn } from '$lib/session';
  import { config } from '$lib/config';
  import Button from '$lib/components/Button.svelte';
  import { appHref } from '$lib/boards';
  import { DEFAULT_DB } from '$shared/db-target';

  // config.ts applies ?db= only for an allowed database. A refused one means the code lives
  // elsewhere, and redeeming it against this database would only fail with "invalid code".
  // No ?db= means the default: setDb leaves it out of the links the agent writes.
  const params = new URLSearchParams(location.search);
  const code = params.get('code') ?? '';
  const otherDb = (params.get('db') || DEFAULT_DB) !== config.spacetimeDb;
  let busy = $state(false);
  let done = $state(false);
  let error = $state('');

  async function link() {
    busy = true;
    error = '';
    try {
      await callReducer((c) => c.reducers.redeemAgentLink({ code }));
      done = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e); // reducer sentence, verbatim
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Link an agent · Draw</title></svelte:head>

<div class="page">
  <h1>Link an agent</h1>
  {#if !code}
    <p>This link has no code. Run the <code>link_dashboard</code> tool in your agent again and open the new link.</p>
  {:else if otherDb}
    <p class="alert" role="alert">This link is for a database this dashboard does not serve. Point your agent at this dashboard's database, then run <code>link_dashboard</code> again.</p>
  {:else if done}
    <div class="done" role="status">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M5.25 8.25l1.75 1.75 3.75-4" />
      </svg>
      <p><strong>Agent linked.</strong> The boards it makes are yours, and it keeps editing them. Share other boards with it from the board card.</p>
    </div>
    <Button href={appHref('/dashboard')}>back to boards</Button>
  {:else if $session.status === 'signed-out' && config.accounts}
    <p>Sign in first: the agent is linked to the account you are signed in with.</p>
    <Button variant="primary" onclick={() => signIn()}>sign in</Button>
  {:else if $stdbState.status === 'error'}
    <p class="alert" role="alert">{$stdbState.error}</p>
  {:else if $stdbState.status !== 'live'}
    <p class="quiet">{$stdbState.status === 'reconnecting' ? 'Connection lost. Retrying…' : 'Connecting…'}</p>
  {:else}
    <p>The boards this agent makes become yours, and it keeps editing them. It sees only the boards of yours that you share with it. You can remove it in Settings; its boards stay yours. Only open links from agents you run.</p>
    <Button variant="primary" disabled={busy} onclick={link}>Link this agent to your dashboard</Button>
    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
  {/if}
</div>

<style>
  .page { max-width: 560px; margin: 0 auto; padding: 32px; }
  h1 { font: 400 34px/1 var(--rc-serif); color: var(--rc-ink); margin: 0 0 24px; }
  p { font: 400 14px/1.6 var(--rc-sans); color: var(--rc-ink); margin: 0 0 20px; }
  p.quiet { color: var(--rc-muted); }
  code { font: 400 13px/1 var(--rc-mono); }
  strong { font-weight: 600; }
  .done { display: flex; gap: 10px; align-items: flex-start; }
  .done svg { flex: none; color: var(--rc-ok); margin-top: 2px; }
  .error { margin-top: 16px; }
  @media (max-width: 600px) { .page { padding: 24px 16px; } }
</style>
