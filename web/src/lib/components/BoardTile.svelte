<script lang="ts">
  import { authenticatedHref } from '$lib/session';
  import type { ArchitectureVersion } from '$lib/history';
  import { ago, canvasHref, cardState, isEpoch, plural, type MyBoard } from '$lib/boards';
  let { board, slug = '', version, selected = false, highlight = false, onselect }: {
    board: MyBoard;
    /** the board's #b= link id; no link until it arrives */
    slug?: string;
    version?: ArchitectureVersion;
    selected?: boolean;
    highlight?: boolean;
    onselect: () => void;
  } = $props();
  const kind = $derived(cardState(board));
  const href = $derived(slug ? authenticatedHref(canvasHref(slug)) : undefined);
  const tag = $derived(version ? (version.assertionMode === 'intent' ? 'intent' : 'snapshot') : kind === 'session' ? 'session' : kind === 'linked' ? 'code' : '');
  const empty = $derived(board.shownNodes === 0 && board.shownEdges === 0);
  // One glyph per kind: no stored preview exists yet, so the tile names what the board is instead of faking its drawing.
  const glyph = $derived(
    tag === 'session' ? 'M5 9.5h.01M11 9.5h.01M3.5 6h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM8 3v3'
    : tag === 'code' ? 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5'
    : tag ? 'M8 2.5L14 5.5 8 8.5 2 5.5zM2 8.5l6 3 6-3M2 11l6 3 6-3'
    : 'M2 3h5v4H2zM9 9h5v4H9zM4.5 7v4H9'
  );
</script>

<article class="tile" class:selected class:highlight>
  <!-- shortcut: below 1180px the first click opens the inspector overlay, which can catch the second click, so double-click to open is desktop-only there; the name link opens the board everywhere -->
  <button class="thumb" aria-label={`Details for ${board.name}`} aria-pressed={selected} onclick={onselect} ondblclick={() => href && location.assign(href)}>
    {#if tag}<span class="tag">{tag}</span>{/if}
    <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={glyph} /></svg>
  </button>
  <div class="meta">
    <a class="name" {href}>{board.name}</a>
    {#if !isEpoch(board.updatedAt)}<span class="when num">{ago(board.updatedAt.toDate())}</span>{/if}
    <span class="stats num">{kind === 'session' && board.sessionCheckpoint ? `checkpoint ${board.sessionCheckpoint} · ` : ''}{!board.statsReady ? 'counts pending' : empty ? 'empty board' : `${plural(board.shownNodes, 'node')} · ${plural(board.shownEdges, 'edge')}`}</span>
  </div>
</article>

<style>
  .tile { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--rc-divider); border-radius: var(--rc-r-lg);
    background: var(--rc-card); overflow: hidden; transition: border-color var(--rc-dur) var(--rc-ease), box-shadow var(--rc-dur) var(--rc-ease); }
  .tile:hover { border-color: var(--rc-border); }
  .tile.selected { border-color: var(--rc-sel); box-shadow: 0 0 0 3px var(--rc-sel-soft); }
  .tile.highlight { border-color: var(--rc-sel); }
  .thumb { position: relative; display: grid; place-items: center; height: 128px; padding: 0; border: 0; border-bottom: 1px solid var(--rc-divider);
    cursor: pointer; color: var(--rc-faint);
    background: var(--rc-paper) radial-gradient(circle, color-mix(in srgb, var(--rc-ink) 9%, transparent) 1px, transparent 1.3px) 0 0 / 12px 12px; }
  .thumb:hover { color: var(--rc-muted); }
  .thumb:focus-visible { outline-offset: -2px; }
  .tag { position: absolute; top: 10px; left: 10px; font: 500 11px/1 var(--rc-sans); color: var(--rc-muted);
    background: var(--rc-card); border: 1px solid var(--rc-divider); border-radius: var(--rc-r-xs); padding: 4px 6px; }
  .meta { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 10px 14px 12px; }
  .name { font: 600 13px/1.3 var(--rc-sans); color: var(--rc-ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name:hover { text-decoration: underline; }
  .when { font: 400 12px/1.3 var(--rc-sans); color: var(--rc-faint); }
  .stats { grid-column: 1 / -1; font: 400 12px/1.3 var(--rc-sans); color: var(--rc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
