---
name: spec
description: genie spec stage. Turns a run's intent.md into a reviewable spec.md.
user-invocable: false
---

# Spec stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

1. Read `<run dir>/intent.md`. It's the user's own words, and it stays the reference for the final intent review.
2. Explore the codebase enough to ground the spec: the modules involved, existing conventions, how things are tested. Ask the user only when the intent is ambiguous in a way that changes what gets built.
3. If `feedback` is present, the user rejected the previous spec. Revise it to address their note; don't start over.
4. Write `<run dir>/spec.md`:

   - **Summary**: what and why, in two or three sentences.
   - **Requirements**: numbered (R1, R2, …), each one testable.
   - **Acceptance criteria**: checkable statements, each tied to requirements.
   - **Constraints**: compatibility, performance, dependencies, conventions to follow.
   - **Non-goals**: what this run deliberately won't do.
   - **Risks and open questions**: with your proposed answer for each.
   - **Affected areas**: files and modules likely to change.

   Keep it proportional: a small fix gets a short spec.
5. Run `GENIE done spec`. The `spec.approved` gate follows, and the user decides it.
