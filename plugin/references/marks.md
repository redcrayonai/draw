# Review

`start_session` also returns a `seat`. People circle nodes with the red crayon and
press Send; keep listening for those marks for the whole session:

1. After you draw the board, call `watch_marks` with `board` and your `seat`. Run the
   `command` it returns as a background task named "Waiting for your red crayon marks
   on <board name>" (Claude Code: Bash with `run_in_background` and that description).
   It waits quietly and exits on its own. Its first line says why:
   - `N mark(s) claimed`: it claimed marks for your seat. Go to step 2.
   - `idle:` no marks for 100 minutes. Start the same command again.
   - `stopped:` nobody had the board open for 10 minutes. Do not start it again. Tell
     the person to open the board and say "review my marks" to resume. When they
     do, start the command again.
   If your harness has no background tasks, call `wait_for_marks` in a loop instead,
   calling it again while it says `no marks yet`.
2. When the command claimed marks, call `wait_for_marks` with `board` and the same
   `seat`. It returns `groups`, each with `files` and `marks` (`mark`, `claimGen`,
   `node`, `label`, `note`, `doc`, `refs`). Fix each mark in the code. When your harness has
   subagents, give each group to one subagent; without them, work through the groups
   one by one. A subagent follows [subagents.md](subagents.md): it changes code and calls
   `reply_to_mark` with the `board`, `seat` and its marks, and does nothing else on
   the board.
3. Every mark ends with `reply_to_mark`, passing the `claimGen` you received. `reply`
   (1 to 400 characters) and `files` are always required: `status: "fixed"` with a
   `reply` saying what changed and the `files` you changed, or `status: "kept"` with
   the reason in `reply` and `files: []`. Never leave a mark unanswered.
4. `REJECTED: mark was reclaimed by another agent; drop it` means another seat owns
   that mark now. Drop it and go on. `REJECTED: this mark is held by another seat of
   yours` means you passed the wrong `seat`: reply again with the seat that took it.
5. After the round, start the command again. If it says the token expired, call
   `watch_marks` again for a new one (a token lasts 12 hours). `list_marks` shows what
   was already sent and answered.
