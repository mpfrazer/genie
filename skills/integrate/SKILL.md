---
name: integrate
description: genie integrate stage. Brings the run branch up to date with its base branch and resolves conflicts before verification.
user-invocable: false
---

# Integrate stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

**If `run.delivery` is `slice`** (in `GENIE next --json`), every slice has already merged into the base through its own PR, and there's no run branch to integrate. Make the main checkout current with the base instead:

1. Check the main checkout has no uncommitted changes. If it has, stop and report: they aren't the run's.
2. `git switch <base>`, then `git pull --ff-only origin <base>`.
3. If `feedback` is present, `integration.verified` failed before: the fix comes from the fix-up slice the engine added, which has merged by now.
4. Run `GENIE done integrate`. The `integration.verified` gate then runs the full verification suite on the base.

Otherwise, every slice is already committed on the run branch, so integration means making that branch current with its base.

1. Make sure you're on the run branch (`run.branch`) with a clean working tree.
2. If the repo has a remote, run `git fetch origin` and merge the base in with `git merge origin/<base>`. Use a plain merge: no rebase, and no force-pushing later. Otherwise merge the local base branch.
3. Resolve any conflicts so that both sides' intent survives. Run the affected tests. Commit the merge.
4. If `feedback` is present, `integration.verified` failed. Read the evidence log. If the failure is in the run's own code, it's normally routed back to implement; here, fix only integration issues.
5. Run `GENIE done integrate`. The `integration.verified` gate then runs the full verification suite on the branch.
