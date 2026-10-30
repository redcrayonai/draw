# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

redcrayon is a general diagramming canvas, in the class of Excalidraw, with capabilities those tools lack. It serves two jobs, agent-first:

- **Operators of coding agents.** A developer assigns a task to a coding agent (an MCP client) and watches a live board while the agent works. The board is the operator's navigation display: the agent drives, and the board shows where it is, what it has built, and how the parts connect, at architecture level. The operator reads the board to understand the work without reading the agent's prose. Steering stays in the agent's own chat harness.
- **People who diagram and map systems.** Humans draw architecture by hand, alone or live with others, and can import a codebase to start from its real structure.

Mapping codebases is one capability, not the product's primary identity.

## Product Purpose

redcrayon gives humans and agents one live board that tells the truth about a system. Success is an operator who, at any checkpoint, can see what the agent built and why it connects the way it does, and can follow any object down into the exact code, without trusting unverifiable claims.

## Positioning

- **Evidence-grounded.** Every edge carries its evidence class (`import`, `test-import`, `source:<path>:<line>`, `human:<identity>`, `agent:<basis>` for an agent's uncited claim, shown as unverified). Code refs carry symbol, path, line range, blob sha, and a snippet captured at a checkpoint. What the agent left off the board is counted and disclosed, never hidden.
- **Humans and agents, same reducers.** Agents and humans edit the same live board through the same server-side rules. There is no export or import step and no privileged write path.
- **Agent-native through MCP.** The board is a tool surface that a coding agent drives directly, at checkpoints it chooses, through an MCP server and a `/draw:navigate` skill.

## Operating Context

- A coding session runs in Claude Code. The agent opens a session board with `start_session`, draws components and cited flows, attaches code refs, and calls `mark_checkpoint` before commits and before its final answer. The operator keeps the board open in a browser beside the session. Feedback goes through the normal chat, not the board (one-way, by decision).
- The canvas client runs in the browser. Boards sync live through SpacetimeDB: the local database in the Docker Compose stack.
- A separate SvelteKit dashboard (`web/`) lists boards and holds profile and settings.
- Sign-in uses a generic OIDC provider. The local Compose stack runs anonymously unless you configure sign-in.

## Capabilities and Constraints

- Live multi-user editing; presence (cursors, selection, agent focus); per-user undo through inverse reducer calls.
- The server enforces editorial rules, and invalid writes abort with a readable sentence: 4 px grid, at most two focal nodes per board, a fixed token set, fixed node kinds (`service`, `datastore`, `external`, `boundary`, `note`, `text`, `chart`). A chart is at least 224×144, its data must fit its type's contract, and it always states its `source`; an agent must supply one.
- Hide, do not delete: hidden sets keep omissions visible as counts.
- Themes: the house Dark, Light and Neo-brutalism, plus ten editor themes (Catppuccin Mocha and Latte, One Dark, One Light, Oceanic Next, Gruvbox Material, Nord, Material Dark and Light, Monokai Pro). Each carries its own code colours and chart series, held to the house contrast bars (`docs/superpowers/specs/2026-10-15-editor-themes-design.md`). The dashboard offers all but Neo-brutalism.
- Evidence overlay (⌥E) and code overlay (⌥C). The inspector shows doc, evidence, and a CODE section with highlighted snippets, keyboard navigation, copy, and open-in-editor.
- Charts: eight observability types (time series, bars, top list, pie, treemap, table, stat, trace waterfall), plus scatter plots and two planning types, schedule (lanes over time, with milestones) and kanban (stage columns with optional swim lanes), drawn as SVG in every theme and edited in the inspector by paste or grid. A personal library above the dock inserts objects, charts, and saved selections.
- Live chart and board embeds: owners enable and revoke scoped anonymous links, with iframe HTML, themes, tooltips and chart transitions. Board viewers support flow, route, opt-in threat and architecture playback with Play/Pause/Replay/Loop, offscreen suspension and reduced motion. Chart links cannot read board content. Notion platform verification is pending (`docs/embeds.md`).
- Session companion: session boards with checkpoints and git coverage (changed, covered, excluded, uncovered, deleted files). Server-side symbol resolution for TS/JS uses the TypeScript compiler API, and refs re-anchor at each checkpoint.
- Importer for public Go and JavaScript/TypeScript repositories. Imported snapshots and proposals preserve evidence and code refs.
- Terminology: board, node, edge, evidence, code ref, session, checkpoint, coverage, focal, hidden set, overlay, inspector, rail, chart, source, library.

## Brand Commitments

- The product is `draw`, by `redcrayon`, both lowercase.
- The mark is the bear with a red crayon (`docs/hero/logo.svg`), from the GitHub org avatar.
- Voice is terse and precise. Rejections and disclosures are plain sentences that a human or a model can act on.

## Product Principles

1. **The board never lies.** Every relationship and every code ref traces to evidence. An omission is a disclosed number, not a silent gap.
2. **Awareness, not control.** On session boards the board is the operator's navigation display: it shows where the agent is and what it built. Steering happens in the agent's harness.
3. **Peers on the same rules.** Humans and agents write through identical reducers and identical constraints.
4. **A general canvas first.** Code and agent features extend an Excalidraw-class tool. They never narrow it into a code-map-only product.
5. **Legibility is enforced, not hoped for.** Editorial rules live on the server, so a board stays readable no matter who or what writes to it.

## Accessibility & Inclusion

No formal standard has been chosen yet. Current feature work commits to: toggle switches that expose `aria-pressed`, visible focus rings on all controls, discernible link text, `<title>` text on canvas badges, `prefers-reduced-motion` respected, and nothing that works by hover alone.
