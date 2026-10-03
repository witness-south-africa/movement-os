# @wsa/evidence-engine

Structured claim extraction through injected providers, with optional
claim-bound challenge calls. The default Worker uses the xAI factory.

## What it does

- accepts already-redacted / already-consented source text plus canonical
  source metadata
- calls a `ModelProvider` in the `analysis` lane
- uses `@wsa/agent-xai` when created through `createXaiEvidenceEngine()`
- converts model output into typed `Claim` and `Evidence` records
- optionally dispatches a distinct `challengeProvider` for each requested
  `high-confidence` or `conclusive` claim, with claim/source-bound results
- offers opt-in `createRoutedEvidenceEngine()` with validated shared lane config
  and separately constructed adapters
- immediately runs `checkEvidencePromotion()` on every extracted claim
- downgrades model-requested `high-confidence` / `conclusive` claims to
  `contested` when the promotion gate blocks them
- returns audit-ready extraction records without pretending the append-only
  audit store already exists

## What it does not do

- no public branding / disclosure surface
- no default routing configuration or automatic challenger in the Worker
- no persistence layer yet
- no live publication path

## Optional challenge provider

Pass a second configured `ModelProvider` to either engine factory:

```ts
const engine = createEvidenceEngine({
  provider: analysisProvider,
  challengeProvider: verificationProvider,
});
const result = await engine.extractClaims(input);
```

Provider IDs must differ; invalid pairing fails before either call. With no
challenger, the existing single-provider extraction and blocked-promotion
fallback remain. Only completed, locally validated analysis starts challenges.
Calls run sequentially, once per promotable candidate, with the input's
per-call token/timeout limits and no retries. A batch makes at most one
analysis call plus `maxClaims` challenge calls (`maxClaims` is capped at ten).
Operators must configure appropriate provider budget and data-handling terms
before opting in; the engine does not reserve spend or enforce a batch budget.

Each challenge prompt contains the exact claim and supplied source text, but
does not include the analysis rationale or requested confidence status. The
response must echo the engine-generated claim ID, exact claim text, source
reference and normalized hash. Incomplete/refused output, wrong identity,
malformed values, binding mismatches and provider errors contribute no
completed challenge run. The candidate remains blocked under R7. Successful
assessments expose `supports`, `contradicts` or `inconclusive`; they do not
change the original evidence kind or add supporting provenance. Completion
can satisfy R7 only; the independent-source rules R2/R3/R4 remain in force.

Each record exposes internally generated `providerRuns` and an optional typed
`challenge` attempt. Its audit records actual completion times, identities,
finite outcomes and reported challenge usage without prompts, source text or
exception messages. Top-level `usage` retains the one analysis call's usage;
challenge usage is separate per attempt. Repeated per-claim analysis run
references describe that same call and must not be counted as separate charges.
An adapter exception may hide provider usage, so failed calls can still incur
costs. These records describe calls through the injected adapters, not signed
vendor receipts or independent source authentication.
Evidence notes are bounded to their 500-character schema limit; full call
identity remains in the run metadata.

The extract Worker does not configure this option or expose run input through
the request envelope. Source tests use offline transports; deployed adoption
and paid provider acceptance need version-linked runtime proof.

## Configured provider routing

`createRoutedEvidenceEngine()` selects analysis and challenge providers using
the shared version-1 config in `@wsa/agent-contracts`:

```ts
const engine = createRoutedEvidenceEngine({
  routing: routingConfig,
  providers: { xai: xaiProvider, openai: openaiProvider },
});
const result = await engine.extractClaims(input);
```

The [secret-free JSON example](../../config/provider-routing.example.json)
selects xAI analysis and OpenAI challenge. Operators load and pass their own
configuration; the factory does not read files, environment variables or
credentials. Reverse pairing and other known provider IDs are configurable,
but both real adapters must be injected and distinct. The shipped
[`@wsa/agent-anthropic`](../agent-anthropic/README.md) adapter can occupy either
lane using its native injected Messages client. It requests structured JSON
and validates the original extraction/challenge schema locally, including
constraints normalized for the provider's wire format. Only native `end_turn`
can complete a challenge; failed, incomplete or differently bound output keeps
R7 blocking. The reserved local ID does not install a missing repository adapter.

