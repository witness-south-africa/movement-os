# OpenAI subscription accounts for local operators

`@wsa/agent-openai/subscription-auth` ships a Node-only public-client account
integration for deliberately configured local or self-hosted OSS callers. It
provides browser authorization, verified account registrations, a protected Unix
file store, rotating refresh, account selection, account-specific model listings
and sign-out. The root adapter entry remains separate from Node filesystem and
callback-server code. The package also includes a terminal account manager using
this same session and store. Live browser login, account eligibility and production
account acceptance remain unverified.

Follow the official [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [account lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
guides. This is the public-client flow: it does not need a client secret or partner
API key. Hosted/commercial arrangements and VM credential transfer require their
own reviewed integration. The system browser and loopback callback must run on the
same host; a browser on an operator's laptop cannot reach a VM's `127.0.0.1`.

## Run the terminal account manager

Build the Node package once, then run the manager from the repository root with
an explicit private absolute directory and host mode:

```sh
pnpm nx run @wsa/agent-openai:build
pnpm openai:accounts manage --directory /absolute/private-parent/movement-accounts --hosting local
```

The directory's parent must already exist; the store creates its own private
child directory. Existing directory and ancestor permissions must meet the
storage requirements below. Use a directory outside every Git worktree. This CLI
supports the Unix store on Linux/macOS and fixed system launchers
(`/usr/bin/xdg-open` or `/usr/bin/open`). Browser login requires a functioning
same-host graphical browser and loopback callback. WSL and VM browser reachability
need their own live acceptance. There is no browser-command override or URL
copy/paste fallback because returning authorization URLs can contain an ID token.

The menu shows saved registrations, their full keys, the active registration,
session state and plan authorization separately. Choose **Continue with ChatGPT**
to create a registration, sign in again to a specific saved registration, request
plan consent explicitly, select an account, fetch visible models or sign out.
Plan consent and sign-out require a separate yes in the menu. Opening the menu
only reads saved metadata. It does not automatically sign in or fetch a catalog.

For individual commands use the same `--directory` and `--hosting` flags:

| Command                                            | Action                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `accounts`                                         | List saved registration metadata.                              |
| `sign-in`                                          | Continue with ChatGPT for a new registration.                  |
| `sign-in --account <full-key>`                     | Sign in again to that saved registration.                      |
| `sign-in --account <full-key> --enable-plan-usage` | Explicitly request plan consent for that registration.         |
| `select --account <full-key>`                      | Select a saved registration without browser authorization.     |
| `models`                                           | Fetch visible models for the active account at request time.   |
| `sign-out --account <full-key>`                    | Clear that local session and attempt remote revocation.        |
| `--help`                                           | Display usage without constructing a store, prompt or browser. |

Use the complete 64-character registration key shown by `accounts`; prefixes and
email selectors are rejected. Single commands work without a terminal; `manage`
requires terminal input and output. Unknown, duplicate and incompatible options
fail before storage is opened. Metadata controls, bidirectional formatting and
line separators are escaped, and display strings are bounded. Errors report a
finite category rather than raw arguments, paths, URLs or provider diagnostics.

Each catalog request resolves the active account in the serialized session at
request time. Another process may change selection after a menu snapshot, so the
catalog does not claim to belong to an earlier displayed account. Run `models`
again after selecting an account. This manager does not select or persist a model,
perform inference, export tokens, or fall back to API billing. The built package
also declares the `movement-openai-accounts` executable; the repository command
above invokes the same compiled entry directly.

EOF closes the menu; SIGINT/SIGTERM request cancellation and wait for owned
resources and the source transaction before exit. Sign-in/model requests receive
an abort signal. Saved-account listing and selection may still await the bounded
store lock because their source APIs expose no cancellation signal. Sign-out
awaits local clearing even if remote revocation is cancelled, and says when remote
revocation was not confirmed. The CLI has no inference activity to stop; other
callers must cancel their own requests. Normal exit codes are 0, 1 for a failed
operation, 2 for invalid usage, 130 for SIGINT and 143 for SIGTERM. Forced process
termination can still leave a lock requiring the owner-proven recovery below.

## Construct an operator session

Use an explicit app-owned directory outside any Git worktree, whose parent already
exists. Do not point it at a Codex credential directory or import browser cookies.
The store never looks up environment credentials or migrates another tool's tokens.

```ts
import {
  createOpenAiSubscriptionFileStore,
  createOpenAiSubscriptionSession,
} from '@wsa/agent-openai/subscription-auth';
import {
  createOpenAiResponsesFetchClient,
  createOpenAiResponsesProvider,
} from '@wsa/agent-openai';

declare const privateCredentialDirectory: string;
declare const openSystemBrowser: (url: string) => Promise<void>;
declare const chooseModel: (
  choices: readonly { slug: string; displayName: string }[],
) => Promise<string>;

const session = createOpenAiSubscriptionSession({
  hosting: 'local',
  store: createOpenAiSubscriptionFileStore({
    directory: privateCredentialDirectory,
  }),
});

// Show "Continue with ChatGPT" in the operator surface. Never log this URL:
// returning sign-in may include a retained ID-token hint.
await session.signIn({ openAuthorizationUrl: openSystemBrowser });
const choices = await session.listModels();
const selectedModel = await chooseModel(choices);
const provider = createOpenAiResponsesProvider({
  model: selectedModel,
  client: createOpenAiResponsesFetchClient({
    accessMode: 'subscription',
    hosting: 'local',
    resolveAccessToken: () => session.resolveAccessToken(),
  }),
});
```

Custom callers implement their own account menu, browser opener and model chooser. Display stable account
labels and the active account from `listAccounts()`, and keep different
registrations separate even when their emails match. `selectAccount(key)` selects
a saved registration; use `signIn({accountKey:key, openAuthorizationUrl})` to
reauthorize it. Reload the model choices whenever selection changes. Do not retain
a previous account's model choice or access-token snapshot as an authorization
decision. The resolver reads the active registration on each call.

The example constructs a provider; it makes no inference request. Subscription
preview rejects output caps. Both evidence-engine lanes currently require caps and
therefore remain on API mode. This account module does not remove those ceilings,
wire the extract Worker, enable sensitive intake or provide API billing fallback.

## Authorization and identity

Each attempt starts an ephemeral HTTP listener on `127.0.0.1`, with fixed path
`/auth/callback`, before opening the browser. It uses fresh state, nonce and S256
PKCE; the same callback URI goes into authorization and code exchange. The stable
host UUID persists before first authorization. Initial registration uses
`dynamic_agent_client` with app name `Movement OS`; later authorization reuses
the issued client and same host, with hints belonging only to the selected account.

The callback validates state before accepting errors or a code. Callback scopes
are not grants. Signed ID tokens must verify against the fixed official JWKS and
validated discovery metadata, with issuer, issued-client audience, expiry, issued
time, subject and sign-in nonce checked. Returning identity must match the saved
issuer, client and subject before any credentials are replaced or made active.
Email is a display hint, not a workspace or registration identifier.
An expired retained ID-token hint is not an authentication proof, and its expiry
does not by itself prevent refreshing a valid renewable session. If refresh omits
a replacement ID token, the protected verified account mapping and retained hint
remain; any replacement ID token must verify the same account binding.

The token response's scopes determine plan authorization. A verified identity
without `chatgpt.tokens.use.direct` can remain saved, but models and access-token
resolution fail with `plan_not_authorized`. If the operator explicitly enables
plan usage later, call `signIn({accountKey:key, enablePlanUsage:true,
openAuthorizationUrl})` to request consent. Ordinary reauthorization does not force
consent. An issued but unverified client from an interrupted initial exchange is
retained only as pending registration metadata; it cannot authorize requests or
become an active account.

## Storage, refresh and sign-out

The supplied file store is Unix-only. Directories must be owned by the current uid
with mode `0700`; credential and lock files require `0600`, one link and regular
file type. Symlink components are rejected. Ancestors must be owned by root or the
current uid and cannot be writable by others unless sticky, as with `/tmp`.
Existing insecure paths fail without permission repair. These permissions protect
against other local users; they do not protect a compromised current uid or root.
Keep the credential directory out of backups, analytics and support transcripts.

One exclusive global lock serializes account transactions, bounded interactive
sign-in and refresh across processes. Other account requests wait for that lock;
the default wait ceiling is 30 seconds (`lockTimeoutMs`, maximum five minutes).
Cancellation stops lock acquisition for sign-in, resolution and model listing.
Sign-out still waits for the bounded lock and clears local tokens when cancelled;
its signal cancels only the remote revocation attempt. The store writes replacements atomically and
fsyncs the file and directory. A completed validated rotation persists before a
later model-listing error is returned. Throwing a transaction rolls back mutations.
Custom `SubscriptionStore` implementations must uphold the same protection,
serialization and atomicity contract; an in-memory store does not provide restart
or cross-process protection.

Locks are never stolen. If a process exits while holding one, prove the owner has
exited before an operator removes `session.lock`; preserve `accounts.json`. The
module does not perform that recovery automatically. The file store bounds state
to 1 MiB and 32 registrations, with individually bounded tokens and metadata.

Access-token expiry uses the received `expires_in`; refresh happens at expiry and
replaces access, refresh, scopes and expiry together. The adapter does not invent a
refresh-token lifetime or infer workspace identity from opaque authentication
metadata. The official [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
names `earliest_refresh_at` without defining its type or units. This implementation
accepts an optional safe-integer Unix-seconds value only within the received
token's lifetime; other present forms fail closed. This is a compatibility
constraint requiring live confirmation, not a claim about an undocumented schema.

Terminal refresh rejection clears only the affected tokens and requires new OAuth
with the retained registration. A received HTTP `200` replacement that cannot be
validated also clears that session's tokens; a later call cannot reuse its possibly
consumed refresh token. Temporary network/server failures before a successful
reply preserve the saved record.
There are no internal retries or paid fallbacks. The complete-operation timeout
defaults to five minutes (`timeoutMs`, maximum ten minutes); callers may cancel.
For sign-out, that timeout bounds remote revocation after the separately bounded
lock wait. The caller must also stop or cancel its own outstanding inference
requests; clearing a saved account does not cancel an already dispatched request.
HTTP body bounds and finite error codes keep raw provider messages, credentials,
paths and authorization URLs out of exceptions.

`signOut({accountKey:key})` attempts refresh-token revocation using official
discovery, then clears that registration's local access, refresh and ID tokens,
retaining its identity, issued client and host for future sign-in. Its
`remoteRevocationConfirmed` result must be shown honestly. If false, explain that
remote revocation was not confirmed and link the operator to ChatGPT Settings to
disconnect the app. Account switching does not sign out other registrations.

Models come from `https://api.openai.com/v1/models` using the active account's
verified plan credential. Only `visibility:'list'` choices are returned, in provider
order, with slug and display name. The caller deliberately chooses a slug; this
module does not choose or substitute a model.
[Official models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

## Acceptance boundary

Offline fixtures exercise signed identity verification, loopback callbacks,
permissions, persistence, concurrent rotation and safe failure handling. Source
and CI acceptance do not demonstrate a real account's eligibility, successful
authorization, model availability, plan limits or deployed runtime adoption.
Those require an explicitly authorized operator acceptance run without logging
tokens. Review quota/billing and any future fallback separately from sign-in.
