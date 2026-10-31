<script lang="ts">
  let { value, placeholder = 'search boards', oninput }: {
    value: string;
    placeholder?: string;
    oninput?: (v: string) => void;
  } = $props();
</script>

<div class="wrap">
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M10.5 10.5 L13.5 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>
  <input
    type="search"
    aria-label="Search boards"
    {placeholder}
    {value}
    oninput={(e) => oninput?.((e.target as HTMLInputElement).value)}
  />
</div>

<style>
  .wrap { flex: 1; display: flex; gap: 10px; align-items: center; height: 36px; padding: 0 12px;
    border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-raised); color: var(--rc-faint); }
  /* the input's own ring is off; the field shows the global one */
  .wrap:focus-within { outline: 2px solid var(--rc-sel); outline-offset: 2px; }
  input { flex: 1; min-width: 0; border: none; background: transparent; outline: none;
    font: 400 13px/1 var(--rc-sans); color: var(--rc-ink); }
  input::placeholder { color: var(--rc-faint); }
</style>
