<script lang="ts">
  let { value, label, muted = false }: {
    value: string | number;
    label: string;
    muted?: boolean;
  } = $props();
</script>

<div class="tile">
  <div class="value" class:muted>{value}</div>
  <div class="label">{label}</div>
</div>

<style>
  .value { font: 400 22px/1 var(--rc-mono); color: var(--rc-ink); font-variant-numeric: tabular-nums; }
  .value.muted { color: var(--rc-muted); }
  .label { font: 400 12px/1.4 var(--rc-sans); color: var(--rc-muted); margin-top: 8px; }
</style>
