---
name: deploy
description: genie deploy stage. Runs the repo's deploy command for each configured environment.
user-invocable: false
---

# Deploy stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below). Read `config.deploy` from `GENIE config --json`.

The `deploy.approved` entry gate has already passed.

1. For each environment in `deploy.environments`, in order, run `deploy.command` with `{env}` replaced by that environment.
2. Stop at the first failure and report its output. If `deploy.rollback` is configured, ask the user before running it. Never roll back on your own.
3. When every environment has deployed, run `GENIE done deploy`. Next, `deploy.healthy` runs `deploy.health_check` for each environment.
