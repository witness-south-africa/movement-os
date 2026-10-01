# Lifecycle — L1

Verify the slice's current evidence for a named stage: review, merge or
deployment. Establish the actual worktree, exact PR head, base and diff.
Inspect current files and underlying evidence rather than inheriting a
prior readiness conclusion.

Report these facts separately when relevant:

- source and local validation, including the tested commit
- hosted required checks and unresolved review threads
- independent role attestations on the current head
- merge status and authority
- deployed revision, runtime acceptance and evidence date

Archived artifacts establish historical observations. State their dates
and limitations before using them for a current deployment verdict.
`MERGEABLE` alone does not establish merge readiness, and a head change
requires a fresh check of commit-bound evidence.

For a required-check policy change, follow the
[security rollout](../security-scans.md#required-check-rollout). Verify
the actual jobs and their check providers on a docs-only PR before live
promotion, then confirm the exact requirements through live settings
readback. A checked-in ruleset or a successful settings request does not
establish enforcement. The proof PR must satisfy the newly active checks
before its protected merge.

On a main push, dependency review is intentionally skipped because there
is no PR diff. Its successful execution on the proof PR remains required;
report that separately from the push-applicable scanner results.

Output a stage-specific verdict with the full head SHA, reasons, inspected
files, evidence and residual risk:

```text
Agent L1: ready for <slice> on <full-head-sha> for <stage>
Agent L1: not ready for <slice> on <full-head-sha> for <stage>
```

Certify only the verified slice and stage. Do not implement changes or
certify unrelated dirty files. L1 remains a procedural seat; the current
quorum workflow does not enforce its signature.
