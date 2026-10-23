# genie — Specification (v0 draft)

> Status: **draft for discussion**. Sections marked **[OPEN]** need a decision.

## 1. Purpose

genie is a Claude Code plugin that gives every repo the same development lifecycle, from idea to release. It runs in two modes over a single pipeline:

- **Guided mode**: linear and human-paced. genie runs one stage, shows what it produced, and waits for you before moving on. It is a structured co-pilot.
- **Orchestrated mode**: a looping engine. genie decomposes the work, runs slices in parallel through subagents, enforces gates automatically, and stops only where a gate needs a human (or when a budget or failure limit is hit).

Both modes use the same stages, artifacts, and gates. The difference is **who advances the pipeline**: you, or the engine.

### Goals
- Consistent workflow, artifacts, and quality bar across all repos.
- Gates are explicit, inspectable, and configurable per repo.
- Runs are durable and resumable: state lives on disk, not in a context window.
- Parallel work never conflicts: one git worktree per slice.
- Safe by default: irreversible or outward-facing steps (push, merge, deploy, release) are gated.

### Non-goals (for now)
- Replacing CI/CD systems. genie *invokes* and *waits on* them; it is not one.
- Multi-repo / monorepo-wide orchestration (single repo per run in v1).
- A UI beyond Claude Code itself (status line / commands only in v1).

## 2. Core concepts

| Concept | Definition |
|---|---|
| **Run** | One end-to-end execution of the pipeline for a piece of intent (feature, fix, chore). Has an ID, a mode, and a state. |
| **Intent** | The original "what and why" from the human. It is immutable once approved and serves as the reference for intent review. |
| **Spec** | A structured elaboration of intent: requirements, acceptance criteria, constraints, non-goals, risks. |
| **Slice** | An independently implementable, testable, reviewable unit of work decomposed from the spec. Has dependencies on other slices (DAG). |
| **Stage** | A step in the pipeline that produces an artifact (spec, plan, diff, PR, build, release). |
| **Gate** | A checkpoint between stages that returns a verdict on an artifact. Gates are where configuration lives. |
| **Profile** | A named preset of gate settings (e.g. `internal-tool`, `service`, `library`). A repo picks a profile and can override it. |

## 3. Pipeline

```
 Intake ──▶ Spec ──▶ Decompose ──▶ ┌─ per slice (parallel, DAG-ordered) ─────────────────┐ ──▶ Integrate ──▶ PR ──▶ Intent Review ──▶ Approval ──▶ Merge ──▶ Build ──▶ Deploy ──▶ Release
                                   │ Implement ─▶ Verify ─▶ Adversarial Review ─▶ Commit │
                                   └──────────────────────────────────────────────────────┘
```

Each stage has optional **entry gates** (which must pass before its work starts) and **exit gates** (which must pass before the stage completes):

| Stage | Entry gates | Work | Exit gates |
|---|---|---|---|
| `spec` | | write `spec.md` | `spec.approved` |
| `decompose` | | write `plan.yaml` (validated) | `plan.approved` |
| `implement` | | code + tests, **per slice** | per slice: `slice.verified`, `slice.reviewed` |
| `integrate` | | merge slices onto the run branch | `integration.verified` |
| `pr` | | push, open PR | `pr.ready`, `intent.reviewed` |
| `merge` | `pr.approved` | merge | |
| `build` | | (gate only) | `build.passed` |
| `deploy` | `deploy.approved` | deploy | `deploy.healthy` |
| `release` | `release.approved` | version, changelog, tag, publish | |

The gates:

