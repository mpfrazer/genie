---
description: Start a genie run from an intent, then draft its spec
argument-hint: "<what to build and why>"
allowed-tools: Bash(node *), Bash(git *), Bash(gh *), Read, Write, Edit, Glob, Grep, Agent, Skill
---

Start a new genie run.

1. The intent is: $ARGUMENTS

   If that's empty, ask the user what they want built and why. One or two sentences is enough. Don't invent an intent.
2. Create the run. Pass the intent on stdin, word for word, so no quoting can mangle it:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" new --file - <<'GENIE_INTENT'
   <the intent>
   GENIE_INTENT
   ```

   - If genie isn't initialized here, tell the user to run `/genie:init` first.
   - If a run is already active, show the output of `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" status`. Ask whether to continue it (`/genie:next`) or abort it. Never abort a run on your own.
3. Load the `genie:drive` skill and follow it from the top. It drafts the spec and stops when the spec needs the user's approval.
