---
description: Show the active genie run - stages, gates, and what happens next
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" status`

Summarize this for the user in a few lines:

- Where the run is.
- Any gates that failed, were escalated, or are waiting.
- The next step, and who takes it: Claude with `/genie:next`, or the user with `/genie:approve <gate>`.

Don't run anything else.