| # | Gate | Default kind | Checks | On fail |
|---|---|---|---|---|
| G1 | `spec.approved` | human | Spec is complete and matches intent | Revise spec |
| G2 | `plan.approved` | human (guided) / agent (orchestrated) | Slices cover the spec, are independent enough, the DAG is acyclic, sizing is reasonable | Re-decompose |
| G3 | `slice.verified` | automated | Build, lint, typecheck, tests (repo-defined commands) | Back to that slice (retry budget) |
| G4 | `slice.reviewed` | agent (adversarial) | Correctness, security, test adequacy, scope creep vs. slice | Back to that slice with findings |
| G5 | `integration.verified` | automated | Full suite on the integrated branch | Back to Implement as a fix-up slice |
| G6 | `pr.ready` | automated | PR created, description generated, CI green | Fix and re-push |
| G7 | `intent.reviewed` | agent | Final diff vs. original **intent** (not spec): did we build the right thing? | Back to Spec or Decompose |
| G8 | `pr.approved` | human | Human (or required reviewers) approve | Address review comments, back to Implement |
| G9 | `build.passed` | automated | Release build artifact produced | Halt |
| G10 | `deploy.approved` / `deploy.healthy` | human + automated | Approval to deploy; post-deploy health checks | Rollback hook, halt |
| G11 | `release.approved` | human | Version, changelog, tag, publish | Halt |

### 3.1 Plan and slices

**plan.yaml** is the decompose stage's contract (schema: `schema/plan.schema.json`):

```yaml
slices:
  - id: S1                 # branch-safe: letter, then letters/digits/-/_ (max 32)
    title: Greeting for valid names
    goal: greet(name) returns "Hello, <name>!"
    covers: [R1, R2]       # requirement ids from spec.md
    touches: [src/greet.js] # optional
    tests: [greet('Ada') returns 'Hello, Ada!']
    depends_on: []
```

`genie done decompose` validates it and reports every problem at once:
- the schema
- unique ids, and dependencies that exist and aren't self-references
- no dependency cycles (reported as a path, e.g. `A → C → B → A`)
- every requirement id (`R<n>`) in spec.md covered by some slice, and no slice covering an id spec.md doesn't have (skipped if the spec numbers no requirements)

The validated plan is then **snapshotted into run state**, so later edits to the file can't silently change a run in progress. Redoing decompose records the new plan.

**Per-slice state.** Each slice has its own phase (`work` → `exit` → `passed`), author, and its own `slice.verified` / `slice.reviewed` gate state: status, attempts, failures, and agent pre-review. These gates are tuned under `gates:` like any other, but they're evaluated once per slice.
- A slice is **ready** once every slice in its `depends_on` has passed.
- A failed slice gate reworks **only that slice**, against its own retry budget, escalation, and halt rules.
- The implement stage passes once every slice has.
- The author rule applies per slice: whoever did a slice's work can't review it.

**Fix-up slices.** When a run-level gate routes the run back to implement (`integration.verified`, or a human rejecting `pr.approved`), the engine appends a fix-up slice `F<n>`. It records which gate it `fixes`, its feedback is that gate's failed verdict, and it goes through the same slice gates. A fix is reviewed like any other change, and the passed slices aren't disturbed. A rework that goes back to spec or decompose discards the slices; the next plan replaces them.

**Actions.**
- `nextActions(state, config)` returns everything actionable now, in plan order. In the implement stage that's one action per ready slice: its work, its pending gate, or a human decision when that gate escalated. Elsewhere it's exactly one action.
- `nextAction` is the first of these, and it's what guided mode follows: slices one at a time, in plan order, each through its gates before the next starts.
- An orchestrator can run the whole `nextActions` list concurrently. `genie next --json` exposes it as `actions`, each with its own `feedback`.

**State version 2.** Older v1 state upgrades on load. Runs still planning (at spec, or decompose before its exit gates) and finished or aborted runs upgrade cleanly. An active v1 run past planning has no slices to resume, so it loads as **halted** with an explanation. `genie abort` still works on it.

## 4. Gates

### 4.1 Gate model
Every gate has the same shape:

