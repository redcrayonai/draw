<script lang="ts">
  import { page } from '$app/state';
  import { stdbState } from '$lib/stdb';
  import { callReducer } from '$lib/reducer';
  import { myWorkspaces, workspaceState, settingsWorkspace, managesWorkspace } from '$lib/workspaces';
  import { pluginCatalog, pluginOn, workspacePlugins } from '$lib/plugins';
  import Segmented from '$lib/components/Segmented.svelte';
  // the workspace a page shows comes from its link (?workspace=)
  const chosen = $derived(page.url.searchParams.get('workspace') ?? '');
  const workspace = $derived(settingsWorkspace(chosen, $myWorkspaces));
  let busy = $state(false);
  let error = $state('');
  const disabled = $derived($stdbState.status !== 'live' || busy);
  async function toggle(plugin: string, enabled: boolean) {
    if (!workspace || busy) return;
    busy = true;
    error = '';
    try { await callReducer((c) => c.reducers.setWorkspacePlugin({ workspaceId: workspace.id, plugin, enabled })); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>
<svelte:head><title>{workspace ? `${workspace.name} · ` : ''}Plugins · Draw</title></svelte:head>
<div class="settings">
  {#if workspace}<p class="crumb">{workspace.name} › Settings</p>{/if}
  <header><h1>Plugins</h1><p class="sub">Optional features for this workspace. Each starts off. Turning one off keeps what it saved.</p></header>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
  {#if $workspaceState === 'unavailable'}
    <p class="alert" role="alert">Workspaces need the latest board server. Update the server and reload.</p>
  {:else if $workspaceState !== 'live' || $pluginCatalog === null}<p class="workspace-hint" role="status">Loading plugins…</p>
  {:else if !workspace}
    <p class="workspace-hint">This workspace is not available to you. Choose another one in the sidebar.</p>
  {:else if $pluginCatalog.length === 0}
    <p class="workspace-hint">This dashboard server lists no plugins.</p>
  {:else}
    <div class="rows">
      {#each $pluginCatalog as plugin (plugin.id)}
        {@const on = pluginOn($workspacePlugins, workspace.id, plugin.id)}
        {@const admin = managesWorkspace(workspace)}
        <div class="setting">
          <div>
            <h2>{plugin.name}</h2>
            <p class="workspace-hint">{plugin.description}</p>
            {#if !plugin.available}
              <p class="workspace-hint need">Needs storage first. Whoever runs this draw server connects a storage bucket once; then {admin ? 'you can turn it on here' : 'an owner or admin can turn it on'}.</p>
            {:else if !admin}
              <p class="workspace-hint">Owners and admins turn this on or off.</p>
            {/if}
          </div>
          <Segmented label={plugin.name} hideLabel options={['off', 'on'] as const} value={on ? 'on' : 'off'}
            disabled={disabled || !admin || !plugin.available} onchange={(v) => toggle(plugin.id, v === 'on')} />
        </div>
      {/each}
    </div>
  {/if}
</div>
<style>
  .rows { max-width: 820px; }
  .setting { display: grid; grid-template-columns: minmax(180px, 360px) minmax(0, 1fr); gap: 12px 32px; align-items: center;
    padding: 18px 0; border-bottom: 1px solid var(--rc-divider); }
  .setting h2 { margin: 0; font: 500 13px/1.4 var(--rc-sans); color: var(--rc-ink); }
  .setting .workspace-hint { margin: 2px 0 0; }
  .need { color: var(--rc-ink); }
  @media (max-width: 600px) { .setting { grid-template-columns: minmax(0, 1fr); } }
</style>
