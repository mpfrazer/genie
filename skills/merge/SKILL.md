---
name: merge
description: genie merge stage. Merges the approved pull request into the base branch.
user-invocable: false
---

# Merge stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

The `pr.approved` entry gate has already passed: a human approved this PR through `/genie:approve`.

1. Pick a merge method the repo allows (`gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`), preferring squash.
2. Merge: `gh pr merge <branch> --squash --delete-branch` (or the allowed method). If the forge reports required checks or reviews still pending, stop and report. Don't bypass them.
3. Update locally: `git switch <base> && git pull --ff-only`.
4. Run `GENIE done merge`. Next, `build.passed` runs the release build on the base branch.
