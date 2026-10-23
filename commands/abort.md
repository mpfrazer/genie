---
description: Abort the active genie run (you only; Claude cannot run this)
argument-hint: "[--note \"why\"]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" abort $ARGUMENTS`

The user just aborted the active genie run. The engine's output is above.

Confirm in one line which run was aborted. Tell the user that its branch and any commits are untouched, and that `/genie:new` starts a fresh run.

Never run `genie abort` yourself. Aborting a run is the user's decision, made only through this command.
