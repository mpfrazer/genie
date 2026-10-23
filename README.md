# genie
A coding harness and agentic development orchestrator for Claude Code.

genie gives every repo the same gated lifecycle, run either step by step (guided) or as an orchestrated loop: spec → decompose → implement → verify → adversarial review → PR → intent review → approval → build → deploy → release. Gates are configured per repo in `.genie/config.yaml`.

See [docs/SPEC.md](docs/SPEC.md) for the design.

## Status
Guided mode works end to end, verified live on a real GitHub repo: intent → spec → plan → implement → verify → adversarial review → integrate → PR → CI → approval → squash merge → build. The deploy and release stages are implemented but not yet exercised against a real repo. Start with `/genie:init`, then `/genie:new "<intent>"`. Each `/genie:next` advances one stage; approve human gates with `/genie:approve <gate>`, and stop a run with `/genie:abort`. Subagents implement the plan (`implementer`) and review it (`adversarial-reviewer`, `intent-reviewer`). A PreToolUse hook enforces the gates. Orchestrated mode, `/genie:run`, loops until the run needs you, running ready slices in parallel in their own git worktrees and merging each onto the run branch as it passes; it's covered by end-to-end tests but not yet verified live. Budgets are next.

## Install
The repo is its own plugin marketplace (`.claude-plugin/marketplace.json`, marketplace name `genie`). In Claude Code:

```
/plugin marketplace add mpfrazer/genie
/plugin install genie@genie
```

or, in one step on Claude Code 2.1.275 or later:

```
/plugin install genie --marketplace mpfrazer/genie
```

The repository is private, so installing needs git access to `mpfrazer/genie` on that machine. Installs track the marketplace's default branch, and `/plugin marketplace update genie` pulls the latest. Tagged versions are published as [GitHub releases](https://github.com/mpfrazer/genie/releases). Pinning an install to a tag hasn't been verified yet.

Then, in a repo: `/genie:init`. It also offers to add genie's status line to `.claude/settings.local.json`.

## Development
```sh
cd engine
npm install
npm run check      # typecheck + tests + build
```

`engine/dist/genie.mjs` is a committed single-file bundle, so the plugin runs without an install step. Rebuild it (`npm run build`) and commit it alongside engine changes.

To try the plugin locally:
```sh
claude --plugin-dir /path/to/genie
```

## Versioning and releases
genie uses [Semantic Versioning](https://semver.org), driven by [Conventional Commits](https://www.conventionalcommits.org) and [release-please](https://github.com/googleapis/release-please):

1. Land changes on `main` through squash-merged PRs. CI requires the PR title to be a conventional commit (`feat: …`, `fix(engine): …`, `feat!: …` for breaking changes).
2. On every push to `main`, release-please updates an open **release PR**. That PR bumps the version in every manifest and adds the new entries to `CHANGELOG.md`.
3. Merging the release PR tags `vX.Y.Z` and publishes a GitHub release.

Before 1.0, `feat` bumps the minor version and `fix` bumps the patch version. The version of record is `.claude-plugin/plugin.json` (`genie --version` reads it). `scripts/check-versions.mjs` fails CI if any version field drifts from it.

## Contributing
All changes go through pull requests. Nothing is pushed straight to `main`. This repo's plan doesn't offer GitHub branch protection, so each clone should enable the local guard, which refuses pushes to `main`:

```sh
git config core.hooksPath .githooks
```
