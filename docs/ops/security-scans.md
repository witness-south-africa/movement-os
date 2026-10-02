# Security scan results

Repository posture and source inventories are covered separately by
[Scorecard and SBOM reports](./supply-chain-reports.md).

The `security` workflow uses free Gitleaks CLI 8.30.1 (verified release
archive checksum) and Semgrep CE 1.178.0 (official image digest). Neither
scanner needs a license secret or application token. The Semgrep registry
rule sets remain `p/default`, `p/typescript`, `p/javascript` and `p/secrets`;
these remote rules can change independently of the pinned engine.

Gitleaks scans Git history using a full-depth checkout. Semgrep scans the
checked-out tree with strict error handling and fails when it finds issues.
The dependency-review job also preserves action failures and rejects missing
outputs rather than reporting a false zero.
The dependency-audit job audits the complete lockfile against the public
registry and fails for advisories at every severity, including existing
dependencies that are outside the dependency-review change set.

Every scanner job returns a failure for findings or execution/report errors.
Logs publish counts, file/rule/line locations and whitelisted Semgrep error
types, without source snippets, error messages or secret values. Unknown
error types are counted as `other`. Raw JSON and diagnostics stay in the runner's temporary scan
directory and are not uploaded. Gitleaks also redacts its raw report.
`scripts/security_scan_report.py` returns 0 for a completed clean scan,
1 for findings, and 2 when no clean execution result is available.

