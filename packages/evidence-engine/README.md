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

## Building

```sh
pnpm nx run @wsa/evidence-engine:build
```

## Running unit tests

```sh
pnpm nx run @wsa/evidence-engine:test --runInBand
```
