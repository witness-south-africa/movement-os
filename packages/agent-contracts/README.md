# @wsa/agent-contracts

Provider-agnostic contracts for LLM access. Defines the `ModelProvider`
interface every adapter (`@wsa/agent-openai`, `@wsa/agent-xai`,
`@wsa/agent-anthropic`, ...) must
satisfy, plus the Zod schemas that keep requests and responses honest.

## What it contains

- `ModelProvider` — the single-function interface adapters implement.
- `CompleteArgs<TSchema>` — narrow, schema-first call arguments.
- `ModelResponse<T>` — normalized provider response including
  `status`, `usage`, `model`, `responseId`, and `rawFinishReason`, plus optional
  explicit `accessMode` (`api` or `subscription`) when an adapter reports it.
- `LlmProviderIdSchema` — identifier enum (`openai`, `xai`, `anthropic`,
  with `local` reserved for an outstanding repository adapter).
- `AgentTaskKindSchema` — the three ADR-0003 routing lanes
  (`sensitive-intake`, `analysis`, `challenge`).
- `AgentMessageSchema` — narrow conversation message (role + content).
- `ToolSpec` + `defineTool` — provider-agnostic tool definition backed
  by a Zod schema.
- `TokenUsageSchema` — input/output/total token counts, with optional
  cache-hit and provider-cost fields (`cachedInputTokens`,
  `costInUsdTicks`) when the adapter can report them honestly.
- `createFakeProvider` — in-memory fake for deterministic tests.
- `ProviderRoutingConfigSchema` + `createProviderRouter` — strict versioned
  lane selection from real injected adapters, with no automatic calls or fallback.

## What it deliberately omits

Retry policy, circuit breaking, temperature and top-p knobs, streaming,
background mode. Those belong above the adapter layer, and forcing them
into the core contract early would overfit to one provider's shape.

## Usage

```ts
import { z } from 'zod';
import { createFakeProvider, type ModelProvider } from '@wsa/agent-contracts';

const ExtractionSchema = z.object({
  claims: z.array(z.string()).min(1),
});

const provider: ModelProvider = createFakeProvider({
  produce: (schema) => schema.parse({ claims: ['a', 'b'] }),
});

const response = await provider.complete({
  schema: ExtractionSchema,
  messages: [{ role: 'user', content: 'extract claims' }],
  taskKind: 'analysis',
  maxOutputTokens: 1_000,
});

// response.value is typed as { claims: string[] }.
```

## Explicit provider routing

[`config/provider-routing.example.json`](../../config/provider-routing.example.json)
is a secret-free example, not an automatically loaded production default:

```json
{
  "version": 1,
  "lanes": {
    "sensitive-intake": null,
    "analysis": "xai",
    "challenge": "openai"
  }
}
```

Load your deployment's JSON configuration, construct its adapters separately,
then pass both to the router:

```ts
const router = createProviderRouter({
  config: routingConfig,
  providers: { xai: xaiProvider, openai: openaiProvider },
});
const analysisProvider = router.resolve('analysis');
const challengeProvider = router.resolve('challenge');
```

Version 1 requires every lane explicitly, forbids unknown config fields and
requires distinct analysis/challenge IDs. Sensitive intake must be `null`;
resolving it throws without fallback, even if a local adapter is injected.
Enabling that lane needs its own policy and implementation slice. A provider
ID does not prove an installed adapter: both configured adapters must be own
registry entries, with matching IDs and callable `complete`, before the router
is returned. The shipped Anthropic adapter can be deliberately supplied through
the same registry. The reserved local ID can select an externally supplied
adapter; its repository implementation remains outstanding.

The router snapshots and freezes parsed config and preserves selected adapter
instances. Changing the caller's config or registry does not reroute an existing
router; construct a new one to apply changes. Each resolution rechecks adapter
identity and callability. It returns the real provider rather than a composite
provider with a misleading identity. It does not call providers, read files or
environment variables, construct adapters, choose models or fall back after
failure. Callers must resolve all needed lanes before dispatch and preserve
their task IDs; the [routed evidence factory](../evidence-engine/README.md#configured-provider-routing)
does this before every extraction.

Routing does not classify material, verify data-handling terms or residency,
reserve spend or authenticate vendor/source evidence. Deployment policy,
adapter credentials/models/budgets, call outcomes and audit persistence remain
the caller's responsibility. The extract Worker does not load this example.

## Building and testing

```sh
pnpm nx run @wsa/agent-contracts:build
pnpm nx run @wsa/agent-contracts:test
pnpm nx run @wsa/agent-contracts:lint --max-warnings=0
```
