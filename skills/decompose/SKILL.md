---
name: decompose
description: genie decompose stage. Breaks a run's spec.md into ordered, independently testable slices in plan.md.
user-invocable: false
---

# Decompose stage

Engine CLI: `node "${CLAUDE_PLUGIN_ROOT}/engine/dist/genie.mjs"` (`GENIE` below).

1. Read `<run dir>/spec.md` (and `intent.md` for context). If `feedback` is present, the user rejected the previous plan: revise it to address their note.
2. Write `<run dir>/plan.md` with one section per slice:

   - **S<n>: title**
   - **Goal**: one sentence.
   - **Covers**: requirement ids from the spec.
   - **Touches**: files and modules likely to change.
   - **Tests**: what to add or change to prove it works.
   - **Depends on**: earlier slice ids, or none.

   End with a **Coverage** table mapping every requirement to the slices that cover it.
3. Rules:
   - Each slice is independently testable and reviewable in one sitting.
   - Dependencies form an acyclic graph, and slices are listed in a valid order (dependencies first).
   - Every requirement is covered by at least one slice. Nothing is added that the spec doesn't call for.
   - Prefer vertical slices (a working path end to end) over layers (all models, then all handlers).
4. In guided mode the implementer subagent works through the slices in order, one commit per slice.
5. Run `GENIE done decompose`. The `plan.approved` gate follows.
