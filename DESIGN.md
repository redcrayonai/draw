---
name: redcrayon
description: A precise drawing studio for people and coding agents.
colors:
  paper: "#0E0E11"
  app: "#0B0B0D"
  panel: "#161619"
  panel-2: "#1C1C21"
  panel-hi: "#26262C"
  ink: "#ECECEE"
  muted: "#9A9AA4"
  faint: "#85858F"
  accent: "#EB6C36"
  accent-soft: "#241A16"
  sel: "#3B82F6"
  sel-soft: "rgba(59, 130, 246, 0.14)"
  ok: "#3FB950"
  hairline: "rgba(255, 255, 255, 0.14)"
  border: "rgba(255, 255, 255, 0.08)"
typography:
  board-title:
    fontFamily: "Geist, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
  panel-title:
    fontFamily: "Geist, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Geist, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  control:
    fontFamily: "Geist, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1
  section-label:
    fontFamily: "Geist, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "5px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
components:
  button-primary:
    backgroundColor: "{colors.panel-hi}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
  panel:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.4}"
---

# Design system: redcrayon

## Overview

**Creative North Star: "The drawing studio"**

redcrayon is a working canvas. The drawing leads; controls help people understand, draw, and inspect it.
Its character comes from precise type, quiet surfaces, and evidence attached to real relationships.

This guide records the existing system and the approved refinement of its controls.
It applies to the canvas and provides the palette mapping for the dashboard.
[PRODUCT.md](PRODUCT.md) owns product facts and capabilities.

**Key characteristics:**

- Clear board titles and readable controls.
- Compact panels with space between distinct tasks.
- Color that explains focus, selection, and connection state.
- Familiar drawing tools with visible names when space permits.
- Evidence and code that stay readable across themes.

Implementation sources are [canvas CSS](client/src/style.css), [editor themes](client/src/themes.css),
the [theme registry](shared/themes.ts), and [dashboard tokens](web/src/lib/styles/tokens.css).
CSS remains the runtime source of truth. Update this guide when those rules change.

## Colors

The frontmatter records the house Dark palette. Theme overrides replace these roles without changing their meaning.

| Role | Canvas token | House Light | Use |
| --- | --- | --- | --- |
| Drawing surface | `--paper` | `#F5F5F3` | Canvas ground |
| App surface | `--app` | `#EDEDEA` | Header and page behind the canvas |
| Content surface | `--panel` | `#FFFFFF` | Nodes and inset cards |
| Floating surface | `--panel-2` | `#FFFFFF` | Rail, inspector, dock, popovers |
| Hover surface | `--panel-hi` | `#ECECE8` | Hover and raised primary actions |
| Primary text | `--ink` | `#131313` | Titles, labels, and diagram text |
| Supporting text | `--muted` | `#5B6472` | Counts, guidance, and secondary controls |
| Metadata | `--faint` | `#6A6A74` | Shortcuts and compact section labels |
| Focal accent | `--accent` | `#B34616` | Focal diagram content and presence |
| Selection | `--sel` | `#2563EB` | Focus rings, selected controls, selected objects |
| Connection | `--ok` | `#1A7F37` | Connected state |

**Keep color meanings stable.** Use `--sel-soft` behind selected controls.
Use `--accent-soft` behind focal content. A selected control does not become focal diagram content.
Freeform drawing colors, chart series, threats, and evidence have their own semantic rules; preserve them.

Dashboard equivalents use `--rc-`: `paper` → `paper`, `app` → `page`, `panel` → `card`,
`panel-2` → `raised`, `panel-hi` → `hover`, `hairline` → `border`, and `border` → `divider`.
Text, accent, selection, and connection roles keep their names.

The theme registry includes Dark, Light, Neo-brutalism, and ten editor themes.
Neo-brutalism keeps its square corners, heavy rules, and hard shadows; it is canvas-only.
Editor themes retain their own code and chart palettes.

## Typography

Geist carries interface text. Geist Mono carries code, file paths, shortcuts, and technical metadata.
The dashboard also uses Instrument Serif for its existing brand and display treatments.

| Role | Size / weight | Treatment |
| --- | --- | --- |
| Board title | 14 / 600 | One line; truncates after counts yield space |
| Panel title | 13 / 600 | Sentence case; no decorative label above it |
| Inspector body | 13 / 400 | 1.55 line height |
| Controls | 12 / 500 | Sans; labels name the action |
| Rail guidance | 12 / 400 | Sans; 1.6 line height |
| Section labels | 11 / 600 | Sans; uppercase; 0.06em tracking |
| Canvas node label | 15 / 500 | Sans; existing small and large variants remain |
| Code | 12 / 400 | Mono; 1.6 line height |

Use tabular figures for counts and measurements. Reserve 11px text for short labels and metadata.
Instructions need at least 12px. Keep code syntax colors and line-number alignment intact.

