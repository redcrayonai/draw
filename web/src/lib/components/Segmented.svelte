<script lang="ts" generics="T extends string">
  // One bordered group of toggle buttons; the label names the group (visible unless hideLabel, when a heading beside it already says it).
  let { label, options, value, onchange, disabled = false, hideLabel = false }: {
    label: string;
    options: readonly T[];
    value: T;
    onchange: (v: T) => void;
    disabled?: boolean;
    hideLabel?: boolean;
  } = $props();
  const id = $props.id();
</script>

<div class="group" role="group" aria-labelledby={id}>
  <span class={hideLabel ? 'sr-only' : 'eyebrow'} {id}>{label}</span>
  <div class="seg">
    {#each options as o (o)}
      <button type="button" aria-pressed={o === value} {disabled} onclick={() => !disabled && o !== value && onchange(o)}>{o}</button>
    {/each}
  </div>
</div>

<style>
  .group { display: flex; align-items: center; gap: 10px; }
  .seg { display: inline-flex; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); padding: 2px; gap: 2px; background: var(--rc-raised); }
  button {
    font: 500 11px/1 var(--rc-mono);
    color: var(--rc-muted);
    background: transparent;
    border: none;
    border-radius: var(--rc-r-sm);
    min-height: 28px;
    padding: 0 12px;
    cursor: pointer;
    transition: background var(--rc-dur) var(--rc-ease), color var(--rc-dur) var(--rc-ease);
  }
  button:hover:not(:disabled) { color: var(--rc-ink); background: var(--rc-hover); }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  button[aria-pressed='true'] { color: var(--rc-ink); background: var(--rc-sel-soft); box-shadow: inset 0 0 0 1px var(--rc-sel); }
</style>
