---
description: Advance the active genie run by one stage (guided mode)
allowed-tools: Bash(node *), Bash(git *), Bash(gh *), Read, Write, Edit, Glob, Grep, Agent, Skill
---

Where the run stands:

!`node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" next`

Load the `genie:drive` skill and follow it. It does this stage's work and gates, then stops for the user.
