---
description: Approve or reject a pending genie human gate (you only; Claude cannot run this)
argument-hint: "<gate>|budget|config|state [--slice <id>] [--reject] [--note \"why\"]"
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(git *), Bash(gh *), Read, Write, Edit, Glob, Grep, Agent, Skill
---

!`node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs" approve $ARGUMENTS`

The user just recorded a decision on a genie gate. The engine's output is above.

Tell the user in one or two lines what was recorded and what the run does next (the last line of the output). Approving `pr.approved --slice <id>` on a run that opens a PR per slice merges that slice's PR: say whether it merged, or went back to its implementer because it conflicts with the base. If the gate was rejected, the run has gone back for rework: say which stage. Three targets aren't gates:
- `budget` lets a run that was paused for going over its budget carry on, with the configured budget granted again.
- `config` applies the edits made to `.genie/config.yaml` to the live run.
- `state` accepts a run that failed verification, sealing it as it stands.

Then, if the run is orchestrated and still going (the output's first line ends `[active, orchestrated]`), carry on without waiting to be asked: load the `genie:orchestrate` skill and follow it from the top. This applies after a rejection too, since the rework is part of the loop. The skill stops again at the next human decision. If the run is guided, finished, halted or aborted, or the command failed, stop after the report. For a guided run, say `/genie:next` continues it.

If the output says the command wasn't typed by the user, genie's UserPromptExpansion hook didn't run. Say so: the user needs a Claude Code version with that hook (verified on 2.1.309), with the genie plugin enabled.

Never run `genie approve` yourself. Human gates are approved only through this command.
