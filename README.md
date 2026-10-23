# genie
A coding harness and agentic development orchestrator for Claude Code.

genie gives every repo the same gated lifecycle, run either step by step (guided) or as an orchestrated loop: spec → decompose → implement → verify → adversarial review → PR → intent review → approval → build → deploy → release. Gates are configured per repo in `.genie/config.yaml`.

See [docs/SPEC.md](docs/SPEC.md) for the design.

## Status
Walking skeleton. Working today: the deterministic engine (`engine/`), `/genie:init`, `/genie:approve` (human-only), and the PreToolUse hook that enforces gates. The run commands (`/genie:new`, `/genie:next`, `/genie:status`) and the subagents are next.

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
