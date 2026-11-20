# Color and flows

Color is optional. A board with no color is correct. Use color when it tells the
reader something the layout cannot: which parts belong together, or which path
one request takes through a larger system.

## The palette

Nine hues: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`
and `gray`. A `service` or `datastore` also takes a strength: `<hue>-soft`
(faded) or `<hue>-bold` (filled). An edge takes a hue only. The board picks the
shade for the reader's theme, so name a color by its hue, never by its shade.

- `create_node` and `update_node` take `color`.
- `create_edge` takes `color`. `update_edge` with
  `{ "board": "<id>", "edgeId": "<id>", "color": "teal" }` changes it on an edge
  that exists; `"color": ""` goes back to the plain look.
- `get_board` shows the `color` of every node and edge that has one.

## Paint a group

A group is a set of parts the reader should see as one thing: a tier, a team, a
subsystem.

- One hue per group, and the same hue on the edges inside the group.
- A color means one thing on a board. If hues mark tiers, they do not also mark
  teams.
- Leave most of the board plain. A reader holds three or four hues; a board
  where every node has a color says nothing.
- Keep `red` for danger: a failure path, a part that is broken. Threats, stale
  evidence and removed rows already draw red.
- `<hue>-bold` is for the one main step of a group. `<hue>-soft` is for parts
  that are present but secondary.
- Color does not replace `focal` ([editorial.md](editorial.md)). Keep `orange`
  away from the focal node: the accent is close to it.

## Trace a flow

When the board holds a larger system and one path through it matters (checkout,
sign-in, a failing request), save the path as a flow: a walk-through with a
color.

```json
{
  "board": "42",
  "audience": "Checkout",
  "title": "How an order is paid",
  "color": "blue",
  "steps": [
    { "nodes": ["11"], "title": "The shopper pays", "body": "The web app sends the cart to the gateway." },
    { "nodes": ["12"], "title": "Routing", "body": "The gateway checks the session and passes the order to checkout." },
    { "nodes": ["13", "14"], "title": "The charge", "body": "Checkout asks payments to charge the card and waits for the answer." }
  ]
}
```

Call `save_telling` with it. Then the board does the painting:

- A node or edge that only this flow uses takes the flow's hue. A node that
  several flows pass through stays plain and shows one dot per flow. An edge
  belongs to a flow when both its ends are in it.
- The legend lists every flow by name. The reader clicks one to see it alone,
  numbered in step order with the rest of the board dimmed, and presses
  **Step through** to play it.

Rules for a flow:

- `audience` is the flow's short name as the legend shows it (`Checkout`).
  `title` says what the flow does.
- Give the steps in the order a request travels: one node, or a few that act
  together, per step, with one sentence each.
- Name only nodes whose part in the flow you read in the code. A step is a claim
  like an edge is; `source` says where it comes from.
- Do not set `color` on the flow's own nodes and edges: the flow paints them. A
  color you do set wins over the flow's, so use it for the flow's main step only
  (`blue-bold` on the checkout node of a blue flow).
- One hue per flow on a board. A hue another flow has is answered
  `REJECTED: telling rule: <hue> already marks <flow> on this board; pick another color. Nothing was written.`
  Save it again with a free hue.
- A board holds at most 6 walk-throughs, flows included.
- Saving again for the same `audience` replaces the steps and keeps the color.
  `"color": ""` makes it a plain walk-through again; `remove_telling` removes it.
- A flow is how the system behaves. A route ([route.md](route.md)) is the order
  of your own work. Do not use one for the other.

When you add flows, name them in your message to the user, with
`Click a flow in the legend to see it alone.`
