# 0007 — Extract API surface scoping

- Status: accepted
- Date: 2026-04-18
- Relates to: [ADR-0001](./0001-agent-framework.md),
  [ADR-0003](./0003-llm-provider-matrix.md),
  [ADR-0005](./0005-promotion-gate.md),
  [ADR-0006](./0006-email-worker-ingress.md)

## Context

`@wsa/evidence-engine` is now on `main` and provides the first real
`guardrails -> @wsa/agent-xai` runtime path in code. The private
operator-facing extract API has a historical Cloudflare deployment bundle
dated April 20, 2026. It records end-to-end observations on that date;
it does not bind the currently deployed Worker to the source revision
reviewed here. Current adoption requires fresh version-linked proof.

This ADR scopes the thinnest correct first deployed surface. It answers
the five blocking unknowns before any implementation starts:

1. where the surface runs
2. how it authenticates callers
3. which hostname it uses
4. how it rate-limits and protects the xAI budget
5. how it handles potentially sensitive source text under POPIA

This ADR records the surface decision, its historical implementation proof
and the acceptance contract for subsequent revisions. Branding and disclosure
copy remain separate work.

## Decision

The first deployed consumer of `@wsa/evidence-engine.extractClaims()`
will be a **private Cloudflare Worker JSON API** on a **custom WSA
subdomain**, protected by **HMAC-SHA256 request signing**, with
**Worker-enforced per-operator rate limits** and **zero request-body
persistence**.

### 1. Runtime: Cloudflare Worker

The surface will run as a Cloudflare Worker in the existing
`witnesssouthafrica.org` Cloudflare account.

Why this, not a Node service:

- the project already proves Cloudflare Workers operationally via the
  live `wsa-email-ingress` Worker
- deploy, secret, DNS, and audit posture are already concentrated in
  one control plane
- there is no standing server to patch, harden, or monitor for a v0.1
  operator-only endpoint
- the endpoint is thin request validation + orchestration, not a long-
  running process or websocket service

This is the smallest deployment surface that matches what the repo
already knows how to operate.

### 2. Authentication: HMAC-SHA256 request signing

Authentication will be a shared-secret HMAC scheme, not a static bearer
token and not Cloudflare Access.

Required headers:

- `X-WSA-Key-Id`
- `X-WSA-Timestamp`
- `X-WSA-Content-SHA256`
- `X-WSA-Signature`

Signature input:

```text
<HTTP method uppercased>\n
<raw request path and raw query, exactly as received>\n
<timestamp>\n
<sha256(raw body bytes)>
```

Canonicalization rules:

- `HTTP method` is uppercased ASCII before signing (for example `POST`)
- `request path` means the raw path plus raw query string, if present
  (for example `/v1/extract?mode=fast`)
- percent-encoding is preserved exactly as received; no path or query
  normalization is allowed before signing
- the body hash is the lowercase hexadecimal SHA-256 of the raw request
  body bytes exactly as received
- the four-line signing string is encoded as UTF-8 bytes before HMAC
- line separator is a single LF byte (`0x0A`)
- there is no trailing newline after the body-hash line

Signing algorithm:

- `HMAC-SHA256`
- shared secret: `OPERATOR_HMAC_KEY_<KEY_ID>` from Infisical
- replay window: ±300 seconds

For compatibility, punctuation in a key ID maps to `_` for secret lookup.
The verified identity uses that same canonical ID for telemetry and the
Durable Object limiter, so aliases share one counter. Timestamps are whole
decimal seconds and must fit a safe integer.

Why this, not the alternatives:

- **not static bearer**: a bearer secret copied once can be replayed
  forever; HMAC binds the secret to the exact body and timestamp
- **not Cloudflare Access**: Access is good for human browser sessions,
  but this lane needs a machine-first operator client that can be run
  from CLI or automation without introducing IdP/session coupling
- **not "authenticated" as a vague promise**: HMAC gives a concrete
  reject/accept boundary and deterministic proof for signed vs unsigned
  probes

The Worker must reject:

- missing signature headers
- stale timestamps
- body-hash mismatch
- unknown key ids
- signature mismatch

Reject status: `401`.

### 3. Hostname: `extract-api.witnesssouthafrica.org`

The endpoint will live at:

```text
https://extract-api.witnesssouthafrica.org/v1/extract
```

Why this hostname:

- keeps the runtime inside the WSA domain family
- is explicit about function without polluting the public root site
- avoids the operational and attribution drift of a `*.workers.dev`
  host
- can remain unlinked from the public site while still using WSA-owned
  DNS, TLS, and logs

This hostname is **operator-facing**, not public-facing. It is not to
be linked from the landing page, sitemap, or public docs.

### 4. Rate limiting: 6 requests/minute/operator, enforced in Worker

Per-operator rate limit:

- `6` requests per minute per canonical operator key ID
- `2` in-flight requests maximum per operator

Enforcement location:

- inside the Worker
- backed by a single Durable Object keyed by the canonical operator key ID

Why this shape:

- xAI spend is finite and already budget-gated at the provider layer,
  but budget caps alone are too late to stop burst abuse
- IP-based limits are the wrong identity boundary for operator traffic
- Durable Objects give a single serialised counter per operator,
  which is exactly the boundary we need for honest throttling

Reject status on rate limit:

- `429`
- JSON body includes `reason=rate_limited`

Reject status when recorded monthly xAI spend reaches the configured cap:

- `429`
- JSON body includes `reason=budget_exhausted`
- the Worker must not call xAI in this case

