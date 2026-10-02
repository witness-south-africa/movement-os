# Repository audit — 2026-10-02

Refresh of [issue #24](https://github.com/witness-south-africa/movement-os/issues/24).
The original April 18 audit remains historical evidence. This report records
the source baseline and live repository observations used for this refresh.

- Source baseline: `b5095c87b4280a437ab6c32f072bf8a64225f6e1`.
- [Pinned source tree](https://github.com/witness-south-africa/movement-os/tree/b5095c87b4280a437ab6c32f072bf8a64225f6e1).
- Live GitHub settings and alert observations: 2026-10-02.
- Scope: README/package map, ADR implementation coverage, governance roles
  and skill, repository security posture, and repository identity literals.
  Production Worker adoption and external public materials require their own
  evidence.

Evidence paths below refer to the pinned baseline. The accompanying
documentation changes correct the remaining source-description gaps without
implementing the deferred product features.

## Architecture and implementation

| ADR  | Source at the baseline                                                                                                                                                                      | Remaining implementation or acceptance                                                                                                                                              | Evidence paths                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Typed `ModelProvider` contract and OpenAI/xAI adapters are shipped. PR #30 already corrected the Agents SDK adoption claim.                                                                 | Capability-manifest and adapter-parity automation remain planned.                                                                                                                   | `packages/agent-contracts/src/lib/model-provider.ts`, `packages/agent-openai/src/lib/provider.ts`, `packages/agent-xai/src/lib/provider.ts`, `docs/architecture/0001-agent-framework.md`          |
| 0002 | Case/question/method/human-lead/consent/custody schemas, V2 status vocabulary, V3 claim provenance and field protocols exist.                                                               | No case-engine dispatcher, automatic retry/pause timers or method-effectiveness aggregator.                                                                                         | `packages/schemas/src/lib/`, `docs/field/`, `docs/architecture/0002-persistent-pursuit.md`                                                                                                        |
| 0003 | OpenAI/xAI adapters, three task lanes and distinct-provider promotion checks are shipped. PR #25 closed the challenge-gate enforcement gap.                                                 | Anthropic/local adapters, shared routing and actual second-provider challenge dispatch remain absent.                                                                               | `packages/agent-contracts/src/lib/task-kind.ts`, `packages/agent-contracts/src/lib/provider-id.ts`, `packages/guardrails/src/lib/evidence-gate.ts`, `packages/evidence-engine/src/lib/runtime.ts` |
| 0004 | Event envelopes, canonicalisation/hash-chain utilities and temporal schema fields are shipped. PR #31 already narrowed the datastore decision to target state.                              | Persistent event store, Postgres/AGE/pgvector deployment, graph projection, retrieval and replay verification remain absent. Claim `sourceRef` supports intake/artefact, not event. | `packages/events/src/index.ts`, `packages/events/src/lib/chain.ts`, `packages/schemas/src/lib/claim.ts`, `packages/schemas/src/lib/common.ts`                                                     |
| 0005 | Deterministic evidence rules R1-R7 and extraction-time downgrade of blocked promotable claims are shipped.                                                                                  | Gate inputs are caller-supplied metadata; they do not establish that a second provider actually ran. A publication service enforcing human Approval is not shipped.                 | `packages/guardrails/src/lib/evidence-gate.ts`, `packages/evidence-engine/src/lib/runtime.ts`, `packages/schemas/src/lib/approval.ts`                                                             |
| 0006 | Raw MIME-to-R2 ingress and deterministic triage are shipped. Ingress does not invoke extraction or route to a case graph.                                                                   | Current production deployment/version acceptance was not refreshed in this source audit.                                                                                            | `packages/email-ingress-worker/src/lib/ingest.ts`, `packages/email-ingress-worker/src/lib/triage.ts`, `packages/email-ingress-worker/wrangler.toml`                                               |
| 0007 | HMAC verification, Durable Object limiter, telemetry, budget guard and promotion-decision responses are shipped. PR #32 hardened these boundaries; PR #49 fixes provider URL normalization. | Current deployed source/build/version and fresh signed/auth/rate/budget/telemetry acceptance remain pending. April 20 artifacts are dated observations with provenance limits.      | `packages/extract-api-worker/src/`, `artifacts/adr-0007-proof-20260420/`, `docs/architecture/0007-extract-api-surface.md`, `docs/ops/extract-api-runbook.md`                                      |
| 0008 | CODEOWNERS, exact-head quorum publisher, read-only review observer and role/skill instructions are shipped. Required checks are active.                                                     | One GitHub write identity remains. Deploy/automation identity separation and meaningful required-human/CODEOWNERS review remain tracked by #22.                                     | `CODEOWNERS`, `.github/workflows/quorum-audit.yml`, `.github/workflows/quorum-review-events.yml`, `docs/ops/agent-protocol.md`, `.agents/skills/movement-workflow/SKILL.md`                       |

The extraction runtime passes `providerRuns: []`. The gate blocks promotable
claims without the required distinct-provider challenge run and the runtime
downgrades them to `contested`. The remaining work is orchestration and
evidence collection; the April comment describing an absent gate was
superseded by PR #25 and the correction already recorded on #24.

## Documentation corrections in this refresh

- README's package map matches all 11 shipped workspace packages. PR #27
  already removed absent apps and adapter claims. This refresh corrects its
  stale statement that scanners are optional and names remaining challenge
  routing work. It describes operational code/runbooks without certifying
  current Worker deployments.
- ADR-0002 now distinguishes shipped schemas/field documents from the
  unimplemented case lifecycle automation.
- ADR-0003 now distinguishes shipped adapters from reserved IDs, links to
  the actual `id`/`complete` contract and three task lanes, removes the
  purported shipped routing default, and identifies future consumers.
  Contract/retention/residency review remains the operator's responsibility;
  the adapters do not verify those conditions.
- ADR-0004 now records shipped event/schema utilities while keeping the
  persistent store, graph/retrieval stack and event source references deferred.
- ADR-0007 and ADR-0008 already express their current source/runtime and
  procedural/credential boundaries. No correction was needed in those ADRs.

The Movement workflow skill delegates shared policy to the protocol and
keeps role references separate. The current instructions already require
isolated author work, fresh independent contexts, full-head attestations,
live required-check verification and separate post-merge/runtime acceptance.
No duplicate role instructions are added by this audit. New attestations use
`Agent Controller`; the former controller label remains parser compatibility.

## Live repository governance and security

[Active main ruleset `15236262`](https://github.com/witness-south-africa/movement-os/rules/15236262)
requires exactly `build`, `lint`, `quorum-audit`, `test`, `typecheck`,
`semgrep`, `gitleaks`, `dependency-review` and `dependency-audit`.
The four security requirements name GitHub Actions provider `15368`.
Strict base testing, squash-only merging, linear history and an empty
ruleset bypass list are active. Classic branch-protection `404` responses
in the old audit do not establish absence of this ruleset policy.

Only `rhaarhoff` has write-capable repository access at observation time.
Independent agent contexts supply procedural review; their GitHub actions
still use that same credential identity. Required approvals remain zero
and required CODEOWNERS review is disabled.

Secret scanning and its push protection are enabled. The blocked dummy-token
push proof is recorded in #22. Historical secret-scan completion remains
unverified, and contributor push-protection bypass is separate from the
main ruleset's empty bypass list.

The baseline's [main CI](https://github.com/witness-south-africa/movement-os/actions/runs/36992466176)
passed 504 package tests in 56 suites and 67 Python tests.
[Security scans](https://github.com/witness-south-africa/movement-os/actions/runs/36992466271)
reported zero Semgrep/Gitleaks findings/errors and no dependency-audit
vulnerabilities. Dependency review passed on PR #49 and intentionally skipped
on the main push. These are baseline observations, not proof for a later head.

[CodeQL security](https://github.com/witness-south-africa/movement-os/actions/runs/36992466163)
executed Actions, JavaScript/TypeScript and Python analysis on the baseline.
All three processed analyses contain zero findings/errors/warnings, and the
open CodeQL alert readback is zero. PR #49 fixed alert #7 without dismissal.

[Scorecard](https://github.com/witness-south-africa/movement-os/actions/runs/36992466146)
reports 7.5/10 overall, Token-Permissions 10/10 and SAST 7/10 on this
baseline. Recognized historical SAST coverage is 2/30; future genuine
presubmit scans are needed before claiming full rolling coverage. Five
posture alerts remain open: branch protection (#1), fuzzing (#3), SAST (#4),
code review (#5) and best-practices badge (#6). Token-permission alert #2
is fixed. The parent [#22](https://github.com/witness-south-africa/movement-os/issues/22)
tracks their evidence and limitations; no alert is dismissed by this refresh.

## Repository identity

The following search against the baseline tracked source tree returned no
matches (exit code 1):

```sh
rg -n -i 'standup|save south africa|@sasa/|\bSASA\b|standupsa\.org|savesouthafrica|save-south-africa' . --glob '!node_modules' --glob '!.git'
```

This finding covers repository literals only. It does not certify current
external site copy, decks, outreach materials or runtime responses.

## Remaining delivery lanes

Keep #24 open for version-linked extract API deployment/acceptance and
provider orchestration/adapter/routing implementation. Source descriptions
now identify those gaps explicitly. Case-engine and datastore work remain
planned architecture; this audit does not promote them to shipped status.
Identity, review policy and the five security-posture findings remain in #22.

Any later implementation or deployment needs evidence bound to its own
source and, where applicable, deployed version. This dated audit should be
refreshed before using it as a current readiness verdict.
