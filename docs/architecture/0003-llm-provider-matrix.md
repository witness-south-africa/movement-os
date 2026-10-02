# 0003 — LLM provider matrix: OpenAI + xAI + fallback, behind `ModelProvider`

- Status: accepted
- Date: 2026-04-18
- Supersedes: nothing
- Relates to: [ADR-0001](./0001-agent-framework.md), [ADR-0002](./0002-persistent-pursuit.md)

## Context

ADR-0001 chose a thin **`ModelProvider` contract** in
`@wsa/agent-contracts` as the abstraction boundary, implemented by
provider adapters, so the platform is never captured by
a single vendor. That ADR did not pick concrete _model providers_. This
one does.

Three things force the decision:

1. **Credibility.** A movement built on truth cannot be "ask one model
   and publish." If one provider's model is wrong, confident, and
   alone, the platform will publish its error.
2. **Sovereignty.** South African witness and archival material must not
   default to a single non-SA vendor's servers. The routing must
   distinguish sensitive lanes from analysis lanes.
3. **Operational reality.** Operators will have different API access,
   different budgets, and different legal opinions on cross-border
   transfer. The platform has to make provider choice a config
   decision, not a code change.

## Decision

`movement-os` adopts a **three-lane provider model** behind a single
`ModelProvider` abstraction.

### Shipped and reserved providers

- `openai` — OpenAI API. Default adapter, already chosen in ADR-0001.
- `xai` — xAI (Grok) API. Added day one. xAI's API is OpenAI-
  compatible via `base_url="https://api.x.ai/v1"`, so the adapter
  is thin. Grok supports tool use, function calling, and schema-
  constrained structured outputs, which matches the platform's
  extraction and drafting workloads.
- `anthropic` — reserved provider ID for a future Claude adapter; no
  adapter package is shipped.
- `local` — reserved provider ID for a future local / self-hosted
  adapter; no adapter package is shipped.

### The three lanes

The policy defines three lanes. Callers currently select and construct
providers; no shared dispatcher implements automatic lane routing.

**Lane 1 — Sensitive intake lane.**
Unredacted witness intake, raw identifying information, minors'
information, medical information. Default: `local` (when available) or
`openai` with explicit minimisation and zero-retention terms confirmed
by the operator. **Never** send unredacted intake to a provider whose
data-processing terms have not been reviewed and recorded in the
deployment's `POPIA` configuration.

**Lane 2 — Analysis lane.**
Public records, archive indexes, court judgments (SAFLII), gazetted
notices, newspaper extracts, already-redacted or already-consented
material. xAI is allowed here. This is where extraction, clustering,
timeline building, and dossier drafting run.

**Lane 3 — Challenge lane.**
Before a `Claim` can be promoted to `conclusive` or `high-confidence`
(ADR-0002), a **second, different** provider must re-run the
evaluation. The challenge lane exists so no single model gets to
define "truth." Pairing rule: if the analysis lane used `xai`, the
challenge lane defaults to `openai` or `anthropic`, and vice versa.

Final public accusations or case conclusions always require **both**
multi-model agreement and a human `Approval` record.

### The `ModelProvider` interface

The shipped contract is defined in
[`model-provider.ts`](../../packages/agent-contracts/src/lib/model-provider.ts):
a provider `id` and a generic `complete()` method whose response value is
inferred from the caller's required Zod schema. There are no capability
flags or residency guarantees on this interface.

[`CompleteArgs`](../../packages/agent-contracts/src/lib/complete-args.ts)
carries `schema`, `messages`, `taskKind`, optional tools, output-token and
timeout limits, and an optional `requestId`.
[`AgentTaskKind`](../../packages/agent-contracts/src/lib/task-kind.ts)
is `sensitive-intake | analysis | challenge`. Workloads such as extraction
and dossier drafting are policy use cases, not additional shipped task IDs.

### Intended routing and current wiring

The lane policy above remains the platform intent. `movement-os` does
not ship a default routing table or shared `config/routing.yaml`.
The current v0.1
runtime wiring is package-local: callers choose a provider when they
construct the runtime that invokes it. The first real consumer is
`@wsa/evidence-engine`, which uses xAI in the analysis lane for
structured claim extraction and immediately runs the promotion gate
before returning results.

