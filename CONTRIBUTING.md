# Contributing

Thank you for considering a contribution to `movement-os`. This project
powers the Witness South Africa (WSA) civic accountability platform.
The bar is deliberately high because the software sits in a sensitive
space: witness safety, public trust, and the movement's credibility
all depend on the quality of what lands on `main`.

## Before you start

Please read:

1. [`README.md`](./README.md)
2. [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
3. [`ACCEPTABLE_USE.md`](./ACCEPTABLE_USE.md)
4. [`SECURITY.md`](./SECURITY.md) — especially if you are reporting a
   vulnerability; do not open a public issue for that.
5. [`POPIA.md`](./POPIA.md)
6. The most recent ADR in `docs/architecture/`.

## What we welcome

- Bug fixes with reproductions.
- Tests — especially deterministic ones that close a gap.
- Documentation improvements, especially to operator runbooks.
- New agent adapters behind `@wsa/agent-contracts`.
- Translations of public-facing materials, by native speakers, with
  reviewer credit.

## What we politely decline

- Large refactors without a prior issue and an explicit design note.
- Dependencies under source-available, fair-code, or non-OSI licences.
  The core is Apache-2.0 and stays that way.
- Changes that weaken or bypass the human-approval gate.
- Changes that weaken the `@wsa/principles` hash verification.
- New mass-publishing features without a corresponding audit-log entry.

## Development workflow

Requires Node 22.13+ in the 22.x line or Node 24+, and the pinned pnpm
10.34.6 via Corepack.
See [dependency policy](docs/ops/security-scans.md#dependency-policy) for install controls.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm nx run-many -t test
pnpm nx run-many -t build
pnpm nx run-many -t lint
pnpm nx run-many -t typecheck
```

Editing a package:

```sh
pnpm nx run @wsa/<project>:test --runInBand
```

Syncing TypeScript project references (run this if cross-package imports
feel off):

```sh
pnpm nx sync
```

## Commit messages

We use **Conventional Commits**:

```
type(scope): imperative subject, no trailing period
```

Types we use: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `build`,
`ci`, `perf`.

Examples:

```
feat(guardrails): add martyr-framing warning rule
fix(schemas): tighten evidence url validation
docs(adr): 0002 queue layer choice
```

Keep commits small and focused. If the diff touches two unrelated
concerns, split it.

## Pull request expectations

Every PR must include a short **Design Note** covering:

- **Problem.** What is broken or missing.
- **Approach.** The shape of the fix and why you picked it.
- **Tests.** What is now covered.
- **Rollback.** How a reviewer can revert cleanly if this proves wrong.

Plus:

- Reproduction commands.
- An explicit statement of any public-API change.
- Screenshots or audit-log excerpts if behaviour changed.

Small, focused PRs merge faster than mega-PRs.

## Style

- TypeScript strict, no `any`, no non-null assertions unless justified
  in a code comment.
- ESM / NodeNext module style; no `require`.
- Prefer explicit types on exported interfaces; inference inside
  function bodies.
- AAA-style Jest tests. One assertion per behaviour where possible.
- Deterministic tests — no network, no real time, no flakes. If a test
  needs time or randomness, inject a clock / RNG.

## Security-sensitive changes

Anything that touches intake, the approval gate, the audit log, the
principles hash, or the agent tool layer requires at least one review
from a Cause Council member (to be formalised) in addition to a code
reviewer.

## Licence and DCO

By contributing, you agree that your contributions are licensed under
Apache-2.0 (see `LICENSE`) and that you have the right to submit them.

Thank you — and endurance over outrage.