The guard reads persisted monthly costs before a call. It is not an atomic
global spend reservation: concurrent calls or one call's cost can cross the
remaining allowance. A failed success-telemetry write returns `500`, and its
provider charge may be missing from the ledger. Storage outages require an
operator pause and reconciliation; a strict global spend ceiling needs a
separate reservation design.

### 5. Source-text handling: Lane-2 only, memory-only, no body logging

The endpoint is scoped to **Lane 2** only:

- already-redacted text
- already-consented text
- public records
- already-public archive material

It is **not** for raw witness intake.

The request envelope will wrap the existing `ExtractionInput` with an
operator attestation:

```json
{
  "operatorAttestation": {
    "classification": "lane2-redacted-or-consented"
  },
  "extract": {
    "...": "existing @wsa/evidence-engine ExtractionInput"
  }
}
```

Handling rules:

- request body is read into memory only
- request body is never written to R2
- request body is never written to KV / Durable Object storage
- request body is never logged via `console.log`
- telemetry stores only:
  - `requestId`
  - `keyId`
  - `sourceRef`
  - `sourceSha256`
  - source text byte length
  - provider/model/token/cost fields
  - outcome / status

POPIA posture:

- the endpoint refuses to be a general intake path
- lawful basis stays with the caller and the upstream artefact custody
  flow, not this API
- this API only processes material that the operator explicitly attests
  is already safe for Lane 2 handling

If a future lane needs raw witness intake, that is a separate ADR and a
different endpoint.

## Supporting runtime design

### Telemetry sink

The first deployed surface will persist xAI telemetry events to a
dedicated private R2 bucket:

- bucket: `wsa-telemetry`
- provider events: `xai/<YYYY-MM>/<generated-event-uuid>.json`
- sampled auth failures: `auth/<YYYY-MM>/<generated-event-uuid>.json`
- `requestId` remains correlation data inside the record, never its storage key
- version metadata adds the full Worker version ID and, when tagged with a
  full source SHA, `workerSourceSha`; neither is exposed in the API response

Why:

- the provider layer already emits append-only telemetry events
- R2 is already a proven storage primitive in this project
- a dedicated bucket avoids mixing telemetry with email evidence

Auth telemetry stores only `missing` or `provided` for the unverified key
header. At most six failures per minute per Worker isolate are sampled,
with synchronous admission before storage work. Writes run through
`ctx.waitUntil`, catch storage errors and never delay or replace `401`.
Isolate resets and fleet scaling can exceed that sample count globally;
this is not a perimeter abuse quota. Auth records are excluded from monthly
provider-cost scans. R2 retention and perimeter controls require separate
operational configuration.

### Response shape

Successful signed requests return:

- `200`
- extracted claims
- evidence preview
- `promotionDecision` per extracted claim
- `requestedStatus` and `effectiveStatus` per claim

This is required so callers can prove the promotion gate actually ran
rather than assuming it did.

### Non-goals

This lane does **not**:

- expose a public webpage
- mention `Grok` or `xAI` in any public artefact
- add challenge-lane orchestration
- persist the extracted claims as final records
- replace the email worker as the canonical evidence inbox

## Acceptance proof for the implementation lane

The implementation PR for this ADR must prove:

1. **Endpoint reachable + auth enforced**
   - signed probe returns `200`
   - unsigned or tampered probe returns `401`
2. **xAI actually invoked**
   - telemetry object exists in `wsa-telemetry`
   - object shows `model`, `inputTokens`, `cachedInputTokens`,
     `costInUsdTicks`, `requestId`
3. **Promotion gate actually ran**
   - response includes populated `promotionDecision`
4. **No public attribution leaked**
   - endpoint response and any public surface contain no `Grok` or
     `xAI` string
5. **Budget cap works**
   - deliberately exceeded cap returns `429` with
     `reason=budget_exhausted`
   - request does not fall through to a `500`

Historical observations for this ADR were recorded on `2026-04-20` via the
redacted artifact bundle in
[`artifacts/adr-0007-proof-20260420/`](../../artifacts/adr-0007-proof-20260420/),
including signed `200`, unsigned `401`, promotion-decision evidence,
and telemetry references for auth-failure, success, and
budget-exhausted paths.

The bundle lacks a full deployed source SHA and build digest; its version
ID is truncated, and a later auth patch is not linked to that version.
Four concurrent probes show two in-flight admissions and two rejections,
not independent proof of the six-per-minute limit. Budget restoration
records an upload success without readback of the restored value. Preserve
these files as dated observations rather than current certification.
Use the [operator runbook](../ops/extract-api-runbook.md) for new proof.

## Consequences

Positive:

- gives the platform a real private production consumer before any
  public xAI claim is made
- keeps deployment on already-proven Cloudflare primitives
- keeps operator auth machine-first and replay-resistant
- prevents request-body sprawl into logs or storage

Negative:

- introduces a Durable Object for per-operator throttling
- introduces a second private R2 bucket for telemetry
- requires operator clients to implement HMAC signing correctly

These are acceptable costs for a first deployed xAI surface because
they buy honest proof, bounded spend, and a cleaner POPIA story.

## Rollout

1. Deploy `extract-api.witnesssouthafrica.org` as a private Worker
   custom domain.
2. Add HMAC verification and timestamp replay checks.
3. Add Durable Object per-operator throttling.
4. Add R2 telemetry sink (`wsa-telemetry`).
5. Call `@wsa/evidence-engine.extractClaims()` from the Worker.
6. Prove the five acceptance checks above.
7. Only after that, start the brand/disclosure lane.

The April 20 bundle records observations for items 1-6 with the provenance
limits above. Deployment and acceptance of the hardened revision remain
pending fresh proof. Item 7 remains separate.
