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
   - If a run is already active, show the output of `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" status`. Ask whether to continue it (`/genie:next` one step at a time, or `/genie:run` to loop until it needs them) or abort it. Never abort a run on your own.
3. Load the `genie:drive` skill and follow it from the top. It drafts the spec and stops when the spec needs the user's approval.

This starts a guided run: each `/genie:next` does one step and stops. For a run that keeps going on its own, the user can start with `/genie:run <intent>` instead, or type `/genie:run` now to switch this one. `mode.default: orchestrated` in `.genie/config.yaml` makes that the default.
