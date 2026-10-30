<script lang="ts">
  import { theme, setTheme, THEMES, type Theme } from '$lib/theme';
  import Button from '$lib/components/Button.svelte';
  import { session, accountLabel, signOut } from '$lib/session';
  import { stdbState, myAgentLinks, myCodeConsent, identityHex } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { ago, appHref, idTail, isHostedAgent, linkedAgents, plural, type AgentLinkRow } from '$lib/boards';
  import { workspaceState } from '$lib/workspaces';
  import { config } from '$lib/config';

  let linkError = $state('');
  let consentError = $state('');
  let confirming = $state(false);
  let busy = $state(false);
  const signedIn = $derived($session.status === 'signed-in');
  const agents = $derived(linkedAgents($myAgentLinks, $identityHex));

  const storeCode = $derived($myCodeConsent?.storeCode ?? false);
  const snippetBoards = $derived($myCodeConsent?.boardsWithCode ?? 0);

  const GROUPS = ['redcrayon', 'Dark', 'Light'] as const;

  async function unlink(agent: AgentLinkRow['agent']) {
    linkError = '';
    try {
      await callReducer((c) => c.reducers.unlinkAgent({ agent }));
    } catch (e) {
      linkError = e instanceof Error ? e.message : String(e); // reducer sentence, verbatim
    }
  }

  async function setConsent(on: boolean) {
    busy = true;
    consentError = '';
    try {
      await callReducer((c) => c.reducers.setCodeConsent({ storeCode: on }));
      confirming = false;
      return true;
    } catch (e) {
      consentError = e instanceof Error ? e.message : String(e); // reducer sentence, verbatim
      return false;
    } finally {
      busy = false;
    }
  }

  async function toggleConsent(box: HTMLInputElement) {
    if (storeCode && snippetBoards > 0) {
      box.checked = true; // stays on until "delete snippets"
      consentError = '';
      confirming = true;
      return;
    }
    if (!(await setConsent(box.checked))) box.checked = storeCode; // a refusal puts the box back
  }
</script>

<svelte:head><title>Settings · Draw</title></svelte:head>

