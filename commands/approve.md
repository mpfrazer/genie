---
description: Approve or reject a pending genie human gate (you only; Claude cannot run this)
argument-hint: "<gate> [--reject] [--note \"why\"]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" approve $ARGUMENTS`

The user just recorded a decision on a genie gate. The engine's output is above.

Tell the user in one or two lines what was recorded and what the run does next (the last line of the output). If the gate was rejected, the run has gone back for rework: say which stage.

Never run `genie approve` yourself. Human gates are approved only through this command.
