# genie
A coding harness and agentic development orchestrator for Claude Code.

genie gives every repo the same gated lifecycle, run either step by step (guided) or as an orchestrated loop: spec → decompose → implement → verify → adversarial review → PR → intent review → approval → build → deploy → release. Gates are configured per repo in `.genie/config.yaml`.

See [docs/SPEC.md](docs/SPEC.md) for the design.

## Status
Guided mode works end to end, verified live on a real GitHub repo: intent → spec → plan → implement → verify → adversarial review → integrate → PR → CI → approval → squash merge → build. The deploy and release stages are implemented but not yet exercised against a real repo. Start with `/genie:init`, then `/genie:new "<intent>"`. Each `/genie:next` advances one stage; approve human gates with `/genie:approve <gate>`, and stop a run with `/genie:abort`. Subagents implement the plan (`implementer`) and review it (`adversarial-reviewer`, `intent-reviewer`). A PreToolUse hook enforces the gates. Orchestrated mode, `/genie:run`, loops until the run needs you, running ready slices in parallel in their own git worktrees and merging each onto the run branch as it passes; it was verified live on the same repo, including a merge conflict between parallel slices. By default the slices become one PR; with `forge.pr_per: slice` in the config, each slice gets its own PR into the base branch instead, which you approve and genie merges one at a time (not yet verified on a real repo). In orchestrated mode a `plan-reviewer` agent approves the plan instead of you, and budgets (`budgets:` in the config: rounds of work per slice, run time, and cost) pause the run for you when it uses them up. Run state is sealed with a per-user key, and the log is hash-chained. A run changed outside genie is refused until you accept it, and approvals count only when you type `/genie:approve` yourself. This holds even if the model reaches `genie` some way the hook can't see.

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

Installs track the marketplace's default branch, and `/plugin marketplace update genie` pulls the latest. Tagged versions are published as [GitHub releases](https://github.com/mpfrazer/genie/releases). Pinning an install to a tag hasn't been verified yet.

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
All changes go through pull requests. A ruleset on `main` enforces this on GitHub: nobody can push to `main` directly, force-push it, or delete it, and a PR merges only by squash once CI passes (both engine jobs, the plugin check, and the PR title check). Nobody bypasses it, including the owner. Release PRs need the `RELEASE_PLEASE_TOKEN` secret for CI to run on them (see `.github/workflows/release.yml`). The workflows pin each action to a commit SHA.

The local guard refuses pushes to `main` before they reach GitHub:

```sh
git config core.hooksPath .githooks
```

## License
[MIT](LICENSE)
