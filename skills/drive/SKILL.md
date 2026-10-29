---
name: drive
description: Drives the active genie run in guided mode. It performs the next stage's work and runs its gates, then stops for the user. Used by /genie:new and /genie:next.
user-invocable: false
---

# Driving a genie run (guided mode)

The engine CLI is:

```
node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"
```

Below it's written `GENIE`. Always type the full command: it isn't on PATH, and the plugin-root variable isn't set in Bash.

The engine owns the run. Never edit `.genie/runs/*/state.json`, `log.jsonl`, `CURRENT`, or `evidence/`, and never run `GENIE approve`. Hooks deny all of these. Only the user approves human gates, with `/genie:approve`. If `GENIE` reports that the run was changed outside genie, stop and tell the user. Don't try to repair the state: only they can accept it (`/genie:approve state`) or abort it.

## Loop

1. Run `GENIE next --json`. It returns:
   - `run`: id, dir, branch, base, stage
   - `action`: what happens next. In the implement stage it carries `action.slice`, the plan slice it applies to: id, title, goal, covers, touches, tests, depends_on, and `fixes` on fix-up slices.
   - `feedback`: present when the stage (or that slice) is being reworked after a failed gate: gate, slice, note, evidence file paths.
   - `actions`: every action available right now. Guided mode always takes the first one (`action`).
2. Act on `action.type`. When `action.slice` is set, pass `--slice <id>` to every `GENIE done`, `GENIE gate`, and `/genie:approve` for it, and put the slice in every subagent prompt.
   - **`work` with `action.agent`**: delegate it. Use the Agent tool with `subagent_type: "genie:<agent>"`. The prompt must include the run id, run dir, branch, base, stage, `action.instructions`, the slice (all its fields) if present, `worktree` if present (the run is orchestrated: tell the subagent to work only there), and `feedback` if present. The subagent does the work and runs `GENIE done <stage> [--slice <id>] --by <agent>` itself. Check its report when it returns.

     **Never do a delegated stage's work yourself**: no editing the code, no committing, no running `done`, not even to finish something the subagent left half done. The engine attributes each stage to whoever did it, so reviewers stay independent of authors. If the subagent couldn't finish (a permission denial, an error, a question), stop and report what blocked it. The next `/genie:next` delegates again, and the new subagent picks up its predecessor's work on the run branch.
   - **`work` without an agent**: load `action.skill` with the Skill tool and follow it. If `feedback` is present, address it first. Finish with `GENIE done <stage>`, without `--by`. You're recorded as `claude`; a skill name such as `genie:integrate` is not an identity, and the hook refuses it.
   - **`evaluate`, `kind: "automated"`**: run `GENIE gate <gate> [--slice <id>] --run`. Exit code 0 means pass and 2 means not passed; the output says which checks ran.
   - **`evaluate`, `kind: "agent"` or `"agent+human"`**: use the Agent tool with `subagent_type: "genie:<evaluator>"`. The prompt must include the run id, run dir, branch, base, gate name, the slice if present, and `worktree` if present. The evaluator records its own verdict. Never record it on its behalf: the hook only accepts `--by <evaluator>` from that subagent.
   - **`await_human`**: stop (see below).
   - **`over_budget`**: the run used its time or cost budget while orchestrated (`action.reason`). Report it and stop: `/genie:approve budget` carries on, `/genie:abort` stops the run.
   - **`halted`, `aborted`, `done`**: report and stop.
3. Go back to step 1 unless a stop condition holds.

## When to stop

Guided mode advances one stage per `/genie:next`, except in the implement stage, where it advances one **slice**. Stop and report when:

- **The action is `await_human`.** Tell the user exactly what to review: artifact paths in the run dir, the PR URL, and the agent's pre-review if `action.agentReview` is present. Then give the commands: `/genie:approve <gate>`, or `/genie:approve <gate> --reject --note "why"` (with `--slice <id>` for a slice gate).
- **A gate just failed and the run (or a slice) went back for rework.** Summarize why, from `feedback.note` and the relevant lines of the evidence logs or findings. Say that `/genie:next` will do the rework. Don't start the rework in the same turn. If a run-level gate sent the run back to implement, the engine adds a fix-up slice (`F1`, `F2`, …) for the fix; say so.
- **The slice you started on passed its gates.** Say which slice is next, or that implement is complete.
- **The stage you started on passed and the next action is work on a different stage.** Say what comes next.
- **`GENIE` returns an error you can't resolve by following its message.**

If an automated gate comes back `needs_human` with "no checks configured", say which config key would make it automatic (for example `commands.test`, or `forge.ci_command` for `pr.ready`).

## Reporting

End with a short status: the stage, what happened, and what the user does next. Suggest `/genie:status` for the full picture.

The run is in guided mode, so end with one line saying so: `/genie:run` switches it to orchestrated mode, which keeps going on its own (in parallel where slices allow) and stops only when it needs the user.
