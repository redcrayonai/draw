<script lang="ts">
  import type { Workspace } from '$lib/workspaces';
  import type { Team } from '$lib/api-types';
  import Button from './Button.svelte';
  let { teams, workspaces = [], destination = '', create, onclose }: {
    teams: Team[];
    workspaces?: Pick<Workspace, 'id' | 'name' | 'personal' | 'role'>[];
    destination?: string;
    /** orgId '' = a personal board. Rejects with the reducer's sentence. */
    create: (name: string, orgId: string) => Promise<void>;
    onclose: () => void;
  } = $props();
  let name = $state('');
  let owner = $state('');
  $effect(() => { owner = destination; });
  let busy = $state(false);
  let error = $state('');
  let input = $state<HTMLInputElement>();
  $effect(() => input?.focus()); // opening the form is asking to type a name
  const esc = (e: KeyboardEvent) => !busy && e.key === 'Escape' && onclose();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    busy = true;
    error = '';
    try {
      await create(name.trim(), owner);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err); // the reducer's sentence, verbatim
    } finally {
      busy = false;
    }
  }
</script>

<!-- Escape in a field cancels; Enter submits natively -->
<form class="dialog" aria-label="New board" onsubmit={submit}>
  <label class="field name">
    <span class="label">Name</span>
    <input bind:this={input} bind:value={name} onkeydown={esc} disabled={busy} maxlength="100" placeholder="payments-platform" />
  </label>
  <label class="field">
    <span class="label">Owner</span>
    <select bind:value={owner} onkeydown={esc} disabled={busy}>
      {#if workspaces.length === 0}<option value="">Just me</option>{/if}
      {#each workspaces.filter(workspace => workspace.role !== 'guest') as workspace (workspace.id)}<option value={`workspace:${workspace.id}`}>{workspace.name}</option>{/each}
      {#if workspaces.length === 0}{#each teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}{/if}
    </select>
  </label>
  <div class="row">
    <Button type="button" disabled={busy} onclick={onclose}>cancel</Button>
    <Button variant="primary" type="submit" disabled={busy || !name.trim()}>create</Button>
  </div>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
</form>

<style>
  .dialog { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; border: 1px solid var(--rc-border);
    border-radius: var(--rc-r-lg); background: var(--rc-card); padding: 20px; margin-bottom: 20px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field.name { flex: 1 1 260px; min-width: min(260px, 100%); }
  .label { font: 500 12px/1 var(--rc-sans); color: var(--rc-muted); }
  input, select { height: 36px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised);
    padding: 0 12px; font: 400 13px/1 var(--rc-sans); color: var(--rc-ink); }
  input::placeholder { color: var(--rc-faint); }
  select { padding-right: 8px; min-width: 140px; }
  .row { display: flex; gap: 8px; }
  .row :global(.btn) { min-height: 36px; }
  .alert { flex-basis: 100%; }
  @media (max-width: 600px) {
    .dialog { flex-direction: column; align-items: stretch; }
    .field.name { flex: none; }
  }
</style>
