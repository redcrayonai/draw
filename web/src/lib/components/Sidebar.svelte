<script lang="ts">
  import { appHref } from '$lib/boards';
  import { config } from '$lib/config';
  import type { Theme } from '$lib/theme';
  import { isDarkTheme } from '$shared/themes';
  import { myBoards } from '$lib/stdb';
  import { myWorkspaces, boardPermissions, managesWorkspace, settingsWorkspace } from '$lib/workspaces';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  let {
    theme,
    ontoggle,
    path = '',
    workspace = '',
    account,
    loading = false,
    signedIn = false,
    canSignIn = false,
    onsignin
  }: {
    theme: Theme;
    /** switches to the theme's other-scheme twin ($lib/theme flipped) */
    ontoggle: () => void;
    /** the current pathname, for aria-current */
    path?: string;
    /** the page's ?workspace= id ('' = none, '0' = boards outside every workspace) */
    workspace?: string;
    account?: string;
    loading?: boolean;
    signedIn?: boolean;
    canSignIn?: boolean;
    onsignin?: () => void;
  } = $props();
  const dark = $derived(isDarkTheme(theme));
  const settings = $derived(path.startsWith('/workspaces') && path !== '/workspaces/new');
  // the workspace the page shows; settings pages fall back the way their content does
  const active = $derived(settings ? settingsWorkspace(workspace, $myWorkspaces)?.id.toString() ?? '' : path === '/dashboard' ? workspace : '');
  const counts = $derived.by(() => {
    const n = new Map<string, number>();
    for (const board of $myBoards) {
      const id = ($boardPermissions.get(board.boardId)?.workspaceId ?? 0n).toString();
      n.set(id, (n.get(id) ?? 0) + 1);
    }
    return n;
  });
  // undefined = follow the page: the shown workspace (and its settings, on a settings page) stay open
  let open = $state<Record<string, boolean>>({});
  let settingsOpen = $state<Record<string, boolean>>({});
  const href = (route: string, id: string) => appHref(`${route}?workspace=${id}`);
  const current = (route: string, id: string) => (path === route && active === id ? 'page' : undefined);
</script>

