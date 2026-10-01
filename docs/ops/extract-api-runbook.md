# Extract API deployment and acceptance

Use this runbook for ADR-0007 revisions. Source merge, Cloudflare deployment
and runtime acceptance are separate facts. The April 20 bundle is historical
and has no complete source/build/version chain. Do not fill those gaps by
inference. Existing role, quorum and merge rules remain in the
[shared protocol](./agent-protocol.md).

## Prepare a reviewable revision

From an isolated clean worktree, record the full source SHA and validate:

```sh
git status --short
git rev-parse HEAD
pnpm install --frozen-lockfile
NX_DAEMON=false pnpm nx run @wsa/extract-api-worker:test --runInBand
NX_DAEMON=false pnpm nx run @wsa/extract-api-worker:lint -- --max-warnings=0
NX_DAEMON=false pnpm nx run-many -t build typecheck --projects=@wsa/extract-api-worker
python3 -B -m unittest discover -s scripts -p 'test_*.py'
```

Keep raw envelopes, credentials, deployment JSON and full responses under a
private directory outside git. Give it mode `0700` and files mode `0600`.
Only a reviewed structural projection belongs in `artifacts/`. Do not use
shell tracing, command-line HMAC secrets or raw response logging.

Build without deployment from the package directory:

```sh
pnpm exec wrangler deploy --dry-run --outdir /tmp/extract-api-proof/bundle
sha256sum /tmp/extract-api-proof/bundle/index.js
```

Record Node, pnpm and locked Wrangler versions, source SHA, lockfile/config
digests and hashes of every uploaded JS/auxiliary module. Generated build
output alone proves packaging, not a deployed version. Verify the build tree
is still clean and the source has not changed before deployment.

## Inspect the current control plane

Use the existing scoped Infisical/Cloudflare credentials without exporting
them into chat. In `packages/extract-api-worker`:

```sh
pnpm exec wrangler whoami
pnpm exec wrangler versions list --json
pnpm exec wrangler deployments list --json
```

Record UTC time, full active deployment/version IDs and traffic percentages.
Inspect bindings, custom-domain route, cap and limiter configuration, and
previous version for rollback. Retain secret values privately; a binding name
or successful secret upload does not prove its value. Verify current access
before interpreting a missing response as absent infrastructure.

Explicit `workers_dev = false` and `preview_urls = false` in the config keep
the intended exposure to the existing custom domain. Omitted preview settings
can preserve earlier configuration; confirm the effective exposure after
deployment. See [Cloudflare configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Deploy with source provenance

Deployment, provider spend and production cap changes require session
authority covering those actions. Prepare the revision and capture plan
before requesting any missing authority. A merge instruction alone does not
grant it.

When authorized, deploy the already reviewed clean revision with its full
source SHA as `--tag` and bundle digest in `--message`. For a squash merge,
use the landed main SHA and prove its tree matches the reviewed PR tree.
Preserve the effective existing variables and secrets; the default deploy
can replace dashboard variables, so inspect them first and use `--keep-vars`
when needed. Uploading a version and assigning it traffic are different steps.

The `CF_VERSION_METADATA` binding adds `workerVersionId` to stored telemetry.
A tag that is exactly a full lowercase source SHA also adds `workerSourceSha`.
Match both against the control-plane version and clean build record; a tag
by itself is an operator assertion. Metadata is not returned by the API.
See [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
and [versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

## Capture correlated probes

Use a short synthetic Lane-2 envelope containing no witness data. Supply
`EXTRACT_OPERATOR_KEY_ID` and the corresponding canonical
`OPERATOR_HMAC_KEY_<ID>` through the approved secret environment. The probe
helper prints status, known reason, response digest and structural flags;
it never prints request/response text or headers. Run from the repo root:

Signed proof requires a valid input request ID, an equal returned request ID
and required claim/promotion/evidence fields, including extractor and temporal
provenance. This is structural validation; source truth and the promotion
decision still need the matching telemetry and runtime review. Attribution checks inspect
decoded JSON, including escaped strings. The emitted request-ID digest joins
the corresponding telemetry projection without publishing its raw ID.

```sh
python3 -B scripts/extract_probe.py --url "$EXTRACT_PROOF_URL" --mode unsigned
python3 -B scripts/extract_probe.py --url "$EXTRACT_PROOF_URL" --mode tampered --envelope /tmp/extract-api-proof/envelope.json
python3 -B scripts/extract_probe.py --url "$EXTRACT_PROOF_URL" --mode signed --envelope /tmp/extract-api-proof/envelope.json --allow-provider-call
```

Each invocation sends one request. Signed/budget modes may spend provider
budget and require `--allow-provider-call`. Set the URL to the existing
operator endpoint only after confirming target and authority. Exit zero
means the requested observation passed; it does not certify the entire lane.

| Observation | Required correlated proof                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | Unsigned/tampered `401`; a sampled `auth/` record has fixed key category, zero usage, full version/source and no input text/header. Sampling can intentionally omit events.                                               |
| Extraction  | Signed `200`; summary, at least one claim, populated promotion decisions and no provider attribution; matching `xai/` record has the request ID, version/source, model, tokens/cache/cost.                                |
| Concurrency | More than two overlapping signed calls yield in-flight rejection; separately count six admitted calls within a minute before checking the seventh. These are potentially paid probes and need their own budget authority. |
| Budget      | A controlled exhausted-cap probe returns `429`, `budget_exhausted`, with zero provider usage. Confirm the cap/state before a potentially paid request.                                                                    |

For cap proof, prefer an isolated zero-cap canary with the same verified
bundle and dedicated test resources. Record that it proves the canary, not
production configuration. If production cap forcing is explicitly authorized,
retain the original value privately before changing it, pause normal traffic,
restore it in a failure-safe cleanup and verify its effective value afterward.
An upload-success log is insufficient restoration proof. Do not copy production
operator/provider secrets into a public preview or new target without authority.

## Storage and spend limits

Provider records use generated object UUIDs; repeated client request IDs
remain separate accounting events. Auth samples use a separate prefix and
cannot inflate provider budget scans. Sampling is six writes per minute per
isolate, not a global quota; scaling/resets can increase the fleet count.
R2 retention and perimeter abuse controls remain operational follow-up.

Auth writes run with `ctx.waitUntil` and failures do not affect `401`.
Failure telemetry rejection preserves `429`/`500`. Successful extraction
requires its accounting write before `200`; if that write fails, the caller
gets `500` while the provider charge can still be unrecorded. Pause calls and
reconcile provider charges during storage incidents. The monthly guard scans
persisted costs without global reservations, so it is not a strict concurrent
spend ceiling.

## Acceptance handoff

Publish only reviewed redacted evidence: UTC observation times, full source
SHA/tree, build hashes, full active version/deployment, effective non-secret
configuration, probe digests/flags and matching telemetry projections.
Hash the final projections into a manifest. Keep correlation identifiers
consistent enough to join probe and telemetry records; replace them with the
same digest if they need redaction. Preserve unknowns explicitly.

L1 verifies merge/tree/main CI independently, then issues a separate runtime
verdict only when the source/build/version/probe chain is complete. Recheck
active traffic and cap restoration before closing deployment acceptance.
