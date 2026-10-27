---
name: orchestrate
description: Drives the active genie run in orchestrated mode. It loops, running every ready action (parallel slice implementers and reviewers in their own worktrees), until the run needs the user. Used by /genie:run.
user-invocable: false
---

# Driving a genie run (orchestrated mode)

The engine CLI is:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"
```

Below it's written `GENIE`. Always type the full command: it isn't on PATH, and the plugin-root variable isn't set in Bash.

The engine owns the run. Never edit `.genie/runs/*/state.json`, `log.jsonl`, `CURRENT`, or `evidence/`, and never run `GENIE approve`. Hooks deny all of these. Only the user approves human gates, with `/genie:approve`. If `GENIE` reports that the run was changed outside genie, stop and tell the user. Don't try to repair the state: only they can accept it (`/genie:approve state`) or abort it.

Orchestrated mode differs from guided mode (`genie:drive`) in two ways. It keeps going across stages without stopping after each one. And in the implement stage, every ready slice runs at once, each in its own git worktree on its own branch. The engine merges each slice onto the run branch once it passes its gates, and sends it back if it conflicts.

## Loop

1. Run `GENIE next --json`. It returns:
   - `run`: id, dir, branch, base, stage, mode
   - `actions`: every action that can be taken now. Each has `action`, and may have `feedback` (why it's being reworked) and `worktree` (`path`, `branch`, and `base`, what it merges onto: the run branch, or with a PR per slice, `origin/<base>`).
   - `parallel`: the most actions to run at once.
2. Split `actions` into **human** actions (`await_human`) and **the rest**.
   - If there are none of the rest, stop (see below).
   - Otherwise take up to `parallel` of the rest and run them **all in one message**, so they run concurrently:
     - **`work` with `action.agent`**: an Agent call with `subagent_type: "genie:<agent>"`. The prompt must include the run id, run dir, branch, base, stage, `action.instructions`, the slice (all its fields), `worktree` if present, and `feedback` if present. Say plainly: "Work only in the worktree at `<path>`, on branch `<branch>`. Don't switch branches there or touch the main checkout." The subagent runs `GENIE done implement --slice <id> --by <agent>` itself.
     - **`evaluate`, `kind: "automated"`**: a Bash call to `GENIE gate <gate> [--slice <id>] --run`. Exit code 0 means pass and 2 means not passed. For a slice with a worktree, the engine runs the checks there.
     - **`evaluate`, `kind: "agent"` or `"agent+human"`**: an Agent call with `subagent_type: "genie:<evaluator>"`. The prompt must include the run id, run dir, branch, base, gate, the slice if present, and `worktree` if present. The evaluator records its own verdict with a findings file.
     - **`work` without an agent** (spec, decompose, integrate, pr, merge, deploy, release): load `action.skill` with the Skill tool and follow it. If `feedback` is present, address it first. Finish with `GENIE done <stage>`, without `--by`. These run in this session, one at a time, after the batch's Agent and Bash calls. Outside the implement stage there's only ever one. With a PR per slice, there's a `pr` action for each slice whose PR is due (`action.slice` set): open them one after another, each finishing with `GENIE done pr --slice <id>`.
3. When every call in the batch has returned, check each subagent's report, then go back to step 1.

**Never do a delegated action's work yourself**: no editing the code, no committing, no running `done` or recording verdicts for a subagent, not even to finish something it left half done. If a subagent couldn't finish, leave it: the next `GENIE next` offers that action again, and a new subagent picks up its predecessor's work in the same worktree. If the same action fails to complete twice in a row, stop and report what blocked it.

## What the engine does between calls

You don't need to do any of this; it's here so you can explain it.

- **Dispatch.** `GENIE next` creates the run branch if needed, and a worktree for each ready slice under `.genie/worktrees/<run>/<slice>`, branched from the run branch's current tip. A slice that depends on others starts with their work in it.
- **Merging.** When a slice passes its gates, the engine merges its branch onto the run branch and removes its worktree. If the merge conflicts, the slice goes back to work with `feedback.conflict` listing the files. Its implementer resolves it by merging the run branch into the slice branch, and its gates run again.
- **Cleanup.** Once implement passes, the remaining worktrees go, and later stages run in the main checkout as in guided mode.
- **A PR per slice** (`run.delivery: slice`, from `forge.pr_per: slice`). Slices branch from `origin/<base>`, not a run branch. Once a slice passes its checks and review, you open its PR (the `pr` action). Then its PR goes through `pr.ready`, `intent.reviewed` (the intent reviewer, for that slice), and `pr.approved` (the user). Once the user approves it, the engine merges the PR into the base itself, and the slices that depend on it start from there. If the PR conflicts with the base because another slice merged first, the slice goes back to its implementer with `feedback.conflict`, and its PR is checked and approved again. After the last slice merges there's no run PR: integrate updates the main checkout, and a final `intent.reviewed` covers everything that merged.
- **Failures.** A failed gate reworks only that slice or stage. Once a gate's retry budget is used up, it escalates to the user or halts the run. So does a slice that has used `budgets.max_iterations_per_slice` rounds of work.
- **The plan.** In orchestrated mode the `plan-reviewer` agent decides `plan.approved` instead of the user, so the run goes straight from the spec approval to implementation unless the reviewer sends the plan back.
- **Config.** A run follows the config it started with. If `configPending` is in `next --json`, the user has edited `.genie/config.yaml` since. Mention it in your report: `/genie:approve config` applies it.
- **Budgets.** Time counts while the run is orchestrated and not waiting on the user. Cost comes from the Claude Code status line, so it's only tracked when the user has genie's status line set up (`/genie:init` offers it).

## When to stop

Stop and report when:

- **Only human actions remain** (`await_human`). Tell the user what to review for each: artifact paths in the run dir, the PR URL (`action.slice.pr.url` for a slice's PR), the slice, and the agent's pre-review if `action.agentReview` is present. With a PR per slice, list every PR waiting for approval: approving one merges it. Then give the commands: `/genie:approve <gate> [--slice <id>]`, or the same with `--reject --note "why"`. Say that `/genie:run` carries on afterwards.
- **The run is `over_budget`.** It has used its time or cost budget (`action.reason` says which). Work already running can finish and report, but start nothing new. Tell the user what was spent, and that `/genie:approve budget` grants the configured budget again, or `/genie:abort` stops the run.
- **The run is `halted`, `aborted`, or `done`.**
- **`GENIE` returns an error you can't resolve by following its message.** If it's a merge the engine couldn't run (for example, uncommitted changes where the run branch is checked out), report the message: the user has to clear it.

Don't stop just because a stage passed or a gate failed: rework is part of the loop.

## Reporting

End with a short status: the stage, what ran in this session (slices landed, gates passed or failed, reworks), and what the user does next. Suggest `/genie:status` for the full picture.
