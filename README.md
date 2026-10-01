# Witness South Africa (`movement-os`)

_No family should have to start from zero._

Witness South Africa is a non-racial, non-violent, evidence-first civic
accountability project. This repository is the operational backbone behind that
doctrine: typed evidence handling, deterministic guardrails, private operator
surfaces, and human-signoff governance. The agents are staff. Humans are
accountable.

## Status

This repository ships working package code on `packages/`, governance artefacts
under `docs/architecture/` and `.github/workflows/`, field protocols under
`docs/field/`, and the public landing page served via GitHub Pages. Cloudflare
Email Routing, a Cloudflare Email Worker, R2-backed mail preservation, Resend
for outbound probes, and Infisical for secrets are all in active use. The
private extract API worker has a dated April 20 deployment proof bundle;
adoption of the current source revision still needs version-linked runtime
verification ([ADR-0007](./docs/architecture/0007-extract-api-surface.md)). The heavier graph datastore
and retrieval stack described in ADR-0004 is still planned rather than shipped.

## Mission

> We stand for equal protection, equal dignity, and accountable government for
> every South African — regardless of race, class, or politics.

This sentence is the platform's public API. It is pinned in
`@wsa/principles` and treated as release-governed doctrine.

## Principles

1. Non-racial. Rights and duties do not turn on race.
2. Constitutional. The Bill of Rights is the floor, not a suggestion.
3. Non-violent. Violence destroys a human-rights movement.
4. Truth-first. Public claims must be sourced, dated, and verifiable.
5. Disciplined. Evidence outranks outrage.
6. Endurance. The work is built for years, not news cycles.
7. Protection. Witnesses, whistleblowers, and vulnerable families come first.
8. Family-first. No one is expected to sacrifice their safety or family to
   sustain the work.

## Shipped stack

- GitHub Pages for the public landing site.
- Cloudflare Workers + R2 + Email Routing for operator-facing mail ingestion
  and private worker surfaces.
- Resend for outbound email probe delivery.
- Infisical for secret distribution.
- Nx + pnpm + TypeScript + Jest for the monorepo toolchain.

## Repo layout

- `packages/`
  - `@wsa/agent-contracts` — provider-agnostic model contracts, schemas, and
    test doubles for analysis/challenge adapters.
  - `@wsa/agent-openai` — OpenAI-compatible adapter utilities, including
    provider wiring and JSON-schema/finish-reason helpers.
  - `@wsa/agent-xai` — in-repo provider adapter package with budget,
    telemetry, and prompt-shaping helpers for internal runtime wiring.
  - `@wsa/email-ingress-worker` — Cloudflare Email Worker that writes inbound
    alias traffic to R2 per ADR-0006.
  - `@wsa/email-probe` — machine-only SMTP-to-R2 probe harness for verifying
    the ingress path end to end.
  - `@wsa/events` — append-only event-envelope, actor, canonicalisation, and
    hash-chain utilities.
  - `@wsa/evidence-engine` — current extraction runtime that turns redacted
    source material into typed claims/evidence and immediately applies the
    promotion gate.
  - `@wsa/extract-api-worker` — private signed Cloudflare Worker surface for
    Lane-2 evidence extraction per ADR-0007. Historical deployment recorded;
    current revision adoption requires fresh runtime proof.
  - `@wsa/guardrails` — deterministic publication and promotion gates,
    including ADR-0005 rules and ADR-0003's challenge-lane enforcement.
  - `@wsa/principles` — pinned mission/principles package and doctrine hash
    assertion.
  - `@wsa/schemas` — Zod schemas for claims, evidence, approvals, source
    references, and related typed boundaries.
- `docs/architecture/`
  - ADRs `0001` through `0008`, covering agent framework, persistence,
    provider posture, evidence graph direction, promotion gates, email ingress,
    extract API surface, and the operational security model.
- `docs/field/`
  - human field-investigator protocols and working forms. These are explicitly
    v0.1 working documents, not legal advice and not final rollout material.
- `docs/ops/`
  - operational runbooks for DNS, GitHub Pages, email worker deployment, and
    Infisical secret handling.
- `.github/workflows/`
  - CI, [security scanners with visible failures](docs/ops/security-scans.md),
    and quorum-audit automation.
    Security scans remain non-required until findings are triaged under #22.
- `CODEOWNERS`
  - ADR-0008 governance ownership map. Honest note: with only one current
    write-capable identity, it records intended ownership but does not create
    real separation of powers yet.

## Not shipped

These items were previously implied or advertised but are not present as
working surfaces at this SHA:

