---
description: Run the active genie run in orchestrated mode, looping until it needs you
argument-hint: "[intent, to start a new orchestrated run]"
allowed-tools: Bash(node *), Bash(git *), Bash(gh *), Read, Write, Edit, Glob, Grep, Agent, Skill
---

Run genie in orchestrated mode.

1. If an intent was given, start a new run with it: $ARGUMENTS

   Pass it on stdin, word for word:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" new --mode orchestrated --file - <<'GENIE_INTENT'
   <the intent>
   GENIE_INTENT
   ```

   If a run is already active, show `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" status` and ask whether to continue it or abort it. Never abort a run on your own.
2. Otherwise, switch the active run to orchestrated mode:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" mode orchestrated
   ```

   If genie isn't initialized here, tell the user to run `/genie:init`. If there's no active run, ask what they want built.
3. Load the `genie:orchestrate` skill and follow it from the top.
