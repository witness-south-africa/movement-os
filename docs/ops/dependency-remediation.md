# Dependency remediation — issue #40

The 2026-10-01 review started from main
`eb70fe1cb1d735ed29b8fc2b19113dfa8d83735d`. GitHub reported 88 open
Dependabot alert instances; a full pnpm registry audit reported 122 findings.
These are different inventories, not interchangeable counts. The failed
[updater run](https://github.com/witness-south-africa/movement-os/actions/runs/36878458987)
reported thirteen unresolved dependency updates and a separate SWC trust
downgrade during its attempted Nx update. That log did not establish an
individual cause for all thirteen constraints.

## Parent updates and remaining constraints

Nx and all four direct `@nx/*` plugins move together to `22.7.12`, with
`@swc/core@1.16.2` and `@swc-node/register@1.11.1` satisfying its published
peer ranges. Nx fixes include the
[self-hosted cache extraction advisory](https://github.com/nrwl/nx/security/advisories/GHSA-vp3h-ghgh-jr7g).
The default local cache is not affected by that particular advisory.
Nx's TypeScript sync removes redundant dependency references from six
solution configs; their library configs retain the actual build references.

Verdaccio moves to `6.10.4`, retiring the old Cypress request/UUID path.
ESLint `10.11.0` and its `@eslint/js@10.0.1` configuration package remove
the vulnerable older plugin-kit dependency and use the
[current supported major](https://eslint.org/version-support/). Nx and
typescript-eslint explicitly support ESLint 10. The workspace Node range
is `^22.13.0 || >=24.0.0`, matching the
[ESLint 10 runtime floor](https://eslint.org/docs/latest/use/migrate-to-10.0.0).

Both Worker packages pin Wrangler `4.116.0` and its compatible Workers types
`5.20260730.1`. This Wrangler version uses stable Miniflare 4 and already
includes fixed esbuild and WebSocket releases. Later Wrangler versions adopt
Miniflare 5 prereleases; this slice retains Miniflare 4 and patches its two
remaining exact dependency constraints. Worker compatibility dates and
production deployments are unchanged by these development-tool updates.

| Reported dependency        | Base parent path                                    | Selected fixed version(s)       |
| -------------------------- | --------------------------------------------------- | ------------------------------- |
| `@babel/core`              | Nx JS and Jest transform                            | `7.29.7`                        |
| `axios`                    | Nx                                                  | `1.20.0`                        |
| `baseline-browser-mapping` | Babel → browserslist                                | `2.11.25`                       |
| `brace-expansion`          | minimatch and Nx                                    | `1.1.21`, `2.1.7`, `5.0.12`     |
| `browserslist`             | Babel compilation targets/core-js                   | `4.29.1`                        |
| `esbuild`                  | Wrangler                                            | `0.28.1`                        |
| `fast-uri`                 | Ajv                                                 | `3.1.8`                         |
| `form-data`                | Nx/Axios and Verdaccio → Cypress request            | `4.0.6`                         |
| `js-yaml`                  | ESLint, Istanbul, Yarn parsers and Verdaccio config | `3.15.2`, `5.4.2` (4.x retired) |
| `qs`                       | Verdaccio → Express/body-parser/Cypress request     | `6.16.0`                        |
| `sharp`                    | Wrangler → Miniflare                                | `0.35.4`                        |
| `undici`                   | Wrangler → Miniflare                                | `7.29.1`                        |
| `ws`                       | Wrangler → Miniflare                                | `8.21.0`                        |

The lockfile refresh also repairs affected Babel SystemJS, minimatch,
picomatch, tmp, Ajv and body-parser paths. Parent-qualified overrides are
limited to dependencies that their selected parents still constrain:

- Nx `22.7.12`: Axios `1.20.0`, brace-expansion `5.0.12` and smol-toml
  `1.7.2` (the parent's `1.6.1` has a high-severity advisory).
- Miniflare `4.20260730.0`: sharp `0.35.4` and Undici `7.29.1`, within
  the existing 0.35 and 7 major lines.
- Verdaccio config `8.3.0`: js-yaml `5.4.2`, fixing the selected 5.x line.

The parent-specific Lodash `4.18.1` override from #33 remains present.
No advisory, severity or scanner rule is suppressed. All retained package
versions keep their existing integrity hashes.

## Two historical trust exceptions

Fresh resolution uses pnpm's seven-day delay, trust downgrade protection
and exotic-source restriction. SWC `1.5.29` fails trust review; its mature,
provenanced replacement passes. Two other unchanged base-lock versions need
explicit exceptions because the policy compares publication dates across
major versions. These exceptions apply only to the exact versions below.

| Package        | Publication and constraint                                                                                                             | Reviewed integrity                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `semver@6.3.1` | 2023-07-10; earlier stable 7.x releases have provenance, while the last 6.x release does not. Current Babel 7 still requires `^6.3.1`. | `sha512-BR7VvDCVHO+q2xBEWskxS6DJE1qRnb7DxzUrogb71CWoSficBxYsiAGd+Kl0mmq/MprG9yArRkyrQxTO6XjMzA==` |
| `pino@9.14.0`  | 2025-10-18; earlier releases have stronger publisher evidence, while Verdaccio's exact 9.x dependency does not.                        | `sha512-8OEwKp5juEvb/MjpIc4hjqfgCNysrS94RIOMXYvpYCdm/jglrKEiAYmiumbmGhCvs+IcInsphYDFwqrjr7398w==` |

Independent reviews downloaded each tarball, verified its SHA512 against
the registry and base lockfile, compared runtime files with its upstream
Git revision and found no installation lifecycle scripts. Current public
advisory/audit queries returned no findings for either exact version.
Semver `6.3.1` is also the patched 6.x release for
[CVE-2022-25883](https://github.com/advisories/GHSA-c2qf-rxjj-qqgw).

Preserving Pino `9.14.0` retains its trusted `@pinojs/redact@0.4.0`
dependency. Downgrading to provenanced Pino `9.13.1` and slow-redact `0.3.1`
would lose the subsequent fix for three consecutive wildcard segments in
redaction paths. Missing historical provenance alone does not establish
compromise; a downgrade must also preserve security behavior.

Remove each exception when a compatible parent/version can pass normal
trust checks. Any changed version or integrity requires a fresh review;
there is no package-wide exclusion or age-based trust bypass. Independent
real pnpm fixtures prove that the Semver exception permits only `6.3.1`
and still rejects `5.7.2`.

## Native scripts and validation

The exact script allowances cover SWC `1.16.2`, esbuild `0.28.1`, Nx
`22.7.12`, unrs-resolver `1.11.1`/`1.12.2` and workerd `1.20260730.1`.
The reviewed Parcel watcher `2.6.0` source-build script is explicitly denied;
Nx uses its locked prebuilt binding. Sharp `0.35.4` and oxc-resolver
`11.24.2` have no installation lifecycle scripts and need no allowance.

Compiler and runtime installers can attempt fallback downloads when an
optional native binary is missing. The installation proof must use the
locked native bindings. `scripts/verify-dependency-toolchain.mjs`, also run
in hosted CI, exercises native SWC and esbuild, a sharp image transform and
a local Miniflare/workerd HTTP response through Undici. Full workspace
lint, typecheck, tests and build remain required alongside the scanners.

## Dependabot's release-age exception

The observed security updater command includes
`--config.minimumReleaseAge=0`. Dependabot intentionally generates security
update candidates without the normal age delay; its
[cooldown reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)
also excludes security updates. Candidate generation does not approve a
lockfile for merge.

Accept this automated candidate-generation behavior, then independently
review publication date, provenance, advisories, parent compatibility and
native scripts before merge. Reproduce resolution with the repository's
normal seven-day policy. The versions selected in this slice satisfy it;
no release-age exception is configured. A future urgent fix younger than
seven days needs a separate exact-version/advisory/provenance decision.
Trust, exotic-source, script and quorum controls remain active.

Frozen installs preserve the reviewed lockfile and do not re-audit age or
trust. A green CI install alone therefore does not prove the updater route
is repaired. Post-merge acceptance must inspect the actual updater job and
its default-branch revision as well as main CI, scans and alert convergence.
