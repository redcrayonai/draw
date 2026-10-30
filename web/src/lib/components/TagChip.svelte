<script lang="ts">
  // Interactive filter chip (canvas .chip). Static labels are Badge.svelte.
  let { label, count, active = false, onclick }: {
    label: string;
    count?: number;
    active?: boolean;
    onclick?: () => void;
  } = $props();
</script>

<button type="button" class="chip" class:active aria-pressed={active} {onclick}>
  {label}{#if count !== undefined}<span class="count num">{count}</span>{/if}
</button>

<style>
  .chip {
    font: 500 11px/1 var(--rc-mono);
    color: var(--rc-ink);
    border: 1px solid var(--rc-divider);
    border-radius: var(--rc-r-sm);
    min-height: 28px;
    padding: 0 10px;
    background: var(--rc-card);
    cursor: pointer;
    transition: border-color var(--rc-dur) var(--rc-ease), background var(--rc-dur) var(--rc-ease);
  }
  .chip:hover { background: var(--rc-hover); }
  .chip.active { border-color: var(--rc-sel); background: var(--rc-sel-soft); }
  .count { color: var(--rc-muted); margin-left: 6px; }
</style>