The evidence engine supports an optional injected `challengeProvider`.
For each requested `high-confidence` or `conclusive` candidate from completed
analysis, it dispatches a different provider in the `challenge` lane. The
response must bind to the exact generated claim and supplied source metadata;
only locally validated, completed, identity-matched responses generate
challenge-run evidence. Missing or failed challenge calls leave R7 blocking
promotion. The original extraction evidence remains unchanged, so successful
completion satisfies only the challenge-run rule, not primary-source or
supporting-provenance requirements. Blocked candidates remain `contested`.

The [engine documentation](../../packages/evidence-engine/README.md#optional-challenge-provider)
records request bounds, reported costs and trust limits. The extract Worker
does not enable a challenger. Shared routing, remaining adapters and
version-linked deployed challenge acceptance remain delivery work.

### Analysis workloads

- Shipped: structured claim extraction through `@wsa/evidence-engine`.
- Planned: affidavit summarisation, archive-result triage, contradiction
  highlighting, timeline building, and thread or dossier drafting.
  These require their own runtime consumers and human publication gates.

### Runtime controls for xAI

Every production xAI call must be measurable before it is promoted from
credential-only readiness into a live runtime path. PR-11 adds the
required provider-layer controls in `@wsa/agent-xai`:

- append-only telemetry hooks for `model`, `taskKind`, `requestId`,
  token usage, cached prompt tokens, and `costInUsdTicks`
- a hard preflight budget gate that blocks new calls once the recorded
  month-to-date spend reaches the configured cap
- a soft-threshold alert when a successful call pushes projected spend
  across the configured warning percentage
- cache-aware request shaping by collapsing leading system prompts into
  one stable prefix so xAI's prompt caching can actually work

These controls are deliberately provider-layer primitives, not
front-page branding. Public Grok/xAI attribution remains false until a
real production runtime path consumes these controls.

### First runtime consumer

`@wsa/evidence-engine` is the first real runtime consumer of these xAI
controls. It:

- calls `@wsa/agent-xai` in the `analysis` lane
- converts model output into typed `Claim` / `Evidence` records
- immediately runs `checkEvidencePromotion()`
- downgrades model-requested `high-confidence` / `conclusive` claims to
  `contested` when the gate blocks them

This is a truthful runtime path in code, not a public deployment claim.
Public Grok/xAI attribution still remains false until an operator-facing
deployed surface actually invokes that path.

### What xAI **does not do alone** on this platform

- Make final guilt findings.
- Decide identity matches without human review.
- Publish unreviewed allegations.
- Hold the only copy of any sensitive artefact.

The tone and evidence-promotion checks live in `@wsa/guardrails`.
`@wsa/schemas` defines the human `Approval` record; an end-to-end
publication service that enforces it is not shipped. Promotion enforcement
lives in `packages/guardrails/src/lib/evidence-gate.ts`, where
promotion to `conclusive` / `high-confidence` is blocked unless the
evidence bundle satisfies ADR-0005 and at least one challenge-lane run
exists from a provider different from the claim-producing analysis run.

## Data handling

Provider terms and retention arrangements require operator review for the
actual deployment and material being processed, including **Lane 2**.
The shipped adapters do not verify contractual terms or data residency.
**Lane 1** requires its own POPIA-specific assessment per deployment.
The same principle applies to OpenAI and Anthropic. See
[`POPIA.md`](../../POPIA.md).

## Consequences

**Positive.**

- No single-vendor capture. The OSS project can be run against any
  combination of providers an operator chooses.
- Built-in second opinion before any public claim is promoted.
- Matches ADR-0002's "maximum evidential completeness" doctrine —
  challenge lane is the operational mechanism for it.
- The first analysis-lane runtime now exists in code without widening
  the publication surface or weakening the promotion gate.

**Negative / costs.**

- Two adapters to maintain from day one, three when `anthropic` is
  wired in, four when `local` is.
- Small extra latency and cost per promotion (challenge lane).
- Operators must make a routing decision rather than get a defaults-
  only experience. Shared routing defaults remain implementation work.

## Rollout

Rollout has now partially landed:

1. `@wsa/agent-contracts` — `ModelProvider` interface, `AgentTaskKind`,
   `ModelResponse<T>`.
2. `@wsa/agent-openai` and `@wsa/agent-xai` — shipped adapters;
   xAI includes telemetry / budget controls.
3. Guardrails rules in
   `packages/guardrails/src/lib/evidence-gate.ts`: promotion to
   `conclusive` / `high-confidence` requires supporting evidence from
   two distinct providers plus a challenge-lane run from a different
   provider. Landed in ADR-0005 / `@wsa/guardrails`.
4. `@wsa/evidence-engine` — first real analysis-lane runtime path,
   consuming `@wsa/agent-xai` and immediately applying the promotion
   gate before returning audit-ready output.
5. Remaining follow-ups:
   - `@wsa/agent-anthropic` parity adapter
   - local / self-hosted adapter
   - deployment-level routing config + audit-log integration
   - deployment wiring and runtime acceptance of the optional challenge lane

## References

- xAI API — OpenAI / Anthropic SDK compatibility and
  `base_url` quickstart.
- xAI — function calling, structured outputs, reasoning features.
- xAI Enterprise — SOC 2 Type 2, GDPR, CCPA, zero-retention
  configurations, DPA.
- OpenAI Agents SDK — considered in ADR-0001, not adopted; remains a
  candidate second adapter behind the `ModelProvider` contract if we
  ever need its handoffs / tracing / guardrails surface.
- ADR-0001, ADR-0002, [`POPIA.md`](../../POPIA.md),
  [`ACCEPTABLE_USE.md`](../../ACCEPTABLE_USE.md).

## Amendment — 2026-04-18: Grokipedia non-authoritative rule

### Context

Since ADR-0003 landed, a product pattern has emerged in which xAI's
Grok line is used to surface background facts (the informal
"Grokipedia" mode — the model answering general-knowledge questions
from its training and browsing rather than from an operator-supplied
primary source). On an evidence platform built for truth-and-record,
this pattern is a hazard: an LLM's general-knowledge answer is
**model-generated text**, not a primary source, regardless of how
confident the prose sounds.

### Rule

Any Evidence record whose only source is an xAI output (Grokipedia-
style or otherwise):

1. MUST NOT carry `kind` in
   `{'court-record', 'government-publication', 'statssa', 'commission'}`.
   Those kinds imply a primary / official provenance an LLM cannot
   emit; only summarise or paraphrase.
2. MAY carry `kind` in `{'news-article', 'other'}`. The `news-article`
   kind is permitted only when the xAI output is itself a pointer to a
   named, fetchable article that the platform will retrieve and hash;
   otherwise use `other`. The `note` field on Evidence SHOULD make the
   AI-generated nature explicit and reference the upstream prompt / run
   id.
3. MUST be corroborated by at least one primary-source Evidence
   record — that is, a non-xai Evidence of a primary-source `kind`,
   with its own `url` + `sha256` binding — before the backing `Claim`
   is promoted to `conclusive` or `high-confidence` (ADR-0002).

The challenge-lane rule from the original decision still applies:
promotion continues to require a second opinion from a different
provider. The Grokipedia rule stacks on top — second-opinion alone
does not satisfy primary-source corroboration.

### Enforcement

The rule is reified in `@wsa/agent-xai`:

- `XAI_NON_AUTHORITATIVE = true`
- `GROKIPEDIA_PROHIBITED_EVIDENCE_KINDS = ['court-record',
'government-publication', 'statssa', 'commission']`
- `GROKIPEDIA_ALLOWED_EVIDENCE_KINDS = ['news-article', 'other']`

These two lists partition `EvidenceKindSchema` from `@wsa/schemas`
exactly — no `maybe` bucket. The invariants (frozen, disjoint,
total) are covered by `xai-policy.spec.ts` at the adapter layer and
are re-checked by `@wsa/guardrails` against `EvidenceKindSchema`.

### Consequences

**Positive.**

- Closes the "Grok said it, so it must be true" failure mode before
  it can reach a published Claim.
- Gives operators a mechanical, testable filter rather than a policy
  they'd have to remember.

**Negative.**

- Operators cannot short-cut primary-source retrieval by quoting
  Grokipedia. That is the intent.
- Legitimate news-article-shaped xAI outputs need a small extra step
  (fetch + hash the real article) before they become evidence. That
  step is already required by the ADR-0004 evidence pipeline, so the
  cost here is zero over the baseline.
