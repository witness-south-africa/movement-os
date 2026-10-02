# Supply chain reports

These reports provide repository security posture and source dependency
inventory for [#22](https://github.com/witness-south-africa/movement-os/issues/22).
They complement the nine protected-merge checks described in
[security scans](./security-scans.md). They do not add required check contexts.

## Scorecard

The `OpenSSF Scorecard` workflow runs on every main push and weekly on Monday
at 06:23 UTC. It uses the default GitHub token, a commit-pinned official
Scorecard action and only upstream-supported publication steps. The analysis
job grants `security-events: write` for SARIF ingestion and `id-token: write`
for public Scorecard publication; repository contents remain read-only.
Pull requests cannot trigger this workflow.

The workflow retains `results.sarif` in `scorecard-<full-commit>` for 30 days,
uploads it to GitHub code scanning and publishes public Scorecard results.
Scorecard embeds the categories `supply-chain/branch-protection`,
`supply-chain/local` and `supply-chain/online-scm` in its SARIF. These take
precedence over the upload step's `openssf-scorecard` fallback category;
verify the actual categories, commit and findings in the analysis records.
Low scores and posture findings remain visible in
the report; successful execution does not mean the repository has no
findings. Execution/signing, SARIF ingestion and missing-artifact errors fail
the job. The upstream action treats exhausted public API upload retries as
a warning, so a successful job does not prove public API publication. Inspect
the publication logs and public API result separately when verifying rollout.

The action is pinned to its reviewed v2.4.4 commit. Its upstream implementation
uses the `ghcr.io/ossf/scorecard-action:v2.4.4` container tag; the transitive
container is not digest-pinned by this workflow. Review upstream behavior
when updating the action. Identity separation, CODEOWNERS and other posture
changes need their own reviewed scope.

## Source SBOM

The `Source SBOM` workflow runs on every tag push, PR targeting main and
manual dispatch. PR reports use the actual PR head commit; tag reports use
the tagged commit. It needs only `contents: read`. It downloads Syft 1.52.0
from the official release and verifies the reviewed archive SHA-256 before
execution. It neither installs workspace dependencies nor runs project
lifecycle scripts, creates releases or publishes release assets.

The inventory includes the full pnpm lockfile and the root/workspace source
manifests, including development, optional and platform dependencies. Syft's
JavaScript package cataloger is enabled explicitly because lockfile discovery
alone omits source workspace identities. The validator compares both report
formats against every locked name/version and every source manifest. At the
initial rollout this covers 1,115 locked identities and 12 source manifests;
future counts come from the checked-out source, rather than a fixed baseline.
Both formats must identify the same full source commit and expected generator.
Unknown or multi-document lockfile layouts, partial inventories, stale
reports and malformed output fail validation. A new lockfile format or
workspace layout requires a reviewed validator update.

Each successful run retains `sbom-<full-commit>` for 90 days with:

- `movement-os.spdx.json`: SPDX 2.3 inventory.
- `movement-os.syft.json`: Syft's native inventory and package metadata.
- `provenance.json`: commit, tag/ref, event, run/attempt, generator version
  and archive checksum, lockfile and manifest hashes, output hashes and counts.
- `SHA256SUMS`: SHA-256 checksums for both reports and provenance.

Download the artifact from the particular run, preserve GitHub's artifact ID
and archive digest, then verify the downloaded ZIP against that digest. After
extraction run `sha256sum --check --strict SHA256SUMS`. Check that provenance
names the intended repository, full commit, event, ref/tag and run/attempt.
The provenance generator checksum must match the reviewed workflow pin.
Compare manifest/lockfile hashes and inventories with that exact revision.
These checks bind the downloaded evidence to the observed run; provenance
is generated metadata, not an independent signature or build attestation.

A neutral proof tag can exercise the actual tag-push route after protected
source merge. Record the tag's resolved commit, successful workflow run,
artifact ID/digest, downloaded checksums and coverage before closing S4.
A manually dispatched run or locally generated file alone is insufficient.

This is a source and lockfile inventory. It does not establish which packages
are present in a deployed bundle or container, prove vulnerability absence,
or establish runtime acceptance. Continue to use the required dependency
checks for advisory enforcement.
