<script lang="ts">
  let { label, role = $bindable('viewer'), allBoards = $bindable(true), boardIds = $bindable<string[]>([]), boards, editor = true, disabled = false }: {
    label: string;
    role?: string;
    allBoards?: boolean;
    boardIds?: string[];
    boards: { boardId: bigint; name: string }[];
    editor?: boolean;
    disabled?: boolean;
  } = $props();
  $effect(() => {
    const available = new Set(boards.map(board => board.boardId.toString()));
    const selected = boardIds.filter(id => available.has(id));
    if (selected.length !== boardIds.length) boardIds = selected;
  });
</script>
<div class="workspace-fields">
  <label class="workspace-field">{label} permission
    <select bind:value={role} {disabled}><option value="viewer">Read</option><option value="editor" disabled={!editor}>Edit</option></select>
  </label>
  <label class="workspace-field">{label} boards
    <select value={allBoards ? 'all' : 'selected'} onchange={e => allBoards = e.currentTarget.value === 'all'} {disabled}>
      <option value="all">{label === 'Key' ? 'All account boards' : 'All workspace boards'}</option><option value="selected">Selected boards</option>
    </select>
  </label>
</div>
{#if !allBoards}
  <fieldset class="scope-boards">
    <legend>Selected boards</legend>
    {#each boards as board (board.boardId)}
      <label class="workspace-check"><input type="checkbox" bind:group={boardIds} value={board.boardId.toString()} {disabled} />{board.name}</label>
    {:else}<p class="workspace-hint">Create a board in this workspace first.</p>{/each}
  </fieldset>
{/if}
<style>
  .scope-boards { border: 0; padding: 0; margin: 12px 0 0; display: flex; flex-direction: column; gap: 8px; }
  legend { font: 500 12px/1.3 var(--rc-sans); color: var(--rc-muted); margin-bottom: 8px; }
</style>
