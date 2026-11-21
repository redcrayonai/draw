<script lang="ts">
  import { onMount } from 'svelte';
  import { config } from '$lib/config';
  import { session } from '$lib/session';
  import { myWorkspaces, workspaceState } from '$lib/workspaces';
  import { canvasHref, shareLink } from '$lib/boards';
  import { callReducer } from '$lib/reducer';
  import { newShareToken } from '$shared/share-link';
  import Button from '$lib/components/Button.svelte';

  let host = $state('');
  let origin = '', share = $state(false), ready = $state(false), name = $state('');
  let destination = $state(''), audience = $state('workspace'), busy = $state(false);
  let error = $state(''), href = $state('');
  let token = '';
  const choices = $derived($myWorkspaces.filter(workspace => workspace.role !== 'guest'));
  $effect(() => {
    if (!busy && !choices.some(w => w.id.toString() === destination)) destination = (choices.find(w => w.personal) ?? choices[0])?.id.toString() ?? '';
  });

  async function publish(snapshot: unknown, key: string, selection: { workspaceId: string; linkToken: string }) {
    try {
      const result = await callReducer(c => c.procedures.shareLocalCopy({
        ...selection, requestKey: key, snapshot: JSON.stringify(snapshot),
      }));
      const copy = JSON.parse(result) as { slug: string; token: string };
      href = copy.token ? shareLink(copy.token) : canvasHref(copy.slug);
      window.opener?.postMessage({type: 'draw.shared', href: canvasHref(copy.slug)}, origin);
    } catch (e) { error = e instanceof Error ? e.message : 'Could not share this board. Try again.'; }
    finally { busy = false; }
  }
  let pending: { workspaceId: string; linkToken: string } | undefined;
  let deadline: ReturnType<typeof setTimeout>;
  function confirm() {
    if (!window.opener || window.opener.closed) { error = 'Reopen Share from your local board.'; return; }
    error = ''; busy = true;
    pending = { workspaceId: destination, linkToken: audience === 'link' ? token : '' };
    window.opener.postMessage({type: 'draw.copy'}, origin);
    deadline = setTimeout(() => { error = 'Reopen Share from your local board to reconnect.'; pending = undefined; busy = false; }, 12000);
  }
  onMount(() => {
    host = location.host;
    const params = new URLSearchParams(location.hash.slice(1));
    share = params.get('action') === 'share';
    try {
      const source = new URL(params.get('origin') || '');
      if (source.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(source.hostname) || !window.opener) throw Error();
      origin = source.origin;
    } catch { error = 'Return to the local board and open this window again.'; return; }
    function receive(event: MessageEvent) {
      if (event.origin !== origin || event.source !== window.opener) return;
      if (event.data?.type === 'draw.ready') { ready = true; clearTimeout(deadline); error = ''; name = event.data.name ?? ''; }
      if (event.data?.type === 'draw.snapshot' && pending) {
        clearTimeout(deadline);
        void publish(event.data.snapshot, event.data.requestKey, pending);
        pending = undefined;
      }
    }
    token = newShareToken();
    window.addEventListener('message', receive);
    if ($session.status === 'signed-in') window.opener.postMessage({type: 'draw.account'}, origin);
    deadline = setTimeout(() => { if (!ready) error = 'Reopen Share from your local board to reconnect.'; }, 12000);
    return () => { clearTimeout(deadline); window.removeEventListener('message', receive); };
  });
</script>

<section class="transfer">
  {#if !config.accounts}
    <h1>Accounts are unavailable</h1><p>This dashboard needs sign-in configured before you can share a local board.</p>
  {:else if href}
    <h1>Your shared copy is ready</h1>
    <p>Later edits stay with the copy you edit.</p>
    <label>Share link<input readonly value={href} onfocus={e => e.currentTarget.select()} /></label>
    <a href={href}>Open shared copy ↗</a>
  {:else if !share}
    <h1>Signed in to Draw</h1><p>You can close this tab and keep working on your local board.</p>
  {:else}
    <h1>Share a copy{name ? ' of ' + name : ''}</h1>
    <p>The copy includes diagram labels, descriptions and review notes. Code references, source files and chat stay on this device.</p>
    <p>Destination: {host}</p>
    <label>Workspace<select bind:value={destination} disabled={busy}>
      {#if !choices.length}<option value="">Choose a workspace</option>{/if}
      {#each choices as workspace}<option value={workspace.id.toString()}>{workspace.name}</option>{/each}
    </select></label>
    <label>Who can view?<select bind:value={audience} disabled={busy}>
      <option value="workspace">Workspace members</option><option value="link">Anyone with the link</option>
    </select></label>
    <Button variant="primary" disabled={!destination || !ready || !name || busy} onclick={confirm}>{busy ? 'Sharing…' : 'Share a copy'}</Button>
    <Button disabled={busy} onclick={() => window.close()}>Stay offline</Button>
    {#if $workspaceState === 'unavailable' || ($workspaceState === 'live' && !choices.length)}<p>Choose or create a workspace where you can add boards.</p><a href="/workspaces">Open workspaces</a>{/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
  .transfer { max-width: 36rem; margin: 10vh auto; padding: 24px; }
  h1 { line-height: 1.15; }
  p { line-height: 1.5; }
  label { display: grid; gap: 6px; margin: 20px 0; }
  input, select { font: inherit; padding: 10px; width: 100%; }
</style>
