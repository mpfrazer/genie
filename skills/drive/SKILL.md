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

The engine owns the run. Never edit `.genie/runs/*/state.json`, `log.jsonl`, `CURRENT`, or `evidence/`, and never run `GENIE approve`. Hooks deny all of these. Only the user approves human gates, with `/genie:approve`.

## Loop

1. Run `GENIE next --json`. It returns:
   - `run`: id, dir, branch, base, stage
   - `action`: what happens next
   - `feedback`: present when the stage is being reworked after a failed gate (gate, note, evidence file paths)
2. Act on `action.type`:
   - **`work` with `action.agent`**: delegate it. Use the Agent tool with `subagent_type: "genie:<agent>"`. The prompt must include the run id, run dir, branch, base, stage, `action.instructions`, and `feedback` if present. The subagent does the work and runs `GENIE done <stage> --by <agent>` itself. Check its report when it returns.

     **Never do a delegated stage's work yourself**: no editing the code, no committing, no running `done`, not even to finish something the subagent left half done. The engine attributes each stage to whoever did it, so reviewers stay independent of authors. If the subagent couldn't finish (a permission denial, an error, a question), stop and report what blocked it. The next `/genie:next` delegates again, and the new subagent picks up its predecessor's work on the run branch.
   - **`work` without an agent**: load `action.skill` with the Skill tool and follow it. If `feedback` is present, address it first. Finish with `GENIE done <stage>`.
   - **`evaluate`, `kind: "automated"`**: run `GENIE gate <gate> --run`. Exit code 0 means pass and 2 means not passed; the output says which checks ran.
   - **`evaluate`, `kind: "agent"` or `"agent+human"`**: use the Agent tool with `subagent_type: "genie:<evaluator>"`. The prompt must include the run id, run dir, branch, base, and gate name. The evaluator records its own verdict. Never record it on its behalf: the hook only accepts `--by <evaluator>` from that subagent.
   - **`await_human`**: stop (see below).
   - **`halted`, `aborted`, `done`**: report and stop.
3. Go back to step 1 unless a stop condition holds.

## When to stop

Guided mode advances one stage per `/genie:next`. Stop and report when:

- **The action is `await_human`.** Tell the user exactly what to review: artifact paths in the run dir, the PR URL, and the agent's pre-review if `action.agentReview` is present. Then give the commands: `/genie:approve <gate>`, or `/genie:approve <gate> --reject --note "why"`.
- **A gate just failed and the run went back for rework.** Summarize why, from `feedback.note` and the relevant lines of the evidence logs or findings. Say that `/genie:next` will do the rework. Don't start the rework in the same turn.
- **The stage you started on passed and the next action is work on a different stage.** Say what comes next.
- **`GENIE` returns an error you can't resolve by following its message.**

If an automated gate comes back `needs_human` with "no checks configured", say which config key would make it automatic (for example `commands.test`, or `forge.ci_command` for `pr.ready`).

## Reporting

End with a short status: the stage, what happened, and what the user does next. Suggest `/genie:status` for the full picture.
