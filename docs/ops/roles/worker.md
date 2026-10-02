# Worker — WS1 / WS2

Implement the named slice and validate its behavior. Inspect the actual
worktree and source before editing. Preserve unrelated changes and use
an isolated worktree for implementation.

After creating the worktree, set it explicitly as the working directory for
intake, dependency setup, validation and edits. A failed intake or setup
must halt dependent commands; do not continue an installation in the
original checkout after a worktree preflight fails.

Record base/head SHA, files in scope and acceptance criteria. Infer routine
details from the issue and session; ask when ambiguity would change the
scope. Make the smallest coherent change and run the checks appropriate
to the affected behavior.

Hand off the exact commit or diff, changed files, validation commands and
results, and unresolved questions. Distinguish a source failure from setup
or infrastructure failure. Refresh commit-bound proof after a head change.

Use `Agent WS1` or `Agent WS2`. Authorship is the only quorum seat you can
claim for work you implemented:

```text
Agent WS1: authored at <full-head-sha>
```

Review and lifecycle verification remain separate handoffs. A passing
local command does not certify hosted CI, merge or runtime acceptance.
