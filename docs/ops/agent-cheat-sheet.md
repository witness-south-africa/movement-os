# Agent Cheat Sheet — `movement-os`

| Role       | Responsibility                               |
| ---------- | -------------------------------------------- |
| Controller | Scope the slice and integrate findings       |
| WS1 / WS2  | Implement and hand off exact-head validation |
| R3         | Review the diff independently                |
| L1         | Verify evidence for the requested stage      |

1. Record issue/PR, worktree, base/head SHA, files and acceptance criteria.
2. Implement in an isolated worktree; preserve unrelated changes.
3. Use separate contexts for independent review and verification.
4. Refresh commit-bound proof when the head changes.
5. Report local validation, hosted CI, quorum, merge and deployment separately.

The required check is `quorum-audit`; its runner job is `quorum-publisher`.
Use `Agent Controller` for new controller attestations. Historical aliases
remain a compatibility detail. L1 is not enforced by automation.

For read-only intake, run `python3 -B scripts/agent_intake.py --issue 22`
or `--pr 32` from the actual worktree, using the assigned number.

See the [shared protocol](./agent-protocol.md) for formats and review-state
rules, and the [prompt pack](./agent-prompts.md) for role handoffs.
