# Local subscription acceptance

The private Node package `@wsa/subscription-acceptance` connects the reviewed
OpenAI account session, Responses adapter and evidence engine for one local
acceptance run. It uses a fresh dedicated store and a synthetic fixture. The
operator chooses the ChatGPT account in their preferred browser and a model from that
account's visible catalog. The runner makes at most one Responses request and
then signs out its own registration. It does not retry, dispatch a challenger or
fall back to API billing.

This is a local operator surface. Source delivery, hosted CI, independent quorum,
merge, postmerge governance and actual account acceptance are separate evidence.
The command does not deploy or wire the extract Worker, enable sensitive intake,
or establish primary-source corroboration for a promotable claim.

## Run from reviewed source

Use a clean checkout of the reviewed revision and its locked dependencies:

```sh
pnpm install --frozen-lockfile
pnpm openai:acceptance --help
pnpm openai:acceptance \
  --directory /absolute/private-parent/fresh-registration \
  --hosting local \
  --accept-uncapped-output
```

The private parent must already exist outside every Git worktree. Supply a new,
nonexistent child directory for this run. The existing account-store implementation
creates it with mode `0700` and protects credential files with mode `0600`.
Ancestors must satisfy the [account-store requirements](./openai-subscription-auth.md#storage-refresh-and-sign-out).
The runner uses this explicitly supplied store; it does not import an existing
Movement OS, Codex or browser credential store.

The command requires `--hosting local` and an explicit
`--accept-uncapped-output`. Subscription preview does not support an output-token
cap. The engine policy permits this one analysis lane; account authorization and
plan limits still apply. See the official [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The default `--browser system` uses the operating system's registered default
browser through `/usr/bin/xdg-open` on Linux or `/usr/bin/open` on macOS. It does
not select Chrome or change browser settings. In WSL, this is the Linux default;
it does not automatically choose a Windows browser.

If automatic opening is unsuitable, add `--browser manual`. The terminal displays
one validated fresh public PKCE sign-in link on stderr. Open it in your preferred
browser on this computer, including your Windows default browser when running the
command in WSL. Keep the terminal open while completing **Continue with ChatGPT**,
choosing the intended account and authorizing plan usage. The native `127.0.0.1`
callback must be reachable from that browser before the five-minute session
expires. WSL or VM reachability requires actual observation during the run.
Cancellation, terminal EOF and output failure stop the attempt; do not paste
callback codes or credentials into the terminal.

Manual display is restricted to a fresh registration: it rejects unknown or
duplicate query keys, token/login hints and altered authorization or callback
endpoints. The account-management CLI continues opening the system default
browser without printing links, because a saved-account authorization request
can contain private identity hints. Authorization links are excluded from the
acceptance JSON; retain operator stderr privately rather than attaching it to
issues or PRs.

The terminal lists the visible model slugs and asks for a numbered choice.
Alternatively, pass `--model exact-visible-slug`; the runner still fetches this
account's catalog and requires exact membership before inference. It does not
substitute another model. The selected registration remains pinned through
catalog discovery and credential resolution even if another process changes the
store's active-account selection.

The runner uses one fixed nonsensitive synthetic source and requests at most one
claim. A successful analysis requires actual validated Responses completion and
local extraction-schema validation. A quota or transport failure stops the run.
Native usage is reported when supplied; missing usage is not invented. Guardrail
outcomes remain distinct from analysis completion: this run provides neither a
second-provider challenge nor independent primary evidence.

## Source and artifact binding

`--help` and malformed arguments return before source checks, compilation,
browser authorization or storage effects. For a valid command, the bootstrap
derives the repository from its own script, requires clean Git state, records
the full revision and tree, and compares actual tracked file bytes against that
revision's Git blobs. This comparison detects changes hidden by `assume-unchanged`
or `skip-worktree` without changing those index flags. The installed pnpm lockfile
must match the tracked lockfile. It checks the installed TypeScript against the locked `5.6.3`
version and runs the local compiler with project build `--force` before importing
the compiled CLI.

The bootstrap rejects symlink or ignored source substitutions, production
workspace links to another checkout, and stale emitted files without a tracked
source counterpart. File checks and reads use one open handle with final-component
symlinks disabled, so a path replacement cannot redirect the checked read. It fingerprints the production workspace manifests, emitted
files and vendor lockfile, and records Node and TypeScript versions. After the
runner finishes, it rechecks tracked bytes, Git state and the artifact fingerprint before
printing a report. A concurrent source or output change invalidates that
version-bound result.

A failed final provenance check suppresses the JSON receipt. Sign-out cannot be
verified from an absent receipt; check the app in ChatGPT Settings and disconnect
it if needed rather than inferring that cleanup succeeded.

These hashes describe observed source and local artifacts. They are not signed
vendor receipts or a guarantee against a compromised current user or toolchain.
The frozen dependency install and independent source review remain part of the
acceptance handoff.

## Read the result

The final JSON records source/artifact identity, finite stage outcomes, requested
and observed response models, native response identity and usage, bounded
guardrail codes, and sign-out results. It excludes account labels, emails, private
store paths, authorization URLs, credentials, provider text and response bodies.
Retain the report with the exact command, date and observed browser behavior.

For response failures, `failure.diagnostics.validationFailure` identifies a finite
local rejection category, such as framing, event, completion, usage or schema
validation. Finite `httpStatus`, `bodyShape` and validated `providerCode` may also
be present. These categories identify the rejected boundary without accepting an
invalid response or proving the provider's underlying cause. Request IDs, raw
events, schema paths, provider text and response bodies remain excluded.

Exit `0` requires an accepted analysis, confirmed local credential clearing and
confirmed remote revocation. A finite bootstrap failure exits `1`; invalid usage
exits `2`. An analysis or sign-out failure produces its sanitized partial report
and exits `1`.

The runner signs out only its newly created registration after success or a
later failure. Local clearing and remote revocation are separate outcomes;
registration and host mappings remain available for future sign-in. If remote
revocation is unconfirmed, use ChatGPT Settings to disconnect the app and retain
that outcome as incomplete. Follow the official [account lifecycle guide](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Refresh is `completed` only when a real refresh exchange returns a valid
replacement and its rotation persists in the selected registration. `not_observed`
or `pending` supplies no live refresh proof. Fresh sign-in commonly completes the
single inference before expiry; the runner does not alter token timestamps,
force rotation or wait for expiry to turn that stage green. A later explicitly
scoped test is needed if real refresh was not observed.

An accepted local account run can inform a subsequent reviewed Worker
analysis/challenge integration. Deployed revision, production acceptance, quota
behavior and any future routing or fallback require their own evidence.