Construction validates the complete config and both adapters before any call.
Before every extraction, the factory checks both selected adapters' identity
and callability, then delegates to `createEvidenceEngine()`. Invalid config,
missing adapters or drift fail without analysis dispatch, fallback or provider
substitution. Parsed routes and selected instances are snapshots: construct
a new engine to apply config or registry changes.

Version 1 keeps `sensitive-intake` explicitly disabled. The engine still accepts
only already-redacted / already-consented analysis material under its existing
caller contract; routing does not inspect or classify that material. Existing
factories and Worker wiring retain their current behavior. Challenge completion,
claim/source binding, reported usage, failure containment and promotion guards
are the same as the optional challenger path above. Operator policy, adapter
credentials/models/budgets, deployment adoption and live provider acceptance
remain separate requirements.

## OpenAI subscription output policy

Engine calls retain a default output cap of 900 tokens. API requests still
forward the caller's `maxOutputTokens` to both lanes. OpenAI's subscription
preview cannot accept an output cap, so subscription use needs an explicit
factory policy for its selected lane:

```ts
const engine = createRoutedEvidenceEngine({
  routing: routingConfig, // xAI analysis, OpenAI challenge
  providers: { xai: xaiProvider, openai: openAiSubscriptionProvider },
  subscriptionPolicy: { lane: 'challenge', allowUncappedOutput: true },
});
// Omit maxOutputTokens: a supplied global cap conflicts with this policy.
const result = await engine.extractClaims(inputWithoutOutputCap);
```

The same option works in `createEvidenceEngine()`, `extractClaimsWithProvider()`
and the xAI factory when its challenger uses subscriptions. `lane: 'analysis'`
permits OpenAI subscription analysis with a distinct capped challenger. Policy
parsing is strict and requires `allowUncappedOutput: true`; it is not inferred
from credentials, provider IDs or a failed API request. Construction requires
the selected adapter to declare `id: 'openai'` and `accessMode: 'subscription'`.
OpenAI API and subscription modes remain one vendor for R7.

The policy removes the output-cap field only from that subscription lane. The
other lane keeps its 900-token default. A supplied `maxOutputTokens` rejects
the whole extraction before either call, rather than silently dropping a hard
ceiling. Both lanes retain the input timeout (20 seconds by default, at most
120 seconds per call), claim count (at most ten), sequential challenges and no
retry or billing fallback. Native Responses byte/event bounds still apply;
local cancellation and resource limits do not guarantee an upstream token,
plan-usage or monetary ceiling. This policy explicitly accepts that limitation.
[Official preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Configuration and selected instances are snapshots; construct a new engine to
change them. With a subscription policy, both adapters' IDs, declared modes and
completion functions are checked before dispatch and after each awaited call.
Binding drift rejects the extraction and prevents later calls. The subscription
response must also report that mode: an analysis mismatch rejects extraction;
a challenge mismatch records failure and retains R7. Optional reported access
mode is preserved in results, completed runs and audit details, without
inventing a mode for adapters that do not report one.

Subscription challenge quota exhaustion records a finite `quota-exhausted`
failure, then skips later promotable challenges in that extraction with
`subscription-quota-exhausted`. All affected claims retain R7. A new extraction
starts fresh; API and calls without this policy retain their existing failure
behavior. Failed calls may omit usage, so those observations do not prove zero
consumption. No subscription quota, spend reservation or account eligibility is
inferred. Source tests use offline fetch/SSE; live account, model and inference
acceptance and Worker adoption remain pending.

## Building

```sh
pnpm nx run @wsa/evidence-engine:build
```

## Running unit tests

```sh
pnpm nx run @wsa/evidence-engine:test --runInBand
```