{#snippet icon(d: string)}
  <svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path {d} /></svg>
{/snippet}
{#snippet chevron(down: boolean)}
  <svg class="chev" class:down width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
{/snippet}

<aside class="side">
  <div class="top">
    <a class="brand" href={appHref('/dashboard')}>Draw {#if config.preview}<Badge label="Preview" title={config.previewNote} />{/if}</a>
    <button class="theme" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onclick={ontoggle}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        {#if dark}
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
        {:else}
          <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z" stroke-linejoin="round" />
        {/if}
      </svg>
    </button>
  </div>
  {#if account}
    <a class="account" data-testid="account-chip" href={appHref('/profile')} aria-current={path === '/profile' ? 'page' : undefined}>
      <span class="avatar" aria-hidden="true">{account.trim().charAt(0).toUpperCase()}</span><span class="label">{account}</span>
    </a>
  {/if}
  {#if !loading && !signedIn && canSignIn}<div class="signin"><Button onclick={onsignin}>sign in</Button></div>{/if}

  <nav aria-label="Boards">
    <a class="row" href={appHref('/dashboard')} aria-current={path === '/dashboard' && !workspace ? 'page' : undefined}>
      {@render icon('M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z')}<span class="label">All boards</span> <span class="count num">{$myBoards.length}</span>
    </a>
    {#if $myWorkspaces.length && counts.get('0')}
      <a class="row" href={href('/dashboard', '0')} aria-current={current('/dashboard', '0')}>
        {@render icon('M2.5 4.5h4l1.5 1.5h5.5v7h-11z')}<span class="label">Outside workspaces</span> <span class="count num">{counts.get('0')}</span>
      </a>
    {/if}
  </nav>

  {#if $myWorkspaces.length}
    <nav aria-label="Workspaces">
      <div class="group"><span>Workspaces</span><a class="add" href={appHref('/workspaces/new')} aria-label="New workspace" aria-current={path === '/workspaces/new' ? 'page' : undefined}>{@render icon('M8 3v10M3 8h10')}</a></div>
      <ul>
        {#each $myWorkspaces as ws (ws.id)}
          {@const id = ws.id.toString()}
          {@const expanded = open[id] ?? id === active}
          {@const showSettings = settingsOpen[id] ?? (settings && id === active)}
          <li>
            <button class="row ws" aria-expanded={expanded} onclick={() => (open[id] = !expanded)}>
              {@render chevron(expanded)}<span class="mark" aria-hidden="true">{ws.name.trim().charAt(0).toUpperCase()}</span><span class="label">{ws.name}</span> <span class="count">{ws.personal ? 'personal' : ws.role}</span>
            </button>
            {#if expanded}
              <ul>
                <li><a class="row l2" href={href('/dashboard', id)} aria-current={current('/dashboard', id)}>{@render icon('M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z')}<span class="label">Boards</span> <span class="count num">{counts.get(id) ?? 0}</span></a></li>
                <li>
                  <button class="row l2" aria-expanded={showSettings} onclick={() => (settingsOpen[id] = !showSettings)}>
                    {@render icon('M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4')}<span class="label">Settings</span>{@render chevron(showSettings)}
                  </button>
                  {#if showSettings}
                    <ul>
                      {#if !ws.personal}<li><a class="row l3" href={href('/workspaces/members', id)} aria-current={current('/workspaces/members', id)}><span class="label">Members &amp; access</span></a></li>{/if}
                      {#if !ws.personal && managesWorkspace(ws)}<li><a class="row l3" href={href('/workspaces/keys', id)} aria-current={current('/workspaces/keys', id)}><span class="label">Service accounts &amp; keys</span></a></li>{/if}
                      <li><a class="row l3" href={href('/workspaces', id)} aria-current={current('/workspaces', id)}><span class="label">General</span></a></li>
                    </ul>
                  {/if}
                </li>
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </nav>
  {/if}

  <nav class="foot" aria-label="Account">
    <a class="row" href={appHref('/settings/agent')} aria-current={path === '/settings/agent' ? 'page' : undefined}>{@render icon('M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2.5')}<span class="label">Connect an agent</span></a>
    <a class="row" href={appHref('/settings')} aria-current={path === '/settings' ? 'page' : undefined}>{@render icon('M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4')}<span class="label">Account settings</span></a>
  </nav>
</aside>

<style>
  .side { display: flex; flex-direction: column; gap: 2px; height: 100%; padding: 12px 8px; overflow-y: auto;
    background: var(--rc-page); border-right: 1px solid var(--rc-divider); }
  .top { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px 8px; }
  .brand { display: inline-flex; align-items: center; gap: 8px; font: 400 20px/1 var(--rc-serif); color: var(--rc-ink); text-decoration: none; }
  .theme { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0;
    color: var(--rc-muted); background: transparent; border: 0; border-radius: var(--rc-r-md); cursor: pointer;
    transition: color var(--rc-dur) var(--rc-ease), background var(--rc-dur) var(--rc-ease); }
  .theme:hover { color: var(--rc-ink); background: var(--rc-hover); }
  .account { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 8px; margin-bottom: 6px; border-radius: var(--rc-r-sm);
    font: 600 13px/1 var(--rc-sans); color: var(--rc-ink); text-decoration: none; }
  .account:hover, .account[aria-current='page'] { background: var(--rc-hover); }
  .avatar { display: grid; place-items: center; flex: none; width: 22px; height: 22px; border-radius: 50%;
    background: var(--rc-hover); border: 1px solid var(--rc-border); font: 600 10px/1 var(--rc-sans); }
  .signin { padding: 0 8px 8px; }
  nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .row { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 30px; padding: 0 8px; border: 0; border-radius: var(--rc-r-sm);
    background: transparent; font: 500 13px/1.2 var(--rc-sans); color: var(--rc-muted); text-align: left; text-decoration: none; cursor: pointer;
    transition: color var(--rc-dur) var(--rc-ease), background var(--rc-dur) var(--rc-ease); }
  .row:hover { color: var(--rc-ink); background: color-mix(in srgb, var(--rc-hover) 60%, transparent); }
  .row[aria-current='page'] { color: var(--rc-ink); background: var(--rc-hover); }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { flex: none; font: 400 11px/1 var(--rc-mono); color: var(--rc-faint); }
  .icon { flex: none; }
  .chev { flex: none; color: var(--rc-faint); transition: transform var(--rc-dur) var(--rc-ease); }
  .chev.down { transform: rotate(90deg); }
  .group { display: flex; align-items: center; justify-content: space-between; padding: 18px 4px 6px 8px;
    font: 600 11px/1 var(--rc-sans); letter-spacing: 0.06em; text-transform: uppercase; color: var(--rc-faint); }
  .add { display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--rc-r-xs); color: var(--rc-faint); }
  .add:hover, .add[aria-current='page'] { color: var(--rc-ink); background: var(--rc-hover); }
  .ws { color: var(--rc-ink); font-weight: 600; }
  .mark { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: var(--rc-r-xs);
    background: var(--rc-hover); border: 1px solid var(--rc-border); font: 600 11px/1 var(--rc-sans); color: var(--rc-ink); }
  .l2 { padding-left: 30px; }
  .l3 { padding-left: 55px; font-weight: 400; }
  .foot { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--rc-divider); }
</style>