- no `apps/` directory
- no `apps/api`
- no `apps/cli`
- no `docs/threat-model/`
- no Anthropic adapter package yet
- no dedicated `drafting-engine`, `sources`, or `audit` packages

## Planned

- The Postgres + Apache AGE + pgvector evidence graph stack described in
  ADR-0004.
- Deployment and version-linked acceptance of the hardened
  `@wsa/extract-api-worker` revision using the
  [extract API runbook](./docs/ops/extract-api-runbook.md).
- Anthropic and local provider adapters beyond the currently shipped
  packages.
- Any future control-plane API or CLI surfaces, if and when they are actually
  added to the repo.

## Governance

ADR-0008 is shipped. The repo has a root `CODEOWNERS` file and a
`quorum-audit` workflow that checks for author/reviewer/controller signatures
on the current PR head across PR updates, issue comments, and review
submissions, then publishes a PR-head check run. Signers need current
repository write, maintain or admin access. Roles use separate review
contexts, while only one GitHub identity currently has write access;
credential separation remains an identity-hardening task.

The live `main-protection` ruleset requires `quorum-audit` alongside
`lint`, `typecheck`, `test` and `build`. The runner job is named
`quorum-publisher` so it does not compete with the published PR-head
check. The [ruleset snapshot](./ruleset-main.json) records the live
configuration; it does not apply settings to GitHub.
The publisher runs trusted default-branch code without a PR checkout.
A read-only review observer triggers it for review changes, including
forks. Manual refresh, migration and post-merge proof are covered in the
[operator runbook](./docs/ops/agent-protocol.md#merge-and-post-merge-verification).

### Role contract and labels

The four-role contract is described in
[ADR-0008](./docs/architecture/0008-operational-security-model.md#role-contract-and-label-protocol).

| Role                      | Current label                         |
| ------------------------- | ------------------------------------- |
| author / worker           | `Agent WS1` or `Agent WS2`            |
| reviewer / critic         | `Agent R3`                            |
| controller / orchestrator | `Agent Controller`                    |
| lifecycle / verifier      | `Agent L1` (procedural, not enforced) |

Use Controller for new work. The parser retains `Agent BOSS` as a legacy
alias for existing attestations. Reviews contribute signatures only in
`COMMENTED` or `APPROVED` state on the current head commit. Exact formats
and withdrawal rules live in the
[shared protocol](./docs/ops/agent-protocol.md#quorum-attestations).

These governance roles are distinct from the **runtime agents** shipped
under `packages/` (e.g. `@wsa/agent-openai`, `@wsa/agent-xai`). Runtime
agents are product code that calls LLMs to process evidence; governance
roles are PR-time attestations that process discipline happened.

For repo tasks, use the repo-local
[Movement workflow skill](./.agents/skills/movement-workflow/SKILL.md) and
load only the assigned role reference. Operator documents:

- [docs/ops/agent-protocol.md](./docs/ops/agent-protocol.md)
- [docs/ops/agent-cheat-sheet.md](./docs/ops/agent-cheat-sheet.md)
- [docs/ops/agent-prompts.md](./docs/ops/agent-prompts.md)

## Getting started

Requires Node 22+ and the pinned pnpm 10.34.6 via Corepack.
See [dependency policy](docs/ops/security-scans.md#dependency-policy) for install controls.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm nx run-many -t test
pnpm nx run-many -t build
```

Run a single package:

```sh
pnpm nx run @wsa/guardrails:test --runInBand
pnpm nx run @wsa/evidence-engine:build
pnpm nx run @wsa/email-ingress-worker:test --runInBand
```

If TypeScript project references drift after cross-package edits:

```sh
pnpm nx sync
```

## Policies and runbooks

- [ACCEPTABLE_USE.md](./ACCEPTABLE_USE.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)
- [POPIA.md](./POPIA.md)
- [docs/ops/dns-runbook.md](./docs/ops/dns-runbook.md)
- [docs/ops/email-worker-runbook.md](./docs/ops/email-worker-runbook.md)
- [docs/ops/extract-api-runbook.md](./docs/ops/extract-api-runbook.md)
- [docs/ops/agent-protocol.md](./docs/ops/agent-protocol.md)
- [docs/ops/agent-cheat-sheet.md](./docs/ops/agent-cheat-sheet.md)
- [docs/ops/agent-prompts.md](./docs/ops/agent-prompts.md)
- [docs/ops/infisical/witness-south-africa/README.md](./docs/ops/infisical/witness-south-africa/README.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
