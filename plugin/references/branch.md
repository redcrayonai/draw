# Proposing a change as a branch

When the user asks you to propose a change to a board rather than edit it in place, branch it: `create_branch` with the board's id and a short name returns a new board id; draw the change there, then `submit_branch`. The owner accepts, rejects or merges in the canvas; you never do. If a later edit is needed, draw it on the branch and submit again.
