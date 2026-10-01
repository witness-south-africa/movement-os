ADR-0007 extract-api proof bundle summary

Timeline
- Initial deploy reached a partial state: worker upload and secret binding succeeded, but the first host exposure used a `workers.dev` fallback while the intended custom-domain cutover was still unresolved.
- Custom-domain fix landed next: the conflicting manual DNS record was removed, then the worker was redeployed as a Cloudflare Custom Domain. The deploy transcript now records only `[redacted-custom-domain]`.
- Acceptance proofs were then captured against the live custom-domain endpoint with redacted outputs only.
- A later narrow worker patch added minimal pre-envelope auth-failure telemetry so unsigned `401` requests also leave a safe telemetry envelope. Live behavior was confirmed on the existing custom-domain endpoint.

Acceptance evidence map
- Signed request -> `200` with populated promotion data: [probe-signed-200.json](./probe-signed-200.json)
- Unsigned request -> `401`: [probe-unsigned-401-with-telemetry.json](./probe-unsigned-401-with-telemetry.json)
- Unsigned/auth-failure telemetry reference: [telemetry-auth-401-redacted.json](./telemetry-auth-401-redacted.json)
- Success telemetry reference: [telemetry-success-redacted.json](./telemetry-success-redacted.json)
- Concurrency/rate-limit proof: [probe-rate-limit-429.json](./probe-rate-limit-429.json)
- Budget exhausted -> `429`: [probe-budget-exhausted-429.json](./probe-budget-exhausted-429.json)
- Budget-exhausted telemetry reference: [telemetry-budget-exhausted-redacted.json](./telemetry-budget-exhausted-redacted.json)

Supporting control-plane evidence
- Custom-domain deploy transcript: [deploy-custom-domain.log](./deploy-custom-domain.log)
- Conflicting DNS record removal: [delete-conflicting-dns.json](./delete-conflicting-dns.json)
- Budget-cap forcing and restoration: [budget-cap-proof-transcript.txt](./budget-cap-proof-transcript.txt), [restore-budget-cap-high.log](./restore-budget-cap-high.log)

Redaction notes
- Full operator-surface hostnames are replaced with `[redacted-custom-domain]` in PR-facing control-plane transcripts.
- Worker/service names are replaced with `[redacted-worker]` where they are not necessary for review.
- Telemetry object keys are truncated to references ending in `....json`.
- Operator key identifiers are reduced to `OP...`.

Bundle guidance
- `telemetry-list.json` is intentionally omitted because it was a failed intermediate query and is superseded by the explicit redacted telemetry-reference files.
