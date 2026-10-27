---
name: pr
description: genie pr stage. Pushes the run branch and opens or updates its pull request, or with a PR per slice, a slice's branch and its pull request.
user-invocable: false
---

# PR stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below). Read the forge settings with `GENIE config --json` (`config.forge`).

**If the action has a `slice`**, the run opens a PR per slice: follow "A slice's PR" at the end instead.

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

## A slice's PR

The run gives each slice its own PR into the base branch (`forge.pr_per: slice`). The slice has passed its checks and review. Its work is committed in its worktree, on its branch (`worktree.path`, `worktree.branch` in `next --json`).

1. Push the slice branch from its worktree: `git -C <worktree path> push -u origin <slice branch>`. The gate hook allows pushing only the branches of slices whose PR is being opened.
2. Write the description to `<run dir>/pr-body.<slice id>.md`:
   - **What**: the slice's goal, in one sentence.
   - **Why**: the part of intent.md this slice delivers.
   - **Changes**: what the slice changed, and the requirements it covers (`covers`).
   - **Testing**: the slice's `tests`, and how they were verified.
   - **Footer**: `genie run <run id> · slice <slice id>`, plus the slices it depends on, which have already merged.
3. Open the PR into the base with a Conventional Commits title for this slice. Squash merges make it the commit message on the base:
   `gh pr create --base <base> --head <slice branch> --title "<type>(<scope>): <slice summary>" --body-file <run dir>/pr-body.<slice id>.md`
   If the slice is being reworked, its PR already exists (`gh pr view <slice branch> --json url,state`); the push updated it. Update the description with `gh pr edit` if the change calls for it.
4. Run `GENIE done pr --slice <id>`. It checks that origin has the branch as it stands locally and that the PR is open against the base. Next, `pr.ready` waits for CI on this PR, `intent.reviewed` checks the slice against the intent, and `pr.approved` waits for the user.
5. Never merge the PR yourself: once the user approves it, the engine merges it.
6. Give the user the PR URL.
