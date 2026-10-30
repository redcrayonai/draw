# Focus

Successful `create_node`, `update_node`, `create_chart`, `set_chart_data`, and node-targeted `add_code_ref` writes
automatically select the node for an agent. A moved ref range also selects its
node. Rejected writes and unchanged ref retries do not move focus. Edges and
checkpoint ref refreshes do not move focus. Human selection stays under human
control.

For inspection or an explicit focus change, call `set_selection` with
`{ "board": "<id>", "nodeIds": ["<node id>"] }`. This selection lasts until the
next successful node write or arrival. The canvas shows a dashed selection, and
the rail shows `agent on <node>`. Clear it with `"nodeIds": []` right before your
final `mark_checkpoint`, so the checkpoint stays the last write.
