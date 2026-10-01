# 0008 — Operational security model

- Status: accepted
- Date: 2026-04-18
- Relates to: [ADR-0001](./0001-agent-framework.md),
  [ADR-0007](./0007-extract-api-surface.md)

## Context

Witness South Africa is currently a single-human project.

Today, only `rhaarhoff` has write access to the repository. The required
checks on `main` protect build quality, but GitHub does not currently
enforce separation between author, reviewer, controller, and lifecycle
roles. In practice, all agent actions that use GitHub credentials appear
as the same GitHub identity.

That means the operating model has an honest split:

- the four-role quorum is valuable
- the four-role quorum is not, by itself, an access-control boundary

The quorum already catches real bugs by forcing separate lenses on the
same work:

- author / worker: ships the narrow change
- reviewer / critic: hunts for correctness and risk
- controller / orchestrator: checks scope and sequence
- lifecycle / verifier: confirms the exact head SHA and CI state

These four roles are the **role contract**. The role contract is what
this ADR governs. The specific label strings used to claim a role on a
PR (see "Role contract and label protocol" below) are a separate,
narrower concern.

This creates a durable audit trail and improves decision quality, but it
does not prevent a unilateral merge by the single write-capable human.

The project needs that distinction written down explicitly so the
security posture stays honest as automation grows.

## Decision

Witness South Africa adopts the following operational security model:

1. The current four-role quorum is defined as **cognitive scaffolding,
   audit trail, and bug-catching discipline**.
2. The current four-role quorum is **not** defined as a permission
   boundary.
3. The repository will add lightweight automation that verifies the
   quorum ceremony happened on the exact current PR head SHA, including
   after role signatures are posted as PR comments.
4. The repository will add future-ready review structure now, even where
   it is inert until a second identity exists.
5. Hardening work will proceed in ranked order, with identity separation
   before stricter merge governance.

## Role contract and label protocol

The four conceptual roles remain unchanged. The current labels are:

| Role                      | Label                      | Enforcement                |
| ------------------------- | -------------------------- | -------------------------- |
| author / worker           | `Agent WS1` or `Agent WS2` | Required by `quorum-audit` |
| reviewer / critic         | `Agent R3`                 | Required by `quorum-audit` |
| controller / orchestrator | `Agent Controller`         | Required by `quorum-audit` |
| lifecycle / verifier      | `Agent L1`                 | Procedural; not automated  |

Controller replaces the previous controller label for new work. The
parser retains `Agent BOSS` as a legacy alias so existing attestations
remain usable during migration. Removing that alias requires a separate
compatibility assessment of in-flight PRs.

The [operator protocol](../ops/agent-protocol.md#quorum-attestations)
defines the accepted signature forms and review-state semantics. The
workflow reads all comment and review pages, and accepts review bodies
only in `COMMENTED` or `APPROVED` state on the current PR head commit.
Editing or deleting an issue comment, or editing/dismissing a review,
triggers a fresh evaluation. Later changes-requested reviews invalidate
older review signatures from that account on the same head. Signers need
current write, maintain or admin access; role labels still do not prove
distinct identities.

Label changes must update the workflow, ADR, README and operator
references together, with validation for new and retained legacy forms.

### Governance roles vs runtime agents

The labels in this section are **governance roles**: they describe who
attests to what on a PR. They are _not_ the same as the **runtime
agents** shipped under `packages/` (for example, `@wsa/agent-openai`,
`@wsa/agent-xai`, `@wsa/agent-contracts`). Runtime agents are product
code that calls LLMs to process evidence; governance roles are PR-time
attestations that process discipline happened. The two share the word
"agent" and nothing else.

## Supporting runtime

The repository will support this model with two in-repo artefacts:

- `CODEOWNERS`, to define the future review surface for critical files
- `.github/workflows/quorum-audit.yml`, to verify that author,
  reviewer, and controller signatures exist on the current PR head SHA
  on both PR-synchronize events and later PR discussion events

The `main-protection` policy requires `quorum-audit` alongside
`lint`, `typecheck`, `test`, `build` and the
[four security checks](../ops/security-scans.md#required-check-rollout).
The checked-in `ruleset-main.json` declares the intended configuration,
not a deployment mechanism. Live requirements are established by settings
application and independent readback, following the staged rollout.

The workflow's runner job is `quorum-publisher`; its managed PR-head
check is `quorum-audit`. Those names differ to prevent conflicting job
and published-check results. Publication is serialized for a PR, and the
managed check is moved to `in_progress` before reading attestations.
The result is failure for missing signatures, a head change or an API
error. Publication errors fail visibly and can leave the check pending.
An error before creating or updating the check provides no fresh quorum
proof; inspect the publisher failure rather than relying on an old result.

The publisher runs trusted default-branch code on PR-target, comment and
review-observer completion events. It does not check out PR code or read
observer artifacts. The review observer has a read-only token, including
for forks and Dependabot. Check timestamps and the publisher link refresh
on every evaluation. Offline regression tests exercise the actual workflow
shell with a simulated GitHub API.

## Ranked hardening plan

The hardening order is:

1. Separate Cloudflare deploy identity from GitHub push identity.
2. Introduce a scoped CI automation identity using a GitHub App instead
   of a broad personal token.
3. Promote `quorum-audit.yml` to a required status check after two clean
   runs. **Completed in the live ruleset; tracked by #22.**
4. Add CODEOWNERS-required review once a second write-capable
   collaborator exists.
5. Tighten branch protection further by restricting merge methods to
   squash-only and requiring linear history. **Completed in the live
   ruleset.**

This order is deliberate:

- deploy identity separation reduces live-system blast radius first
- scoped automation reduces credential blast radius second
- workflow-enforced ceremony comes before social review enforcement
- required approvals only become honest once a second real identity
  exists

## Acceptance proofs

This ADR is considered landed when all of the following are true:

1. A PR can show parseable author, reviewer, and controller role
   signatures on the exact current head SHA.
2. `CODEOWNERS` exists in the repository root.
3. `quorum-audit.yml` executes on trusted `pull_request_target`,
   PR-comment and review-observer completion events.
4. A tracking issue exists for the ranked hardening plan.

## Non-goals

This ADR does not:

- add a second human collaborator
- enforce required approvals today
- implement deploy-token separation
- change branch-protection rules directly
- change application runtime code

## Rollout

The original rollout began with report-only auditing, followed by
promotion after two clean PR runs. The live ruleset is now in the
enforced phase. Required human approvals and CODEOWNERS enforcement
remain deferred until a second write-capable collaborator exists.

This follow-up preserves the required check name while separating its
publisher job, making errors visible, and introducing Controller with
legacy compatibility. Existing workflow-job checks on old PR heads are
historical records; their reconciliation must be verified on the actual
PR surface, rather than assuming a publisher fix clears them.
The [operator protocol](../ops/agent-protocol.md#merge-and-post-merge-verification)
defines candidate-branch bootstrap, manual recovery and post-merge proof.

## Consequences

### Positive

- the project stops pretending process discipline is the same thing as
  repository access control
- quorum evidence becomes machine-verifiable at the PR head SHA
- future hardening has an explicit order instead of ad hoc debate

### Negative

- the workflow can prove ceremony happened, but cannot prove the human
  behind every role was different
- `CODEOWNERS` is mostly future-facing until a second identity exists
- the model introduces one more workflow to maintain

## References

- [ADR-0001](./0001-agent-framework.md)
- [ADR-0007](./0007-extract-api-surface.md)
