<script lang="ts">
  import '$lib/styles/app.css';
  import '$lib/styles/workspaces.css';
  import { rememberInvite, workspaceState } from '$lib/workspaces';
  import { page } from '$app/state';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Button from '$lib/components/Button.svelte';
  import { theme, toggleTheme } from '$lib/theme';
  import { session, initSession, signIn, freshToken } from '$lib/session';
  import { connectAs, disconnect, joinAs, stdbState, identityHex } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { config } from '$lib/config';
  let { children } = $props();
  let onboardingFor = '';
  $effect(() => {
    if ($session.status !== 'signed-in' || $stdbState.status !== 'live' || $workspaceState !== 'live') { onboardingFor = ''; return; }
    if (!$identityHex || onboardingFor === $identityHex) return;
    onboardingFor = $identityHex;
    void callReducer(c => c.reducers.ensurePersonalWorkspace({})).catch(e => console.warn('Personal workspace setup failed:', e));
  });
  $effect.pre(() => { rememberInvite(page.url.searchParams.get('invite') ?? ''); });
  // The link names the workspace a page shows.
  const workspace = $derived(page.url.searchParams.get('workspace') ?? '');
  let menu = $state(false);
  $effect(() => { void page.url.href; menu = false; });
  $effect(() => { void initSession(); });
  // One connection per account (spec §3.2): each user gets its own key, so an
  // account switch rebuilds the socket; no accounts = the anonymous dev
  // identity; loading, or signed out with accounts configured = no socket.
  $effect(() => {
    const s = $session;
    if (s.status === 'signed-in' && s.userId) connectAs(`account:${s.userId}`, freshToken);
    else if (s.status === 'signed-out' && !config.accounts) connectAs('anon', async () => undefined);
    else disconnect();
  });
  // With accounts every route needs one: open the sign-in gate as soon as the
  // provider reports signed out. A load error waits for the retry button.
  const mustSignIn = $derived(!!config.accounts && $session.status === 'signed-out' && !$session.error);
  $effect(() => { if (mustSignIn) void signIn(false); });
  // Account users only: put their name on the activity they cause (anonymous mode never joins)
  $effect(() => {
    const s = $session;
    if ($stdbState.status === 'live' && s.status === 'signed-in' && s.userId) joinAs(`account:${s.userId}`, s.displayName ?? '');
  });
</script>

<div class="shell" class:menu>
  <header class="mobile">
    <button class="burger" aria-label="Open navigation" aria-expanded={menu} aria-controls="sidebar" onclick={() => (menu = !menu)}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
    </button>
    <span class="brand">Draw</span>
    {#if config.preview}<Badge label="Preview" title={config.previewNote} />{/if}
  </header>
  <div class="nav" id="sidebar">
    <Sidebar
      theme={$theme}
      ontoggle={() => toggleTheme()}
      path={page.url.pathname}
      {workspace}
      account={$session.status === 'signed-in' ? $session.displayName : undefined}
      loading={$session.status === 'loading'}
      signedIn={$session.status === 'signed-in'}
      canSignIn={!!config.accounts}
      onsignin={() => signIn()}
    />
  </div>
  {#if menu}<button class="scrim" aria-label="Close navigation" onclick={() => (menu = false)}></button>{/if}
  <main class="main">
    {#if $session.error}<div class="load-error"><p class="alert" role="alert">{$session.error}</p></div>{/if}

    {#if $session.status === 'loading'}
      <div class="gate" role="status">Restoring your session…</div>
    {:else if config.accounts && $session.status !== 'signed-in'}
      <div class="gate">
        <Button variant="primary" onclick={() => signIn(false)}>sign in to continue</Button>
      </div>
    {:else}
      {@render children()}
    {/if}
  </main>
</div>

<style>
  .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
  .nav { position: sticky; top: 0; height: 100vh; }
  .main { min-width: 0; background: var(--rc-paper); }
  .mobile, .scrim { display: none; }
  @media (max-width: 820px) {
    .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
    .mobile { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 8px;
      background: var(--rc-page); border-bottom: 1px solid var(--rc-divider); }
    .burger { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: var(--rc-r-md);
      background: transparent; color: var(--rc-ink); cursor: pointer; }
    .brand { font: 400 18px/1 var(--rc-serif); }
    /* hidden, not just moved: a closed menu leaves the tab order and the accessibility tree */
    .nav { position: fixed; z-index: 40; inset: 0 auto 0 0; width: min(280px, 86vw); transform: translateX(-100%); visibility: hidden;
      transition: transform var(--rc-dur) var(--rc-ease-out), visibility var(--rc-dur); }
    .menu .nav { transform: none; visibility: visible; box-shadow: var(--rc-shadow); }
    .scrim { display: block; position: fixed; z-index: 30; inset: 0; border: 0; padding: 0; background: rgb(0 0 0 / 0.45); }
  }
  .load-error { max-width: 560px; margin: 16px auto 0; padding: 0 16px; }
  .gate { display: flex; justify-content: center; padding: 80px 16px; }
</style>
