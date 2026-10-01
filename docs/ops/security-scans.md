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
Logs publish counts and file/rule/line locations, without source snippets or
secret values. Raw JSON and diagnostics stay in the runner's temporary scan
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
expression and a synthetic HMAC test key. This repair pins the actions in
the security workflow; remaining action pinning and finding triage stay in
#22. The regex and test-key audit findings require review, not an assumption
that they prove exploitable production behavior.