<div class="page">
  <h1>Settings</h1>
  <section>
    <h2 class="eyebrow">Account</h2>
    <div class="value">{accountLabel($session)}</div>
    {#if signedIn}<p class="hint">Managed by your sign-in provider.</p>{/if}
  </section>
  <section>
    <h2 class="eyebrow">Code</h2>
    <div class="row">
      <label class="check">
        <input type="checkbox" checked={storeCode} disabled={busy || $stdbState.status !== 'live'} onchange={(e) => toggleConsent(e.currentTarget)} />
        Store code snippets on my boards
      </label>
      <!-- Outside the label, so pressing it never toggles the box. -->
      <span class="info">
        <button type="button" class="info-btn" aria-label="What this setting does" aria-describedby="code-consent-tip"
          onkeydown={(e) => e.key === 'Escape' && e.currentTarget.blur()}>i</button>
        <span role="tooltip" id="code-consent-tip" class="tip">Enabling this will store code references to the database.</span>
      </span>
    </div>
    <p class="hint">Without this, boards keep file paths and line numbers and link to the code on GitHub.</p>
    {#if config.privacyUrl}<a class="hint" href={config.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy policy</a>{/if}
    {#if confirming}
      <p class="hint" role="status">This deletes the stored code snippets on {plural(snippetBoards, 'board')}. It cannot be undone.</p>
      <div class="row">
        <Button disabled={busy} onclick={() => (confirming = false)}>cancel</Button>
        <Button variant="primary" disabled={busy} onclick={() => setConsent(false)}>{busy ? 'deleting…' : 'delete snippets'}</Button>
      </div>
    {/if}
    {#if consentError}<p class="alert" role="alert">{consentError}</p>{/if}
  </section>
  <section>
    <h2 class="eyebrow">Appearance</h2>
    <label class="field">
      <span class="eyebrow">Theme</span>
      <select value={$theme} onchange={(e) => setTheme(e.currentTarget.value as Theme)}>
        {#each GROUPS as g (g)}
          <optgroup label={g}>
            {#each THEMES.filter((t) => t.group === g) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </label>
  </section>
  {#if signedIn && $workspaceState === 'live'}
    <section><h2 class="eyebrow">Workspaces</h2><p class="hint">Manage your workspaces, members, teams, and invitations in redcrayon.</p><Button href={appHref('/workspaces')}>manage workspaces</Button></section>
  {/if}
  <section>
    <h2 class="eyebrow">Linked agents</h2>
    <p class="hint">Connect a coding agent to draw and update diagrams with you. <a href={appHref('/settings/agent')}>agent setup guide</a></p>
    {#if $stdbState.status === 'live'}
      {#each agents as l (l.agent.toHexString())}
        <div class="agent">
          <span class="id" title={l.agent.toHexString()}>agent {idTail(l.agent.toHexString())}</span>
          <span class="when">linked {ago(l.linkedAt.toDate())}</span>
          {#if isHostedAgent(l.agent.toHexString(), config.mcpUrl, $session.userId)}
            <span class="hint">Signs in as you. To stop it, remove the MCP server from your agent.</span>
          {:else}
            <Button variant="ghost" onclick={() => unlink(l.agent)}>unlink</Button>
          {/if}
        </div>
      {:else}
        <p class="hint">No agents linked. Run the <code>link_dashboard</code> tool in your agent and open the link it prints.</p>
      {/each}
    {:else if $session.status === 'signed-out' && config.accounts}
      <p class="hint">Sign in to see your linked agents.</p>
    {:else if $stdbState.status === 'error'}
      <p class="alert" role="alert">{$stdbState.error}</p>
    {:else}
      <p class="hint">{$stdbState.status === 'reconnecting' ? 'Connection lost. Retrying…' : 'Connecting…'}</p>
    {/if}
    {#if linkError}<p class="alert" role="alert">{linkError}</p>{/if}
  </section>
  {#if signedIn}
    <section>
      <h2 class="eyebrow">Session</h2>
      <div class="row"><Button onclick={() => signOut()}>sign out</Button></div>
    </section>
  {/if}
</div>

<style>
  .page { max-width: 640px; margin: 0 auto; padding: 32px; }
  h1 { font: 400 34px/1 var(--rc-serif); color: var(--rc-ink); margin: 0 0 24px; }
  section { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 20px 0; }
  section + section { border-top: 1px solid var(--rc-divider); }
  .value { font: 400 14px/1.4 var(--rc-sans); color: var(--rc-ink); }
  code { font: 400 12px/1 var(--rc-mono); color: var(--rc-ink); }
  .hint { font: 400 13px/1.5 var(--rc-sans); color: var(--rc-muted); margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .check { display: flex; align-items: center; gap: 8px; font: 400 14px/1.4 var(--rc-sans); color: var(--rc-ink); }
  .info { position: relative; display: inline-flex; }
  .info-btn { display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 1px solid var(--rc-muted); border-radius: 50%;
    background: none; font: 600 10px/1 var(--rc-sans); color: var(--rc-muted); cursor: help; }
  .info-btn:hover, .info-btn:focus { color: var(--rc-ink); border-color: var(--rc-ink); }
  .tip { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 1; width: max-content; max-width: 240px;
    padding: 6px 8px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised);
    font: 400 12px/1.4 var(--rc-sans); color: var(--rc-ink); visibility: hidden; opacity: 0; transition: opacity 120ms; }
  /* bridges the gap so the pointer can move onto the tooltip */
  .tip::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 6px; }
  .info:hover .tip, .info-btn:focus + .tip { visibility: visible; opacity: 1; }
  .field { display: flex; align-items: center; gap: 10px; }
  select { height: 32px; min-width: 200px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised);
    padding: 0 8px 0 12px; font: 400 13px/1 var(--rc-sans); color: var(--rc-ink); }
  .agent { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; width: 100%; }
  .agent .id { font: 400 12px/1 var(--rc-mono); color: var(--rc-ink); }
  .agent .when { flex: 1; font: 400 11px/1 var(--rc-mono); color: var(--rc-faint); }
  @media (max-width: 600px) { .page { padding: 24px 16px; } }
</style>
