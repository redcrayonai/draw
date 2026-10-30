<script lang="ts">
  import { authenticatedHref } from '$lib/session';
  import type { ActivityEvent } from '$lib/api-types';
  import { actorLabel, marker, phraseParts } from '$lib/activity';
  import { ago, canvasHref } from '$lib/boards';
  let { event, boardName, slug = '', me = '' }: { event: ActivityEvent; boardName: string; slug?: string; me?: string } = $props();
  const who = $derived(actorLabel(event, me));
  const parts = $derived(phraseParts(event));
</script>

<div class="row">
  <span class="avatar {marker(event)}" class:you={!!me && event.actor === me} data-testid="marker" aria-hidden="true">{who.charAt(0).toUpperCase()}</span>
  <div class="body">
    <p class="what">
      <span class="who">{who}</span>{#if event.actorKind === 'agent'}<span class="sr-only">{' (agent)'}</span>{/if}
      <span class="verb">{parts.before}<a href={slug ? authenticatedHref(canvasHref(slug)) : undefined}>{boardName}</a>{parts.after}</span>
    </p>
    <div class="meta num">{ago(new Date(event.lastAt))}</div>
  </div>
</div>

<style>
  .row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; }
  /* monogram: humans filled, agents a dashed ring (the canvas convention), you in the selection tint */
  .avatar { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px;
    border-radius: 50%; background: var(--rc-hover); border: 1px solid transparent; font: 600 10px/1 var(--rc-sans); color: var(--rc-ink); }
  .avatar.dashed { background: transparent; border: 1px dashed var(--rc-border); }
  .avatar.you { background: var(--rc-sel-soft); }
  .body { flex: 1; min-width: 0; }
  .what { margin: 0; font: 400 13px/1.45 var(--rc-sans); overflow-wrap: anywhere; }
  .who { font-weight: 500; color: var(--rc-ink); }
  .verb { color: var(--rc-muted); }
  /* a hairline underline keeps the link findable without colour alone; hover inks it */
  .verb a { color: var(--rc-ink); text-decoration: underline; text-decoration-color: var(--rc-border); }
  .verb a:hover { text-decoration-color: currentColor; }
  .meta { font: 400 11px/1 var(--rc-mono); color: var(--rc-faint); margin-top: 4px; }
</style>
