# @wsa/agent-openai

Two OpenAI adapters implement the existing `ModelProvider` contract:
`createOpenAiProvider()` retains the injected Chat Completions path;
`createOpenAiResponsesProvider()` consumes authenticated streaming Responses.
The Responses path requires an explicit model and access mode (`api` or
`subscription`), validates structured output and reports native usage and mode.
Both modes retain provider ID `openai` and count as one vendor for challenge gates.

## Responses transport

Inject `OpenAiResponsesClient`, or construct the optional
`createOpenAiResponsesFetchClient()` transport. It POSTs only to
`https://api.openai.com/v1/responses`, rejects redirects, streams SSE and performs
zero internal retries. No SDK, environment lookup or existing Codex credential
store is used. Both modes send `store:false` and `stream:true`; those fields do
not establish zero retention or data-handling terms.

Credentials resolve separately for each call, so the caller can supply refreshed
credentials for its selected account. API resolvers return an explicitly tagged
`OpenAiApiCredential`. Subscription resolvers return
`OpenAiSubscriptionCredential` with `planUsageAuthorized:true`. The tag/grant is
a trusted caller assertion, not token inspection or independent authentication.
The separate Node-only `@wsa/agent-openai/subscription-auth` entry provides official
registration and loopback sign-in, signed identity/grant verification, a protected
Unix store, serialized refresh, account selection, model catalog loading and
sign-out. See the [operator integration guide](../../docs/ops/openai-subscription-auth.md).
The terminal manager runs with `pnpm openai:accounts` after building this package;
see the guide for explicit private storage/host flags and account commands. It
uses the reviewed session/store and system browser, and performs no inference.
Custom callers supply their browser opener, account menu and model chooser. An
injected resolver or custom store remains a trusted integration boundary. Do not substitute
browser cookies or local Codex tokens for the official flow.

Subscription construction requires explicit `hosting:'local' | 'self-hosted'`.
This identifies the supported integration scope; it does not inspect the actual
host. OpenAI documents this flow for open-source/local applications; paid or
remotely hosted applications need a separate integration arrangement. The extract
Worker is not wired to this transport. [Official eligibility and host documentation](https://developers.openai.com/siwc/token-sharing-open-source).

For example, with an operator-owned verified credential resolver:

```ts
import {
  createOpenAiResponsesFetchClient,
  createOpenAiResponsesProvider,
  type OpenAiSubscriptionCredential,
} from '@wsa/agent-openai';

declare const selectedModel: string;
declare const resolveVerifiedCredential: () => Promise<OpenAiSubscriptionCredential>;

const provider = createOpenAiResponsesProvider({
  model: selectedModel,
  client: createOpenAiResponsesFetchClient({
    accessMode: 'subscription',
    hosting: 'local',
    resolveAccessToken: resolveVerifiedCredential,
  }),
});
```

For API mode use `accessMode:'api'` and `resolveApiKey`, returning
`{accessMode:'api', apiKey:<the selected key>}`. A successful Responses result
contains `accessMode`; the shared field is optional for existing adapters.

## Request and completion boundaries

System messages become ordered developer messages. User/assistant messages retain
their order. Tools, arbitrary tracing metadata and unsupported conversation/schema
shapes reject before dispatch. Structured output uses a closed object root with
required JSON properties; unsupported optional/effect/coercion/open/recursive
schemas reject. The original Zod schema validates the returned JSON locally.

API mode forwards a supplied positive safe-integer `maxOutputTokens` as
`max_output_tokens`. Subscription mode rejects **any supplied output cap before
credential resolution or network** because the official preview does not accept
that field. It never silently drops the hard ceiling. Both evidence-engine lanes
always supply caps, so their current calls require API mode. Uncapped subscription
calls are for deliberately configured callers that accept that limitation.
[Official preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Only a validated native `response.completed` snapshot, followed by clean stream
completion, returns output. Partial deltas, failure/incomplete events, tool/refusal
output, missing completion, malformed/truncated streams and invalid JSON/schema
results fail closed. Native reasoning items may accompany one completed assistant
text message. Required native usage counters and metadata are validated; no USD
cost or missing usage is invented. [Official inference lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Timeout aborts and rejects locally even for non-cooperative injected transports;
late completion cannot certify output. The built-in fetch transport cancels its
reader on abort or early exit. The provider defaults to a 30-second timeout;
`defaultTimeoutMs` and per-call `timeoutMs` must fit the positive timer range.
Default SSE bounds are 1 MiB per event and 8 MiB
per stream, configurable up to 32 MiB. These protect local resources and are not
provider token or monetary spend ceilings. Actual upstream cancellation depends
on the transport and server.

The provider independently limits serialized event payloads to 1 MiB per event,
4 MiB across a call and 10,000 events. Increasing fetch bounds does not increase
these provider acceptance limits. Reader ownership begins at transport creation,
so abort or iterator return also cancels a body before the first event is read.

## Quota and billing

`OpenAiResponsesError.code` is a finite sanitized category. Exact structured
`subscription_sharing_usage_limit_exceeded` becomes `quota_exhausted`;
`subscription_sharing_usage_unavailable` becomes `subscription_unavailable`.
Generic HTTP429 remains `rate_limited`, not evidence that a subscription is empty.
HTTP bodies/provider messages/credential errors are not retained in exceptions.
HTTP401 is `authentication_failed`; generic403 is `permission_denied` and the
documented eligibility403 is `subscription_ineligible`. Optional diagnostics keep
only HTTP status, body-shape category, an allowlisted subscription error code and
a validated bounded request ID. Sanitization rebuilds even injected typed errors
and drops untrusted message/cause/diagnostic data.
The operator should pause new plan requests on exhaustion and retry temporary
unavailability later with bounded backoff. No reset time is inferred.
[Official recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

There is **no automatic API fallback**. API billing and subscription quotas must
remain explicit. API fallback is deferred: it requires reviewed pre-dispatch spend
reservation, a configured monetary limit, a finite API output cap, bounded attempts
and recorded outcomes for both calls. Merely injecting an API client or aborting
after a local byte limit does not guarantee a spending ceiling. This source slice
performs no paid probe, deployment or credential migration.

## Validation

```sh
pnpm nx run @wsa/agent-openai:test -- --runInBand
pnpm nx run @wsa/agent-openai:lint -- --max-warnings=0
pnpm nx run @wsa/agent-openai:typecheck
pnpm nx run @wsa/agent-openai:build
```
