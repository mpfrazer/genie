---
description: Set up genie in this repository (writes .genie/config.yaml)
argument-hint: "[--profile prototype|internal-tool|service|library] [--force] [--statusline]"
allowed-tools: Bash(node *), Read, Write, Edit, AskUserQuestion
---

Initialize genie for the current repository.

If the arguments below include `--statusline`, skip steps 1–4 and do only step 5. Use this to set up or repair the status line, for example after a plugin update moved the plugin's path.

1. If the arguments below don't include `--profile`, ask the user which profile fits this repo before running anything:
   - `prototype`: minimal gates; no intent review, PR approval, deploy, or release
   - `internal-tool`: full code gates, no intent review, no release stage
   - `service`: every gate on, including deploy and release approvals (default)
   - `library`: every gate on, release but no deploy

2. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" init <--profile ...> $ARGUMENTS
   ```

   If it reports that the config already exists, tell the user and ask before re-running with `--force`.

3. Read the generated `.genie/config.yaml` and summarize it for the user:
   - the profile
   - the detected verification commands
   - the forge settings
   - any `note:` lines from the output

   Point out anything that looks wrong or missing. For example, with no `test` command the `slice.verified` gate can't run automatically.

4. Tell the user that `.genie/config.yaml` should be committed, and that `.genie/runs/` is gitignored.

5. **Offer a status line.** Ask the user whether to add genie's status line. It shows the active run's stage and next step, and a ⏸ marker when a gate is waiting for them. Change nothing unless they say yes. If they do:
   - The setting goes in `.claude/settings.local.json` in this repo. That file is machine-local and not committed, which matters because the command contains this machine's absolute plugin path.
   - Read the file if it exists. Keep every other setting exactly as it is. If it already has a `statusLine`, show it to the user and ask before replacing it.
   - Set:

     ```json
     "statusLine": {
       "type": "command",
       "command": "node \"${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs\" statusline"
     }
     ```

   - If `.claude/settings.local.json` isn't covered by a `.gitignore`, mention it so the user can ignore it.
   - Tell the user the path is tied to the installed plugin version. If the status line disappears after a plugin update, `/genie:init --statusline` fixes it.

Arguments: $ARGUMENTS