Canvas text fitting measures Geist and Geist Mono in `client/src/node-text.ts`.
A future font change must update that measurement code and check diagram labels and SVG export.

## Layout

The canvas fills the available space below a 52px header. Floating controls sit around the drawing.
The rail is 232px wide on desktop, with 16px internal padding.
Use the spacing scale: 4, 8, 12, 16, 24, and 32px.

Related controls use 4–8px gaps. Panel content uses 12–16px gaps.
Distinct sections use a divider and 16px separation.
Use existing viewport and toolbar placement helpers when moving floating controls.
Their coordinates also drive panning, fitting, selection reveal, and drag behavior.

At 1024px and wider, creation tools show their names beneath the icons.
Smaller layouts retain the compact dock, accessible names, shortcuts, and tooltips.
Dock buttons remain 44px high, with a minimum width of 44px.

At 720px and below, the header wraps, counts disappear, and panels adapt to the viewport.
The dock scrolls on narrow screens. Preserve safe-area spacing and access to zoom and shortcuts.
At 1200px and below, secondary header count details yield space before the board title and actions.

## Elevation & Depth

Surface tone establishes hierarchy. Borders separate nearby surfaces.
Use shadows for floating controls; avoid adding shadows to ordinary diagram nodes.

- `--shadow`: rail and small floating controls.
- `--shadow-lg`: dock, contextual toolbar, dialogs, and larger popovers.

Use theme values directly. Dark and Light use soft shadows; Neo-brutalism uses hard offset shadows.
Keep motion at the existing 160ms duration and easing tokens.
Respect `prefers-reduced-motion` and avoid animation that changes diagram coordinates.

## Shapes

Use 5–6px corners for small chips and controls, 8px for control groups, and 12px for floating panels.
The dock and larger dialogs use 16px corners.
Diagram shapes communicate kind and must retain their distinct outlines.
Preserve datastore rims, external dashes, boundaries, and evidence stroke patterns.

## Components

**Connections.** Direction uses an open chevron with a 1.5px stroke and rounded caps and joins.
The chevron sits inside a padded 12×12px marker to prevent clipping.
Default lines and heads use `--muted` for contrast. The path endpoint anchors the chevron's tip.
Curves finish with a short straight landing so the line runs through the center of the head.
Marker sizing uses diagram coordinates, so evidence line weight and dense-mode thinning cannot resize the head.
A hand-set medium or bold weight keeps that size and strokes its head half a pixel heavier than its line.
Evidence and custom-color heads retain their semantic colors. Selected heads use `--sel` to match their lines.
An edge with its own color keeps it while selected, head included, and a `--sel` halo marks the selection.

**Header.** The board title leads. Counts are plain supporting text without a card or badge.
For example, `12 nodes · 8 edges` replaces repeated zero-state details.
Nonzero hidden counts remain in the summary. The tooltip and accessible label retain totals, shown counts, hidden counts, and checkpoints.

**Rail.** Use a readable title and sentence-case control names.
Hide the hidden-set section when it has no chips. Show it as soon as hidden content exists.
Keep session controls and the ability to reveal hidden content intact.

**Dock.** Icons match the shapes they create. Desktop creation tools show their names.
The active drawing tool keeps the existing ink-filled treatment; contextual selections use selection colors.
Selected toolbar controls use a selection-colored tint and outline, with primary ink for readable text across themes.

**Buttons.** Primary actions use a raised neutral fill. Secondary actions use `.ctl` or the dashboard Button component.
Hover changes surface and text color. Keyboard focus uses a visible 2px selection-colored outline.
Disabled controls keep the existing muted treatment and cannot activate.

**Inspector.** Preserve the reading order: object title, context, evidence, code references, and actions.
Use sans for prose and actions. Use mono for paths, snippets, line numbers, and reference metadata.

**Save state.** Connection and save acknowledgement remain separate.
An error says what failed and uses ink with a dashed underline; focal orange does not carry save errors.
General dashboard errors keep their existing dashed border and readable message.

**Inputs and popovers.** Reuse existing input, search, share, and theme-picker patterns.
Use inset surfaces, visible focus, and labels. Keep long values scrollable or wrapped where they must be read.

## Do's and Don'ts

- **Do** let the drawing and board title lead.
- **Do** use existing semantic tokens in every theme.
- **Do** keep hidden content disclosed and reachable.
- **Do** distinguish human claims, source evidence, and unverified agent claims.
- **Do** check desktop, phone, keyboard focus, and exported SVG after visual changes.
- **Don't** repeat zero-state metadata in the header.
- **Don't** use monospace for ordinary instructions or action labels.
- **Don't** use focal accent to indicate a selected control.
- **Don't** replace diagram geometry or vocabulary merely because other tools use graphs.
- **Don't** swap fonts without updating canvas text measurement.
