---
name: pr
description: genie pr stage. Pushes the run branch and opens or updates its pull request.
user-invocable: false
---

# PR stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below). Read the forge settings with `GENIE config --json` (`config.forge`).

1. Make sure you're on `run.branch` with a clean working tree.
2. Push it: `git push -u origin <branch>`. The gate hook allows pushing from this stage on, but never to the base branch.
3. Write the PR description to `<run dir>/pr-body.md`:
   - **What**: one sentence.
   - **Why**: from intent.md.
   - **Changes**: by slice from plan.yaml, including any fix-up slices (`genie status` lists them).
   - **Testing**: how it was verified.
   - **Footer**: `genie run <run id>`.
4. Open the PR with a Conventional Commits title. Squash merges make the PR title the commit message:
   `gh pr create --base <base> --head <branch> --title "<type>(<scope>): <summary>" --body-file <run dir>/pr-body.md`
   If a PR already exists for the branch (`gh pr view <branch> --json url`), update it with `gh pr edit` instead.
   If `forge.provider` is `gitlab`, use `glab mr create` with the same content. If it's `none`, skip the PR and tell the user.
5. Run `GENIE done pr`. Next, `pr.ready` runs `forge.ci_command`, which waits for CI on the PR. Then `intent.reviewed` runs, if enabled.
6. Give the user the PR URL.
