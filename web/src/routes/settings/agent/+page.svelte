<script lang="ts">
  import { appHref } from '$lib/boards';
  import { config } from '$lib/config';
  import { CONNECT_FOOTER, connectGuide } from '$shared/connect-guide';

  // The canvas's Connect an agent dialog shows the same steps, one tab each.
  const guide = config.mcpUrl ? connectGuide(config.mcpUrl) : [];
</script>

<svelte:head><title>Agent setup · Draw</title></svelte:head>

<div class="page">
  <a class="back" href={appHref('/settings')}>← Back to settings</a>
  <h1>Connect your coding agent</h1>
  {#if config.mcpUrl}
    <p class="intro">
      Your agent opens a board for its task and draws what it builds. Its boards appear in your
      <a href={appHref('/dashboard')}>board list</a>.
    </p>
    <h2>Server URL</h2>
    <pre><code>{config.mcpUrl}</code></pre>
    {#each guide as tab (tab.id)}
      <section aria-labelledby="agent-{tab.id}">
        <h2 id="agent-{tab.id}">{tab.label}</h2>
        <ol>
          {#each tab.steps as step}
            <li>
              <h3>{step.title}</h3>
              {#if step.text}<p>{step.text}</p>{/if}
              {#if step.link}<p><a class="cursor" href={step.link.href}>{step.link.text}</a></p>{/if}
              {#each step.boxes ?? [] as box}<pre><code>{box.text}</code></pre>{/each}
              {#if step.note}<p class="note">{step.note}</p>{/if}
              {#if step.more}
                <details>
                  <summary>{step.more.summary}</summary>
                  <pre><code>{step.more.box.text}</code></pre>
                </details>
              {/if}
            </li>
          {/each}
        </ol>
      </section>
    {/each}
    <div class="foot">
      {#each CONNECT_FOOTER as line}<p>{line}</p>{/each}
      {#if config.privacyUrl}<p><a href={config.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy policy</a></p>{/if}
    </div>
  {:else}
    <p class="intro">Hosted agents are not available yet.</p>
  {/if}
</div>

<style>
  .page { max-width: 640px; margin: 0 auto; padding: 32px; }
  .back { font: 400 12px/1.5 var(--rc-sans); color: var(--rc-muted); }
  h1 { font: 400 34px/1.1 var(--rc-serif); color: var(--rc-ink); margin: 20px 0 16px; }
  h2 { font: 400 22px/1.2 var(--rc-serif); color: var(--rc-ink); margin: 32px 0 12px; }
  h3 { font: 500 13px/1.6 var(--rc-sans); color: var(--rc-ink); margin: 0; }
  p { font: 400 13px/1.6 var(--rc-sans); color: var(--rc-muted); margin: 8px 0; }
  .intro { font-size: 14px; }
  ol { margin: 0; padding-left: 24px; }
  li { padding: 12px 0 12px 6px; color: var(--rc-muted); }
  li + li { border-top: 1px solid var(--rc-divider); }
  pre { margin: 8px 0; padding: 12px 16px; border: 1px solid var(--rc-border); border-radius: var(--rc-r-md); background: var(--rc-card); white-space: pre-wrap; overflow-wrap: anywhere; }
  code { font: 400 12px/1.6 var(--rc-mono); color: var(--rc-ink); }
  .cursor { font: 500 13px/1.6 var(--rc-sans); color: var(--rc-ink); }
  summary { font: 400 13px/1.6 var(--rc-sans); color: var(--rc-muted); cursor: pointer; }
  .foot { border-top: 1px solid var(--rc-divider); padding-top: 16px; margin-top: 24px; }
  .foot p { font-size: 12px; }
  @media (max-width: 600px) { .page { padding: 24px 16px; } }
</style>
