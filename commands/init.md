---
description: Set up genie in this repository (writes .genie/config.yaml)
argument-hint: "[--profile prototype|internal-tool|service|library] [--force]"
allowed-tools: Bash(node *), Read, AskUserQuestion
---

Initialize genie for the current repository.

1. If the arguments below don't include `--profile`, ask the user which profile fits this repo before running anything:
   - `prototype`: minimal gates; no intent review, PR approval, deploy, or release
   - `internal-tool`: full code gates, no intent review, no release stage
   - `service`: every gate on, including deploy and release approvals (default)
   - `library`: every gate on, release but no deploy

2. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" init <--profile ...> $ARGUMENTS
   ```

   If it reports the config already exists, tell the user and ask before re-running with `--force`.

3. Read the generated `.genie/config.yaml` and summarize it for the user: the profile, the detected verification commands, the forge settings, and any `note:` lines from the output. Point out anything that looks wrong or missing (for example, no `test` command means the `slice.verified` gate can't run automatically).

4. Tell the user that `.genie/config.yaml` should be committed, and that `.genie/runs/` is gitignored.

Arguments: $ARGUMENTS
