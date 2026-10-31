<script lang="ts">
  // Static label (board access). Agents keep the canvas agent convention: a dashed outline, no fill.
  let { label, agent = false, title }: { label: string; agent?: boolean; title?: string } = $props();
</script>

<span class="badge" class:agent {title}>{label}</span>

<style>
  .badge {
    flex: none;
    font: 500 10.5px/1 var(--rc-mono);
    color: var(--rc-muted);
    background: var(--rc-hover);
    border: 1px solid transparent;
    border-radius: var(--rc-r-xs);
    padding: 3px 6px;
    white-space: nowrap;
  }
  .agent { background: transparent; border: 1px dashed var(--rc-border); }
</style>
