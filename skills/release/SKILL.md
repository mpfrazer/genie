---
name: release
description: genie release stage. Versions, tags, and publishes using the repo's own release process.
user-invocable: false
---

# Release stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below). Read `config.release` from `GENIE config --json`.

The `release.approved` entry gate has already passed.

1. Find how this repo releases. Look for release automation (release-please, changesets, semantic-release, goreleaser) in CI config and the repo root. **If there is automation, follow it** (for example, point the user to the release PR it opened) instead of tagging by hand.
2. Without automation:
   - Choose the next version per `release.versioning`, from the commits since the last tag (Conventional Commits: `feat` is minor, `fix` is patch, `!` is major).
   - If version numbers live in files, they need a release PR, because the base branch only changes through PRs. Open one, then stop and tell the user.
   - Otherwise tag the merged commit and push the tag: `git tag v<version> && git push origin v<version>`. Then create the release: `gh release create v<version> --generate-notes`.
   - If `release.publish` is set, run it.
3. Run `GENIE done release`.
