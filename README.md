# genie
A coding harness and agentic development orchestrator for Claude Code.

genie gives every repo the same gated lifecycle, run either step by step (guided) or as an orchestrated loop: spec → decompose → implement → verify → adversarial review → PR → intent review → approval → build → deploy → release. Gates are configured per repo in `.genie/config.yaml`.

See [docs/SPEC.md](docs/SPEC.md) for the design.

## Status
Walking skeleton. The deterministic engine (`engine/`) and `/genie:init` work today. The other slash commands, the subagents, and gate-enforcing hooks are next.

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
