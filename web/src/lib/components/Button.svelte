<script lang="ts">
  type Variant = 'primary' | 'secondary' | 'ghost';
  let { variant = 'secondary', href, children, ...rest }: {
    variant?: Variant;
    /** renders a link that looks like the button */
    href?: string;
    children: import('svelte').Snippet;
  } & Record<string, unknown> = $props();
</script>

{#if href}
  <a class="btn {variant}" {href} {...rest}>{@render children()}</a>
{:else}
  <button class="btn {variant}" {...rest}>{@render children()}</button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    white-space: nowrap;
    font: 500 12px/1 var(--rc-sans);
    color: var(--rc-ink);
    text-decoration: none;
    border: 1px solid var(--rc-border);
    border-radius: var(--rc-r-md);
    padding: 8px 14px;
    background: transparent;
    cursor: pointer;
    transition: background var(--rc-dur) var(--rc-ease), border-color var(--rc-dur) var(--rc-ease),
      color var(--rc-dur) var(--rc-ease);
  }
  /* the canvas .btn-primary: a raised fill, never ink-filled */
  .primary { background: var(--rc-hover); box-shadow: var(--rc-shadow); }
  .primary:hover:not(:disabled) { background: color-mix(in srgb, var(--rc-hover) 80%, var(--rc-tint)); }
  .secondary:hover:not(:disabled) { background: var(--rc-hover); }
  .ghost { border-color: transparent; color: var(--rc-muted); padding-inline: 10px; }
  .ghost:hover:not(:disabled) { color: var(--rc-ink); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