A red Semgrep job can mean a successful scan with findings; inspect its
counts and locations before calling it an execution regression. Triage
findings under [#22](https://github.com/witness-south-africa/movement-os/issues/22).
Do not discard rules or add blanket exclusions to make the status green.

## CodeQL security analysis

The source-owned `CodeQL security` workflow complements required Semgrep.
It scans JavaScript/TypeScript, Python and GitHub Actions with GitHub's
[`security-extended` suite](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-query-suites)
on every PR targeting main, every main push and weekly. Interpreted-language
extraction uses `build-mode: none`, without project installation or build
commands. Dependencies and generated sources unavailable to extraction can
limit analysis. The actions are SHA-pinned; record the actual CLI/query-pack
versions from each run because the action manages its tooling separately.

Only the analysis jobs grant `security-events: write`; workflow defaults
are read-only and checkout does not persist credentials. The workflow uses
ordinary `pull_request`, never privileged PR-target execution. Independent
language jobs continue if another language fails. Upload waits for code
scanning processing, with separate stable `security/codeql/<language>`
categories. Inspect actual extraction/query execution, source revision,
analysis errors and CodeQL alerts: a successful upload can contain findings.
For PR scans, bind the analyzed test-merge revision to the reviewed PR head
and base; main analyses must name the landed commit.

PR results and the service check for new alerts cover the PR comparison;
zero new PR alerts do not prove that unchanged source is clean. Inspect
the full landed-main analyses and open alerts before reporting a clean
baseline. The first source-owned scan found an existing trailing-slash
normalization regex with polynomial runtime even though the rollout PR
reported no new alerts. Its input is a deployment-controlled environment
binding; the finding does not establish remote exploitation.

The dynamic `CodeQL - Code Quality` workflow is a separate service and does
not establish execution of this security workflow. Live CodeQL default
setup was `not-configured` before this source rollout; advanced setup is
owned by the checked-in workflow. Existing nine required checks, including
findings-failing Semgrep, remain the merge policy. A new CodeQL requirement
would need a separate reviewed promotion and live-settings proof.

Scorecard's current SAST detector recognizes checked-in CodeQL `analyze`
and selected application providers, but not Semgrep CLI or ordinary
`github-actions` checks. Its [implementation and scoring](https://github.com/ossf/scorecard/blob/c395761df6afe1a69e476bc60a013a94bcbc153f/checks/evaluation/sast.go)
combine configuration with recognized scan history for recent merged PRs.
Adding a genuine workflow does not repair historical coverage. Verify fresh
Scorecard/SARIF and the live posture alert independently; keep historical
limitations explicit even if the alert closes. Track remaining work in
[#22](https://github.com/witness-south-africa/movement-os/issues/22).

## Required-check rollout

The intended `main-protection` policy requires `semgrep`, `gitleaks`,
`dependency-review` and `dependency-audit`, alongside `lint`, `typecheck`,
`test`, `build` and `quorum-audit`. The four new security requirements name
GitHub Actions (integration ID `15368`) as their check provider. Existing
code/governance requirements retain their provider configuration.

The security workflow runs on every PR targeting main and every main push,
including changes confined to documentation or Markdown. Keep those
triggers unconditional: skipping an entire required workflow leaves its
checks unreported and blocks a PR. Dependency review executes on PRs; its
job is intentionally skipped on main pushes, where there is no PR diff.

The [ruleset snapshot](../../ruleset-main.json) is the reviewed intended
configuration. It does not apply live settings. Complete promotion in this
order:

1. Merge the unconditional workflow after independent review, successful
   code/security jobs and the existing protected-merge checks.
2. Open a docs-only PR based on that landed main revision. Verify that all
   four security jobs actually execute and succeed on its current head.
3. Freeze that head and obtain independent quorum and lifecycle evidence.
   Compare a fresh live ruleset with the reviewed update: preserve all
   existing checks, strict base testing, squash/linear history and no bypass.
4. Apply the reviewed policy only with session authorization, then read
   back the live ruleset. Confirm all nine exact contexts and the four
   provider IDs; a source snapshot or a successful API request is insufficient.
5. Verify the docs-only PR satisfies all nine live required checks, merge
   through protection and verify landed-main CI/scans and quorum event paths.
   Record the live settings and evidence in #22 before marking S2 complete.

The initial scan of main `4be0baa9dbe4d22bb6b83b72d91ac9dcebc59b3d` on
2026-10-01 completed with zero Gitleaks findings and 24 Semgrep findings,
with no Semgrep execution errors. Eighteen were mutable-action references;
the remaining findings concern package-manager policy, an email-auth regular
expression and a synthetic HMAC test key. This change pins the actions in
both workflows, adds supported package-manager policies, uses explicit
email-auth regex literals and generates the synthetic test key at runtime.
Trackers #36–#39 account for the eighteen findings remaining after the initial
scanner repair. The regex and test-key audit matches did not establish an
exploitable production vulnerability. Closure requires a clean final-head
rescan and verified source merge; runtime adoption is separate.

## Dependency policy

Use the exact `pnpm@10.34.6` in `package.json` through Corepack. CI reads that
same pin. `engine-strict=true` and `engines.npm: "<0"` reject every npm
version before dependency installation or lifecycle scripts run. Strict
pnpm version checks and the root preinstall guard enforce the intended route.
Do not use
`--ignore-scripts` to bypass those controls for normal workspace installation.

The [pnpm 10 settings](https://pnpm.io/10.x/settings) in
`pnpm-workspace.yaml` delay newly resolved dependency releases by seven days
(`minimumReleaseAge: 10080` minutes), block exotic transitive dependency
sources and reject package trust downgrades (`trustPolicy: no-downgrade`).
These are **resolution/update-time protections**. pnpm 10 frozen installs
skip resolution and do not re-audit locked release age, trust or exotic
sources. CI preserves the reviewed lockfile with `--frozen-lockfile` and its
integrity hashes; independently review every lockfile change. The two exact
historical trust exceptions, parent constraints and Dependabot's security
update age override are recorded in
[dependency remediation](./dependency-remediation.md).

`strictDepBuilds` rejects unreviewed dependency lifecycle scripts. The
version-specific `allowBuilds` entries cover SWC, esbuild, Nx, two
unrs-resolver versions and workerd. Parcel watcher's source-build script is
explicitly denied; its locked prebuilt binding is used. The selected sharp
release has no installation lifecycle script.
Their version changes require a fresh script review; other dependencies
cannot gain automatic permission to run installation scripts.

The `.npmrc` defense `min-release-age=7` uses **days**, unlike pnpm's minutes.
It requires [npm 11.10 or newer](https://docs.npmjs.com/cli/v11/using-npm/config/#min-release-age)
to take effect; Node 22's bundled npm 10 ignores it. npm remains an unsupported
workspace installation route and is rejected by the early engine check. This
setting does not replace the active pnpm policy or provide another lockfile.
