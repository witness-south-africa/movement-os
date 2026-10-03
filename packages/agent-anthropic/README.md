# Anthropic adapter

`@wsa/agent-anthropic` implements the existing `ModelProvider` contract using
an injected, non-streaming native Anthropic `client.messages.create` transport.
It imports no SDK, reads no credentials or environment, constructs no network
client, selects no default model and makes no call during construction. The
caller supplies a reviewed transport and an explicit model that supports
[native structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

```ts
import {
  createAnthropicProvider,
  type AnthropicClient,
} from '@wsa/agent-anthropic';

function makeProvider(client: AnthropicClient, model: string) {
  return createAnthropicProvider({
    client,
    model,
    defaultMaxOutputTokens: 4096,
  });
}
```

The frozen provider identifies itself as `anthropic`. Every request requires
`output_config.format.type = "json_schema"` and `max_tokens`. A caller's
`maxOutputTokens` is forwarded exactly; omission uses the positive safe-integer
`defaultMaxOutputTokens` configured at construction, which defaults to 4096.
This is an output ceiling, not a price estimate, spend reservation or model
capacity guarantee. Sampling, retries, fallback and tool execution belong above
this adapter; non-empty tool declarations are rejected before dispatch.

Leading system messages become separate top-level `system` text blocks with
their original instructions preserved. User and assistant messages retain their
order and contents. A conversation must start and finish with a user message;
interior system messages and assistant prefill are rejected because this narrow
format does not represent them safely for structured output. The optional
`requestId` remains caller-side tracing data and is not copied to Anthropic's
`metadata.user_id` or another native request field. Native field shapes follow
the [Messages API](https://platform.claude.com/docs/en/api/messages/create).

`zodToAnthropicJsonSchema` supports JSON primitives, scalar literals/enums,
closed objects (including ordinary Zod objects whose unknown keys strip),
arrays, optional object properties, nullable values, brands and basic or
discriminated unions. It inlines schemas and preserves required fields and
closed object properties. Unsupported numeric bounds, string lengths/patterns,
unsupported formats and array bounds beyond supported `minItems` values 0/1
move into descriptions, following the native API's schema transformation
approach. The original Zod schema validates every returned value, including
these bounds and exact enum casing. Schema text is sent to the provider too;
callers must keep property names, descriptions, enums and patterns free of
sensitive values.

Unsupported shapes fail before a call: recursive/lazy schemas, open records,
passthrough/catchall objects, tuples, intersections, arbitrary/unknown values,
non-JSON types, coercion, refinements/transforms, defaults/catches, readonly
wrappers and pipelines. Optional values are supported only as object
properties. Vendor schema-complexity and model availability limits still apply;
this adapter does not certify acceptance by a live model.

A response must contain exactly one non-empty native text block, valid JSON
and a value satisfying the original schema. Missing, multiple or non-text
blocks, tool-only responses and malformed metadata fail. Only native
`end_turn` reports `completed`; every other stop reason reports `incomplete`,
including unknown future strings. A null stop reason is recorded as `unknown`
and remains incomplete. Model, message ID and stop reason have finite bounds
and reject control characters or blank values. Adapter-generated errors and
transport failures omit raw output, validation issue values and transport
details.

Native token counters must be nonnegative safe integers, including optional
cache creation/read counters; null/absent cache counters contribute zero. Input
usage sums `input_tokens`, `cache_creation_input_tokens` and
`cache_read_input_tokens`; total adds `output_tokens` and rejects integer
overflow. `cachedInputTokens` records cache reads only (zero when no read is
reported). Missing native usage fails instead of reporting an unobserved paid
call as zero. No money amount is inferred from these counters.

The adapter always supplies an `AbortSignal`. A positive `timeoutMs` within
the JavaScript timer range aborts that signal and rejects locally, even if a
transport ignores cancellation or returns valid output later. Timers clear
after success or failure. The injected transport owns actual network
cancellation, SDK retries and connection handling; configure those deliberately
because this adapter does not override a client's internal behavior.

This package supplies source integration only. Operators deliberately construct
and register it in the shared router for analysis or challenge. Sensitive intake
remains disabled in version-1 routing. The package does not classify/redact
inputs, establish vendor contracts or residency, verify independent evidence,
change Worker wiring, deploy a service or certify paid-provider acceptance.

Run `pnpm exec nx test @wsa/agent-anthropic`, `pnpm exec nx typecheck
@wsa/agent-anthropic`, `pnpm exec nx lint @wsa/agent-anthropic` and `pnpm exec nx
build @wsa/agent-anthropic` for deterministic local checks. Unit tests use
injected clients and perform no live vendor I/O.