```yaml
gate: slice.reviewed
enabled: true            # false = skipped, and the skip is recorded in the run log
kind: agent              # automated | agent | human | agent+human
evaluator: adversarial-reviewer   # agent name, or a command for automated gates
blocking: true           # false = advisory: record findings, don't stop
retries: 3               # automatic fix→re-evaluate loops before escalating to a human
escalate_to: human       # what happens when retries are exhausted
```

Verdicts: `pass` | `fail` (with structured findings) | `needs_human` | `skipped`.

Every verdict is written to the run log with its evidence, so you can always answer "why did this ship?"

### 4.2 Gate kinds
- **automated**: a shell command; the exit code decides. Output is captured as evidence.
- **agent**: a subagent with a fixed rubric that returns structured findings. Adversarial gates use a *different* agent (and ideally a fresh context) from the one that wrote the code.
- **human**: the engine pauses and notifies. In guided mode every stage boundary is effectively a human gate.
- **agent+human**: an agent pre-reviews and the human decides with the agent's findings in hand.

### 4.3 Stages vs. gates
Disabling a **stage** means "don't do this step at all" (`stages.release.enabled: false`, so this repo doesn't release).
Disabling a **gate** means "do the step without this check" (`gates.intent.reviewed.enabled: false`).
These are deliberately separate. Turning off `release.approved` would mean *releasing without approval*, not *skipping releases*.

### 4.4 Invariants (not configurable)
- An agent can never satisfy a `human` gate.
- The author agent of an artifact never evaluates that artifact's gate.
- Skipped gates are logged, never silent.
- `push`, `merge`, `deploy`, and `release` actions are blocked by hooks unless their preceding gate has a recorded `pass`.
- The engine accepts each verdict only from its own source: automated gates take verdicts only from `genie gate --run`, agent gates only from agents, and human gates only from `genie approve`.

### 4.5 The human approval channel
`genie approve` is the only way a human gate is satisfied, so it must be unreachable by the model:
- `/genie:approve` is a slash command with `disable-model-invocation: true`. It runs the CLI through `!` pre-execution, not through the Bash tool.
- The PreToolUse hook (§4.6) denies any Bash tool call that invokes `genie approve`, including through `sh -c`, `eval`, `env`, or a `node …/genie.mjs` path.

Verified against Claude Code with a probe plugin and the real plugin (2026-10-22):

| Behavior | Result |
|---|---|
| PreToolUse fires for a slash command's `!` pre-execution | **No**: only UserPromptSubmit fires. `/genie:approve` therefore isn't blocked by the hook that blocks the model. |
| `disable-model-invocation: true` stops the model invoking the command | **Yes**: the Skill tool rejects it. |
| UserPromptSubmit as an approval channel | **Rejected**: it also fires for system task notifications, so it isn't human-only. |
| `!` commands containing a raw `$VAR` | **Refused** before running ("can't be checked before it runs"). Use the substituted `${CLAUDE_PLUGIN_ROOT}` placeholder instead. |
| Subagent identity in hook input | `agent_type` is the namespaced agent name (e.g. `genie:adversarial-reviewer`). It is absent in the main session. |

Not yet verified: whether PreToolUse fires for user-typed `! cmd` bash-mode commands. This can only be tested interactively.

### 4.6 Enforcement hook
`hooks/hooks.json` runs `genie hook pre-tool-use` before every `Bash`, `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` call. The hook reads the command and splits it into simple commands, seeing through `&&`, `;`, pipes, `$(…)`, backticks, `sh -c`, `eval`, `env`/`sudo` wrappers, and `git -C`. It then classifies each one:

| Action | Recognized as | Rule |
|---|---|---|
| Approve | `genie approve …` | Always denied: the model can't satisfy human gates. |
| Record | `genie gate … --verdict`, `genie done` | `--by` must equal the caller: the subagent's name, or `claude` for the main session. Authors can't impersonate reviewers. |
| State write | writes/redirects to `.genie/runs/{CURRENT,<id>,<id>/state.json,log.jsonl,evidence}` | Always denied. Stage artifacts (`spec.md`, `plan.yaml`) stay writable. Readers and `cd` into a run dir are allowed; relative paths are resolved against the session cwd and every directory the command `cd`s into, so `cd <run dir> && echo x > state.json` is still caught. |
| Config write | writes to `.genie/config.yaml` | **Ask**: the user confirms, because it changes which gates apply. |
| Push to base | `git push` that updates `forge.base_branch` (explicitly, implicitly from it, `--all`/`--mirror`, delete) | Denied when `enforcement.protect_base_branch` (default on). |
| Push / open PR | `git push`, `gh pr create`, `glab mr create` | Allowed once the run reaches `pr`. |
| Merge | `gh pr merge`, `glab mr merge` | Allowed once `merge`'s entry gate (`pr.approved`) passes. |
| Deploy | commands starting with `deploy.command` | Allowed once `deploy.approved` passes. |
| Release | `git tag <name>`, pushing tags, `gh release create/edit/upload/delete`, `npm`/`pnpm`/`yarn`/`bun`/`cargo publish`, `gem push`, `twine upload`, `release.publish` | Allowed once `release.approved` passes. |

Outside an active run, outward actions are allowed unless `enforcement.outside_run: deny`. In repos without `.genie/config.yaml`, the hook does nothing. `enforcement.enabled: false` turns off the progress gating but never the first four rows.

Failure handling: if the config or run state can't be read while a protected action is being judged, the hook **fails closed** (deny, with the error). If the hook payload itself is unreadable, or the engine has a bug, the hook **fails open** with a stderr warning, so a broken hook never wedges the session.

**Known limits (defense in depth, not a sandbox):** the model runs with the user's OS permissions. Indirect execution the hook can't see (a script file that calls `genie approve`, an interpreter one-liner that writes `state.json`, a variable holding the command) gets past it. The append-only log plus `by`/`source` on every verdict keeps such tampering visible. Hardening options for later: sign verdicts with a key the hook process holds, and have the engine verify the log against the state.

## 5. Per-repo configuration

Location: `.genie/config.yaml`, committed to the repo.

Precedence (lowest to highest): plugin defaults → profile → user (`~/.genie/config.yaml`) → repo → run-time flags.

```yaml
version: 1
profile: service              # internal-tool | service | library | prototype

mode:
  default: guided             # guided | orchestrated
  max_parallel_slices: 4

commands:                     # how genie verifies things in this repo
  install: npm ci
  build: npm run build
  lint: npm run lint
  typecheck: npm run typecheck
  test: npm test
  test_changed: npm test -- --changed

forge:
  provider: github            # github | gitlab | none
  base_branch: main
  branch_prefix: genie/
  pr_draft_until: intent.reviewed

stages:                       # turn whole steps on/off
  release:
    enabled: false            # this repo doesn't release

gates:                        # tune or disable individual checks
  intent.reviewed:
    enabled: false            # e.g. internal tooling
  slice.reviewed:
    retries: 2
  deploy.approved:
    kind: human

deploy:
  command: ./scripts/deploy.sh {env}
  health_check: ./scripts/health.sh {env}
  rollback: ./scripts/rollback.sh {env}
  environments: [staging, production]

release:
  versioning: semver          # semver | calver | none
  changelog: conventional-commits
  publish: npm publish

enforcement:                  # PreToolUse hook (§4.6)
  enabled: true               # gate push/PR/merge/deploy/release on run progress
  protect_base_branch: true
  outside_run: allow          # allow | deny outward actions with no active run

budgets:                      # orchestrated-mode safety rails
  max_iterations_per_slice: 5
  max_run_duration: 4h
  max_cost_usd: 50
```

### Built-in profiles
The Deploy and Release columns are **stages**; the other columns are gates. `genie init` also disables the deploy stage until `deploy.command` is set.

| Profile | Intent review | Adversarial review | Human PR approval | Deploy | Release |
|---|---|---|---|---|---|
| `prototype` | off | advisory | off | off | off |
| `internal-tool` | off | on | on | human | off |
| `service` | on | on | on | human + health | human |
| `library` | on | on | on | off | human |

## 6. Mapping to Claude Code plugin primitives

| Primitive | Use in genie |
|---|---|
| **Slash commands** | Built: `/genie:init`, `/genie:new <intent>`, `/genie:next` (guided step), `/genie:status`, `/genie:approve <gate>`, `/genie:abort`. The last two are user-only: `disable-model-invocation`, and the hook denies the model running `genie approve` / `genie abort`. Planned: `/genie:run` (orchestrate). |
| **Skills** | The stage playbooks (`spec`, `decompose`, `implement`, `review`, `pr`, `release`). They are loaded on demand so each stage gets precise instructions without bloating context. |
| **Subagents** | `spec-writer`, `decomposer`, `implementer`, `adversarial-reviewer`, `intent-reviewer`, `integrator`, `release-manager`. Each has scoped tools. Reviewers are read-only. |
| **Hooks** | Enforcement: `PreToolUse` blocks `git push`, `gh pr merge`, and deploy/release commands without a passing gate. `SessionStart` loads active-run context. `Stop`/`SubagentStop` record stage completion. |
| **State / engine** | See §7. |
| **Status line** | Plugins can't ship the main status line; only user/project `settings.json` can set it. `/genie:init` offers to add `statusLine` to `.claude/settings.local.json`, which is machine-local because the plugin path is absolute. It runs `genie statusline`, which reads Claude Code's payload (`workspace.current_dir`) and prints e.g. `genie Add a greeting ▸ spec/exit · ⏸ /genie:approve spec.approved`. It prints nothing without an active run, and never fails. `/genie:init --statusline` repairs the path after a plugin update. |

### Repo layout (plugin)
```
genie/
├── .claude-plugin/plugin.json
├── commands/            # slash commands
├── agents/              # subagent definitions
├── skills/              # stage playbooks
├── hooks/hooks.json     # gate enforcement + lifecycle
├── schema/              # JSON Schema for config (editor support + runtime validation)
└── engine/              # TypeScript state machine + CLI (see §7)
    ├── src/config/      # defaults, profile overlays, loader
    └── dist/genie.mjs   # committed single-file bundle: the plugin runs with no npm install
```

### Per-repo layout (created by `/genie:init`)
```
.genie/
├── config.yaml          # committed
├── runs/                # gitignored by default
│   └── <run-id>/
│       ├── state.json   # current stage, slice statuses, gate verdicts
│       ├── intent.md
│       ├── spec.md
│       ├── plan.yaml    # slices + DAG (§3.1), with an optional plan.md companion
│       ├── evidence/    # check logs and review findings, per gate attempt
│       └── log.jsonl    # append-only event + verdict log
```

## 7. Engine architecture

> **Decided (2026-10-22): Option B, a deterministic `genie` CLI written in TypeScript/Node.** Option C (MCP) may be layered on later.

The key decision is **where the loop and state machine live**.

- **A. Prompt-driven**: Claude is the orchestrator. The skills/commands describe the pipeline and Claude follows them, spawning subagents. Simplest, but non-deterministic: loops drift, gates can be "forgotten," and long runs are hard to resume.
- **B. Deterministic engine + Claude as worker** *(recommended)*: a small `genie` CLI owns `state.json`, the transition rules, gate evaluation for automated gates, and budgets. Claude (commands/agents) asks the engine "what's next?", does the work, and reports results back. Hooks call the same CLI to enforce gates. This makes it deterministic, resumable, and testable. Claude does the judgment work and the engine does the bookkeeping.
- **C. Engine as MCP server**: same as B but exposed as MCP tools (`genie_next`, `genie_report`, `genie_gate`). It has richer typed I/O but more moving parts. It could be layered on B later.

### Engine CLI (v0)
Each command prints text by default; pass `--json` for output Claude can parse.

| Command | Effect |
|---|---|
| `genie init [--profile p]` | Detect commands/forge, write `.genie/config.yaml` and `.genie/.gitignore` |
| `genie config` | Print the resolved config and its sources |
| `genie new "<intent>"` | Create a run and write `intent.md` |
| `genie status` / `genie next` | Show the run (with per-slice progress), or only the next actions |
| `genie done <stage> [--slice <id>]` | Mark stage work complete (checks the required artifact; validates plan.yaml for decompose), or one slice's work in implement |
| `genie gate <g> --run [--slice <id>]` | Run an automated gate's checks, record the verdict and its evidence |
| `genie gate <g> --verdict … --by <agent> --findings <file> [--slice <id>]` | Record an agent verdict (the stage or slice author is refused). The findings file is required, pass or fail, and is copied into the run's evidence. |
| `genie approve <g> [--reject] [--slice <id>]` | Record a human decision (see §4.5) |

`--slice` names the slice for slice gates and implement work. It can be left out when exactly one slice is waiting.
| `genie abort` | Abort the run |
| `genie hook pre-tool-use` | The enforcement hook (§4.6): reads Claude Code's payload on stdin, prints a deny/ask decision or nothing |

A failed gate sends the run back to its rework stage and resets the gates in between. Once the retry budget is used up, the gate escalates to `needs_human` (or halts). A human rejection sends the work back with a fresh retry budget.

### Parallel slices
Each slice runs in its own git worktree, on its own slice branch. Finished slices merge onto the run branch `genie/<run>`, which becomes the PR. `engine/src/worktree.ts` implements this; it isn't wired in yet.

| | Name / location |
|---|---|
| Run branch | `genie/<run-id>` (`state.branch`) |
| Slice branch | `genie/<run-id>--<slice-id>` |
| Slice worktree | `.genie/worktrees/<run-id>/<slice-id>` (gitignored by `genie init`) |
| Integration worktree | `.genie/worktrees/<run-id>/_integration`, only when needed |

- **Branch naming.** Slice branches are siblings of the run branch, not children: git can't hold both `genie/<run>` and `genie/<run>/S1`. Run ids never contain `--` (slugify collapses dash runs), so the suffix can't collide with another run. Slice ids are letters, digits, `_` and single dashes, start alphanumeric, and are checked with `git check-ref-format`.
- **Where merges happen.** Git won't check a branch out twice, so a slice merges (`--no-ff`, one merge commit per slice) wherever the run branch is already checked out; in guided mode that's usually the user's main checkout. If it isn't checked out anywhere, a dedicated integration worktree is used, leaving the user's checkout alone. On conflict the merge is aborted, and the conflicting files are returned for the orchestrator to route back to the slice's implementer. Both branches are left exactly as they were.
- **Safety.** Removing a slice refuses, before changing anything, when its worktree has uncommitted (including untracked) changes or its branch has commits not on the run branch, unless forced. Pruning checks every slice first.

Integration points for orchestrated mode:
- **Dispatch.** When a slice becomes ready, `createSliceWorktree` gives its implementer subagent a working directory. Its `done`/gate calls carry the slice id.
- **Merging.** After a slice passes `slice.verified` and `slice.reviewed`, `mergeSlice` lands it on the run branch. A `conflict` result routes back to that slice with the file list as feedback.
- **Cleanup.** After `integrate` passes, or on abort, `pruneRunWorktrees` cleans up (forced on abort).

## 8. Modes in detail

### Guided
`/genie:next` advances exactly one stage, shows the artifact, and stops. Slices run sequentially by default. The human can edit any artifact on disk before continuing, and genie re-reads from disk.

How it works:
- **Commands.** `/genie:new` (create the run, then drive) and `/genie:next` (drive) both load the `genie:drive` skill. It loops on `genie next --json`, which returns the run context, the action, and `feedback` (the failed verdict and its evidence) when a stage is being reworked.
- **Who does each stage's work.**
  - Main-session stages load their playbook skill: `genie:spec`, `decompose`, `integrate`, `pr`, `merge`, `deploy`, `release`.
  - `implement` is delegated to the `implementer` subagent.
  - Agent gates are delegated to their evaluator (`adversarial-reviewer`, `intent-reviewer`). Each subagent records `done` or its verdict itself, and the hook binds `--by` to the caller.
  - The main session never does a delegated stage's work. If a subagent is blocked, the driver stops and reports. The next delegation resumes from the run branch.
- **Where the driver stops.** At a human gate, after a gate failure (with a summary of why), when the stage it started on passes (in implement: when the slice it started on passes), or on an error.
- **Slices.** The implementer and adversarial reviewer each work on one slice per invocation, with the slice in their prompt. Implementer commits carry a `Genie-Slice: <id>` trailer, so reviewers can isolate the slice's commits on the shared run branch.
- **Run branches.** Each run records `branch` (`forge.branch_prefix` + run id) and `base`. `genie done` refuses `implement` and `integrate` unless the work is committed on the run branch, ahead of the base.
- **CI gate.** `pr.ready` runs `forge.ci_command`. For GitHub repos that have workflow files, `genie init` sets a command that first waits up to 2 minutes for checks to register, then runs `gh pr checks --watch`. Right after a push, `gh pr checks` reports "no checks reported" (exit 1) until the forge registers the workflow runs, so watching immediately would fail fresh PRs. Without workflows, `ci_command` stays unset and `pr.ready` goes to a human.

Verified end to end on 2026-10-22:
- **Local scratch repo.** Six separate headless Claude Code sessions took it from intent through spec, plan, implementation, verification, adversarial review, and integration. State resumed from disk each time.
- **Real GitHub repo** (private `mpfrazer/genie-sandbox`, squash-only, with Actions CI). Ten sessions took a run through every enabled stage to `done`:
  - spec → plan → implementer → `slice.verified` → adversarial review → integrate (fetch and merge `origin/main`)
  - pr: push, then `gh pr create` with a conventional title and `pr-body.md` as the body
  - `pr.ready`: watched CI from pending to pass
  - `pr.approved` via `/genie:approve`
  - merge: squash, the only allowed method; branch deleted; local `main` fast-forwarded
  - `build.passed` on `main` at the merge commit
- **Attribution.** The audit log credited `claude`, `human`, `implementer`, `adversarial-reviewer`, and `genie` correctly in both runs.
- **Hook gating against real run state.** `git push` of the run branch is denied until the `pr` stage. `gh pr merge` is denied until `pr.approved` passes, including at the merge stage while the approval is pending.

### Orchestrated
`/genie:run` loops: ask engine for ready work → dispatch subagents (up to `max_parallel_slices`) → evaluate gates → route failures back with findings → repeat. It halts on:
- a pending `human` gate (notify, then wait for `/genie:approve`),
- an exhausted retry budget on any gate,
- a run budget (time/cost/iterations),
- `/genie:abort`.

Modes are switchable mid-run (`/genie:run` on a guided run, or Ctrl-C to drop back to guided).

## 9. Open questions
1. ~~**Engine language/runtime**~~: **Decided: TypeScript/Node.**
2. **Forge scope for v1**: GitHub only (via `gh`) or abstract GitLab from day one?
3. **Issue tracker integration**: should intake pull from Linear/Jira/GitHub Issues, or start from a prompt only?
4. **Where human approvals happen**: only in Claude Code, or also via PR review state on GitHub (G8 = "PR approved on GitHub")?
5. **Intent review input**: the original intent only, or intent + spec + linked issue?
6. **Slice merge strategy**: integration branch → single PR (proposed), or one PR per slice (stacked PRs)?
7. **Run artifacts in git**: gitignore `runs/` (proposed) or commit specs/plans as permanent design records?
8. **Notifications** for pending human gates in orchestrated mode: terminal only, or push/Slack?
