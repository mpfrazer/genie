---
name: decompose
description: genie decompose stage. Breaks a run's spec.md into ordered, independently testable slices in plan.yaml.
user-invocable: false
---

# Decompose stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

1. Read `<run dir>/spec.md` (and `intent.md` for context). If `feedback` is present, the previous plan was rejected: by the user (their note), or in orchestrated mode by the plan reviewer (its findings are in `feedback.evidence`). Revise the plan to address every point.
2. Write `<run dir>/plan.yaml`. It's the contract the engine runs the implement stage from:

   ```yaml
   slices:
     - id: S1                      # short and branch-safe: letters, digits, - or _
       title: Greeting for valid names
       goal: greet(name) returns "Hello, <name>!" for non-empty strings.
       covers: [R1, R2]            # requirement ids from spec.md
       touches: [src/greet.js, test/greet.test.js]
       tests:
         - greet('Ada') returns 'Hello, Ada!'
       depends_on: []              # ids of slices that must pass first
   ```

   Quote any value containing `#` or `: ` (for example `goal: "README gets a ## Usage section"`): unquoted, ` #` starts a YAML comment and `: ` starts a mapping, and the engine rejects values cut short that way.

   The schema is `${CLAUDE_PLUGIN_ROOT}/schema/plan.schema.json`. Every slice needs `id`, `title`, `goal`, `covers`, `tests` (at least one), and `depends_on`. `touches` is optional.
3. Rules:
   - Each slice is independently testable and reviewable in one sitting.
   - Dependencies form an acyclic graph. List slices in a valid order, dependencies first.
   - Every requirement id (`R1`, `R2`, …) in spec.md is covered by at least one slice, and slices cover no ids the spec doesn't have. Add nothing the spec doesn't call for.
   - Prefer vertical slices (a working path end to end) over layers (all models, then all handlers).
   - Slices with no dependency between them can later run in parallel, so don't add `depends_on` edges that aren't real.
4. Optionally write `<run dir>/plan.md` as a readable companion: the reasoning behind the cut, plus a coverage table. The user reviews both, but plan.yaml is what runs.
5. Run `GENIE done decompose`. It validates plan.yaml (schema, unique ids, known dependencies, no cycles, full requirement coverage) and lists every problem it finds. Fix them all and run it again. The `plan.approved` gate follows: the user approves the plan in guided mode, and the `plan-reviewer` agent checks it in orchestrated mode.
