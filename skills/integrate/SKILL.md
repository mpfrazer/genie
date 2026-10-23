---
name: integrate
description: genie integrate stage. Brings the run branch up to date with its base branch and resolves conflicts before verification.
user-invocable: false
---

# Integrate stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

In guided mode every slice is already committed on the run branch, so integration means making that branch current with its base.

1. Make sure you're on the run branch (`run.branch`) with a clean working tree.
2. If the repo has a remote, run `git fetch origin` and merge the base in with `git merge origin/<base>`. Use a plain merge: no rebase, and no force-pushing later. Otherwise merge the local base branch.
3. Resolve any conflicts so that both sides' intent survives. Run the affected tests. Commit the merge.
4. If `feedback` is present, `integration.verified` failed. Read the evidence log. If the failure is in the run's own code, it's normally routed back to implement; here, fix only integration issues.
5. Run `GENIE done integrate`. The `integration.verified` gate then runs the full verification suite on the branch.
