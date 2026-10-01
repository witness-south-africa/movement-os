# Agent Prompt Pack — `movement-os`

Use the actual worktree, a named slice and a separate context per role.
Read [the shared protocol](./agent-protocol.md), then only the assigned
role's reference. This keeps repeated instructions out of every prompt.

## Handoff input

```text
Role: Controller / WS1 / WS2 / R3 / L1
Repository: witness-south-africa/movement-os
Worktree: [absolute path of the actual worktree]
Issue / PR: [number or URL]
Slice: [problem and files in scope]
Base / head: [full commit SHAs]
Acceptance: [observable outcomes]
Authorization: [actions authorized in the session]
Evidence: [commands, results, dates and tested commit]
Outstanding: [findings, uncertainty and next handoff]
```

Derive known fields from the issue, checkout and session. Ask for missing
information only when it affects scope or prevents progress.

## Role references

| Role                                | Prompt direction                                               |
| ----------------------------------- | -------------------------------------------------------------- |
| [Controller](./roles/controller.md) | Establish scope, make a decision and integrate findings.       |
| [Worker](./roles/worker.md)         | Implement the named slice and hand off validation on its head. |
| [Reviewer](./roles/reviewer.md)     | Review that diff independently; output findings first.         |
| [Lifecycle](./roles/lifecycle.md)   | Verify the evidence for the named slice and stage.             |

Use the role's identity in attestations. Attest only for the role you
actually performed, and post only when authorized:

```text
Agent WS1: authored at <full-head-sha>
Agent R3: no findings on <full-head-sha>
Agent Controller: concur at <full-head-sha>
Agent L1: ready for <slice> on <full-head-sha> for <stage>
```

The parser still recognizes historical controller attestations. New
prompts use Controller. Independent roles must inspect current files and
underlying evidence before relying on the handoff's conclusions.
