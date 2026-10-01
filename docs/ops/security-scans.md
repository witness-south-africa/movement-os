# Security scan results

The `security` workflow uses free Gitleaks CLI 8.30.1 (verified release
archive checksum) and Semgrep CE 1.178.0 (official image digest). Neither
scanner needs a license secret or application token. The Semgrep registry
rule sets remain `p/default`, `p/typescript`, `p/javascript` and `p/secrets`;
these remote rules can change independently of the pinned engine.

Gitleaks scans Git history using a full-depth checkout. Semgrep scans the
checked-out tree with strict error handling and fails when it finds issues.
The dependency-review job also preserves action failures and rejects missing
outputs rather than reporting a false zero.

Every scanner job returns a failure for findings or execution/report errors.
Logs publish counts, file/rule/line locations and whitelisted Semgrep error
types, without source snippets, error messages or secret values. Unknown
error types are counted as `other`. Raw JSON and diagnostics stay in the runner's temporary scan
directory and are not uploaded. Gitleaks also redacts its raw report.
`scripts/security_scan_report.py` returns 0 for a completed clean scan,
1 for findings, and 2 when no clean execution result is available.

These security jobs are not required by the live main ruleset yet. A red
Semgrep job can mean a successful scan with existing findings; inspect its
counts and locations before calling it an execution regression. Triage
findings under [#22](https://github.com/witness-south-africa/movement-os/issues/22)
before promoting security checks to required. Do not discard rules or add
blanket exclusions to make the status green.

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
integrity hashes; independently review every lockfile change. No policy
exclusions are configured.

`strictDepBuilds` rejects unreviewed dependency lifecycle scripts. The
version-specific `allowBuilds` entries cover the six native-tool installers
in the current lockfile: SWC, esbuild, Nx, sharp, unrs-resolver and workerd.
Their version changes require a fresh script review; other dependencies
cannot gain automatic permission to run installation scripts.

The `.npmrc` defense `min-release-age=7` uses **days**, unlike pnpm's minutes.
It requires [npm 11.10 or newer](https://docs.npmjs.com/cli/v11/using-npm/config/#min-release-age)
to take effect; Node 22's bundled npm 10 ignores it. npm remains an unsupported
workspace installation route and is rejected by the early engine check. This
setting does not replace the active pnpm policy or provide another lockfile.
