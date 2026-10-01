---
name: movement-workflow
description: Scope, implement, review, or verify movement-os issues and PRs using its governance roles and current-head evidence.
---

# Movement workflow

Use this skill for governance work in `witness-south-africa/movement-os`.
It does not define the product's runtime agents.

Read the [shared protocol](../../../docs/ops/agent-protocol.md), then only
the reference for the assigned role:

- [Controller](../../../docs/ops/roles/controller.md): intake, scope and handoff.
- [Worker](../../../docs/ops/roles/worker.md): implementation and local validation.
- [Reviewer](../../../docs/ops/roles/reviewer.md): independent diff review.
- [Lifecycle](../../../docs/ops/roles/lifecycle.md): verify evidence for the requested stage.

When a task starts without an assigned role, use Controller to assess and
scope it. If implementation is authorized, hand off or proceed as the
author; do not claim independent review or lifecycle verification of your
own work. Use separate contexts for independent roles when available and
authorized, or report those seats as pending.

From the actual worktree, get a read-only intake snapshot:

```sh
python3 -B scripts/agent_intake.py --issue 22
python3 -B scripts/agent_intake.py --pr 32
```

Replace the example number with the task's issue or PR. The helper reports
the checkout and live GitHub state without fetching, editing, or publishing.
An API error means intake is incomplete; it is not green evidence.

Record the slice, worktree, base/head SHA, files, acceptance criteria and
current authorization. Preserve unrelated work. Refresh evidence after a
head change and verify any affected proof after base advancement.

Use `Agent Controller` for new controller attestations. Legacy labels are
only a parser compatibility concern; see the protocol for exact formats.
Post attestations only for work actually performed and when posting is
authorized. A skill invocation does not authorize merges or deployment.

After a completed slice, correct instructions only when observed failures
or repeated work justify it. Keep shared rules in the protocol and role
details in their references; avoid adding another copy of either.
