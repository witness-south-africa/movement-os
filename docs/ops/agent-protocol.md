# Agent Protocol — `movement-os`

Shared contract for governance work on this repository. Product runtime
packages under `packages/agent-*` have a separate purpose.

See [ADR-0008](../architecture/0008-operational-security-model.md),
[the cheat sheet](./agent-cheat-sheet.md), and
[the prompt pack](./agent-prompts.md). The discoverable repo skill is
[Movement workflow](../../.agents/skills/movement-workflow/SKILL.md).

## Roles

| Role       | Label                     | Reference                                            |
| ---------- | ------------------------- | ---------------------------------------------------- |
| Controller | `Agent Controller`        | [Scope and integration](./roles/controller.md)       |
| Worker     | `Agent WS1` / `Agent WS2` | [Implementation and validation](./roles/worker.md)   |
| Reviewer   | `Agent R3`                | [Independent diff review](./roles/reviewer.md)       |
| Lifecycle  | `Agent L1`                | [Evidence and stage readiness](./roles/lifecycle.md) |

Use Controller for new work. The parser retains `Agent BOSS` only as a
legacy alias so existing PR attestations remain usable. Labels describe
procedural roles; they do not establish separate credential identities.

## Slice and intake

A slice is the smallest coherent change that can be described, validated,
reviewed and committed independently. One workflow with its operator docs
is a slice; unrelated dirty files are separate work.

At intake, record:

- issue or PR, role and problem
- actual worktree and branch, base/head SHA, dirty files
- files in scope and acceptance criteria
- current authorization and outstanding handoffs

From the worktree, `python3 -B scripts/agent_intake.py --issue 22` or
`--pr 32` reports local and live GitHub state. Replace the number with the
assigned issue or PR. It is read-only and does not fetch or change the
checkout. API errors leave intake incomplete.

Preserve unrelated work and use an isolated worktree for implementation.
A missing detail calls for clarification only when it materially changes
scope or prevents progress; routine choices belong to the assigned role.

## Independent contexts and handoffs

Use a new context for a new role or slice. Continue an existing context
for the same role and slice, refreshing current files and evidence.
Independent review and verification require a context separate from the
author. Use delegation when available and authorized; otherwise leave
those seats pending rather than claiming them yourself.

The normal sequence is Controller intake, Worker implementation, Reviewer
findings, Controller integration, then Lifecycle verification. If a
Controller implements, it takes authorship responsibility for that work.
It cannot supply independent review or certification of the same change.

Every handoff identifies the slice, full head SHA, changed files, commands
and results, unresolved questions and next role. Refresh commit-bound
proof after a head change. When only the base advances, inspect the delta
and refresh the proof it affects.

## Quorum attestations

For the full current PR head SHA:

```text
Agent WS1: authored at <full-head-sha>
Agent R3: no findings on <full-head-sha>
Agent Controller: concur at <full-head-sha>
```

`WS2` may occupy the author seat. The parser also accepts the existing
ADR-0007 deployment form `Agent WS1: implemented and live-proved ADR-0007
extract-api deployment at <full-head-sha>` and the legacy controller alias.
Use the canonical forms above for new attestations, as the first line of
the body. An optional final period is accepted; put evidence on subsequent
lines. Examples, quoted signatures and signatures with withdrawal text
on the same line do not count.
Only attest to work actually performed, and post only when authorized.

Signers must be GitHub users with current `write`, `maintain` or `admin`
repository permission. The publisher verifies access through the GitHub
API; comment association alone is insufficient. This excludes outsiders
and bots without claiming separate credentials for the governance roles.

The workflow reads all pages of PR issue comments and reviews. A review
contributes only when its state is `COMMENTED` or `APPROVED` and its
`commit_id` matches the current head. Dismissed, pending, changes-requested
and older commit reviews are excluded. A later `CHANGES_REQUESTED` review
on the same head invalidates earlier review signatures from that account;
a subsequent positive signed review can restore them. Issue-comment
signatures remain until edited or deleted. Retract an issue-comment signature
by editing or deleting it; retract a review signature by editing or
dismissing the review. Withdrawal triggers a fresh evaluation.

## Required check and certification

The live `main-protection` ruleset requires `quorum-audit` alongside
`lint`, `typecheck`, `test` and `build`. The checked-in
[ruleset snapshot](../../ruleset-main.json) records that configuration;
changing it does not change GitHub settings.

The runner job is named `quorum-publisher`; only its published PR-head
check is named `quorum-audit`. Runs for one PR serialize publication after
resolving the PR number. The trusted publisher uses `pull_request_target`,
`issue_comment` and `workflow_run`. It never checks out PR code or reads
observer artifacts. A read-only `quorum-review-events` workflow relays
review changes; the publisher reads the live GitHub discussion. Fork
events without PR metadata resolve through the commit's associated PRs.
Old-head review events cannot overwrite the current head's result.
The publisher marks its managed check in progress before reading
signatures, then updates it to success or failure. A changed head or an
API/evaluation error cannot certify quorum. Publishing failures fail the
runner job and can leave the managed check pending. Errors before that
check can be created or updated require inspection of the publisher;
no fresh verification exists in that case.

Every evaluation refreshes the check's start/completion times and includes
a publisher link in its summary; GitHub can override the check details URL.
The summary records run ID/attempt, event and workflow
source revision as well as the evaluated PR head. A relay that is missing,
disabled or altered provides no fresh review-event verification: inspect
the observer and publisher, then use the trusted manual refresh below.

## Merge and post-merge verification

Before merge, freeze the head, obtain independent R3/Controller/L1 evidence,
publish truthful attestations, and verify every required check is terminal
success on that head. Inspect all same-name quorum checks and unresolved
review threads. Confirm the base and session merge authority. Squash with
`gh pr merge <pr> --squash --match-head-commit <full-head-sha>`.

For a manual refresh or recovery, run the default-branch publisher with
`gh workflow run quorum-audit.yml --ref main -f pr_number=<pr>
-f expected_head=<full-head-sha>`. A mismatched head fails without
certifying a different commit.

When changing the publisher itself, comment events still run the old
default-branch version until merge. For the initial migration, submit
commit-bound `COMMENTED` reviews and explicitly dispatch the reviewed
candidate branch instead of `main`. Verify its run source revision and
all required-check results; do not bypass protection or overwrite legacy
checks. Older unmanaged checks are preserved and require actual readback.

After squash, verify the merge commit and landed tree on `main`, successful
main CI, and unchanged protection. Post a verification comment on the
merged PR to exercise the new default-branch publisher against its original
PR head. Also edit a commit-bound review without changing its signature,
then verify the read-only observer triggers a successful trusted publisher.
Verify check reuse, refreshed provenance and success. A merged
PR can be audited for rollout proof; a closed unmerged PR is ignored.
This governance slice does not require a product deployment.

L1 is still a procedural seat. Its verdict names the slice, full head SHA
and stage, distinguishing local validation, hosted CI, quorum, merge and
deployment evidence. Readiness for one stage does not certify another.
Artifacts establish observations on their recorded dates.

Only one GitHub identity currently has write access. Role separation
improves review discipline and auditability; technical separation remains
an identity-hardening task under issue #22.
