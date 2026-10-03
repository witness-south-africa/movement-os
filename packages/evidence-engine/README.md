# @wsa/evidence-engine

Thin orchestration layer for the first real xAI runtime path in
`movement-os`.

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
but both real adapters must be injected and distinct. Reserved Anthropic/local
IDs do not install their missing repository adapters.

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

## Building

```sh
pnpm nx run @wsa/evidence-engine:build
```

## Running unit tests

```sh
pnpm nx run @wsa/evidence-engine:test --runInBand
```
