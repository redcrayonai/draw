# Checkpoint

Call `mark_checkpoint` with `board`:
- immediately **before every `git commit`**;
- immediately **before your final answer**;
- whenever **more than eight files** have changed since the last checkpoint
  (`git status --porcelain` lists more than eight lines).

Draw first ([draw.md](draw.md)), then checkpoint. Pass `exclude` groups for changed files
that are not yours to draw, each with a reason a stranger understands:

```json
{ "exclude": [
  { "reason": "generated bindings", "glob": "**/module_bindings/**" },
  { "reason": "lockfiles", "glob": "**/pnpm-lock.yaml" }
] }
```

The result is `{ board, checkpoint, headSha, coverage: { changed, uncovered,
excluded, deleted }, reanchor: { shifted, drifted, stale, ambiguous, restored },
citedPaths, notes? }`. Read it (`citedPaths` is for the plugin; nothing to do).
`coverage.uncovered` is the debt chip: if it names files you
materially changed, draw them or exclude them with a reason, then checkpoint
again. A changed file is covered when an `ok` ref on the board intersects one of
its diff hunks; any `ok` ref on an untracked file covers it. Only an `ok` ref
covers: stale and ambiguous refs never cover. An `exclude` group takes only
files that no ref covers. A file renamed since the session started counts as
deleted under its old path and changed under its new one. `notes` is optional
and appears only when git could not compare or diff a file in full (too large,
too slow). Each entry names the file, the reason, and what that meant:
`<path>: <reason>; counted as changed`, or, for a diff git could not print,
`<path>: <reason>; its changed lines are unknown, so it counts as uncovered`.
A ref cannot cover a file whose changed lines are unknown: exclude it with a
reason, or leave it uncovered and name it in your final answer.

**Re-anchoring** runs inside every checkpoint, before coverage, for every ref
whose file changed since it was captured.

TypeScript/JavaScript refs are found again by `symbol` name:
- found once with the same text → `shifted` (lines moved; nothing for you to do);
- found once with different text → `drifted` (the ref now describes the current
  code and carries the new checkpoint number; nothing to do);
- found more than once → `status: ambiguous`, unless exactly one of the matches
  still holds the captured snippet exactly: then that match is the ref, and it
  counts as `shifted`;
- not found, **the file deleted**, or a new range too long for a snippet →
  `status: stale`, last known lines kept;
- a file with a parse error (mid-edit) is left exactly as it is and re-anchored
  at the next checkpoint.

Refs in other files follow their captured lines: the server looks for the
snippet as one exact block. Found exactly once → `shifted` to the new lines.
Edited, gone, deleted, or found more than once → `status: stale`.

A ref reported `stale` or `ambiguous` at an earlier checkpoint that holds again
(its file or symbol came back) is `ok` again and listed in `reanchor.restored`:
nothing to do, and do not remove it.

`reanchor.stale` and `reanchor.ambiguous` list the refs you must fix, each as
`<symbol> <path> id=<n>`: for each, `remove_code_ref` with `refId` set to that
`id`, then `add_code_ref` under the name that resolves now (follow the rejection
text if the name is ambiguous; a range only for non-TypeScript files), then
checkpoint again. Never leave a `stale` or `ambiguous` ref on the board at the
end. If the file really is gone, remove the ref and, if the node no longer exists
in the code, delete the node.

**The final `mark_checkpoint` is your last write.** The board shows the coverage
stored at the *last checkpoint*, so any board edit, ref, or file edit after it
leaves the board's ledger wrong.
Order at the end: finish editing files → draw → `layout_board` (only if this
pass added nodes or edges and no human moved things) → clear the selection
([focus.md](focus.md)) → `mark_checkpoint` → answer. Never let the final answer go out with a checkpoint
older than your last edit.
