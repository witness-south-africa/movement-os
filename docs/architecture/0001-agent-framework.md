# ADR-0001: Agent framework choice

- **Status:** Accepted (revised 2026-10-03 — see Revision history)
- **Date:** 2026-04-18; revised 2026-04-20 and 2026-10-03
- **Deciders:** Rudi (founder); pending Cause Council ratification.
- **Supersedes:** —
- **Superseded by:** —

## Revision history

- **2026-10-03 (issue #24 — Anthropic source adapter).**
  `@wsa/agent-anthropic` implements the same contract over the native
  Messages API using injected transport. It requests structured JSON,
  normalizes unsupported wire-schema constraints and validates responses
  against the caller's original Zod schema. This adds a source adapter;
  Worker adoption, local inference and live provider acceptance remain pending.
- **2026-04-20 (issue #24 — reality alignment).** The original ADR named
  the OpenAI Agents SDK for TypeScript as the default adapter, but the
  shipped adapters (`@wsa/agent-openai`, `@wsa/agent-xai`) are thin
  direct-REST wrappers over each provider's OpenAI-compatible chat
  completions endpoint, with **no `@openai/agents` or `openai` SDK
  dependency**. Options, Decision, Consequences, Validation, and
  References have been rewritten to describe the shipped approach. The
  OpenAI Agents SDK is retained as a considered option, not adopted. The
  abstraction boundary (`@wsa/agent-contracts`) is unchanged, so this is
  recorded as a revision rather than a supersession.

## Context

Witness South Africa (WSA) is building an open-source civic accountability
platform in which AI agents act as staff for the five pillars of the
movement: Cause Council, Evidence Unit, Media Engine, Community Network,
Action Wing. The platform must:

1. Be **cleanly open source** under the OSI definition. No source-available,
   fair-code, or custom-licence dependencies in the core.
2. Be **provider-agnostic** at the LLM layer. The movement's credibility
   cannot depend on any single vendor remaining available, affordable, or
   aligned with our mission.
3. Keep a **human-in-the-loop** for every outbound artefact. No agent
   publishes autonomously.
4. Produce a **signed, append-only audit log** of every agent action.
5. Remain **small enough for a few volunteers to maintain** — not a platform
   team.
6. Run cleanly on **Node 22, TypeScript strict, Nx 21+, pnpm** per the
   project-wide conventions.

## Options considered

### Option A: Thin `ModelProvider` contract with direct adapters (shipped)

- Define a one-function `ModelProvider` contract in `@wsa/agent-contracts`:
  `complete(args) → schema-validated ModelResponse`
  (`packages/agent-contracts/src/lib/model-provider.ts`).
- Each adapter implements the contract directly against its provider's
  REST endpoint — Chat Completions for `@wsa/agent-openai`, xAI's
  OpenAI-compatible endpoint for `@wsa/agent-xai`, native Messages for
  `@wsa/agent-anthropic`.
- Transport is injected as a narrow client interface
  the adapter owns; the packages carry **no runtime dependency on
  `openai`, `@openai/agents`, or any vendor SDK**. Consumers pass in
  whatever satisfies the narrow shape — the real vendor SDK client, a
  fake for tests, a WebCrypto-friendly `fetch` wrapper on Workers.
- Structured output is mandatory. The caller's Zod schema is converted to
  the provider's JSON Schema format: `response_format` for OpenAI/xAI,
  `output_config.format` for Anthropic. The Anthropic adapter normalizes
  documented unsupported constraints for the wire while retaining the
  original Zod checks locally. Every adapter JSON-parses and re-validates
  responses. Unsupported Anthropic schema shapes fail before dispatch.
- **Trade-off.** We do not get the OpenAI Agents SDK's built-in handoffs,
  guardrails, or tracing. The current runtime surface (evidence-engine
  extraction and `extract-api-worker`) does not need them. When/if we do,
  we add a second adapter behind the same contract rather than restructure.

### Option B: OpenAI Agents SDK for TypeScript (considered, not adopted)

- Licence: **MIT** (`openai/openai-agents-js`).
- Provider-agnostic by design; Anthropic, local (Ollama/vLLM), and other
  OpenAI-API-compatible backends plug in behind a common interface.
- First-class support for tool use, handoffs, guardrails, tracing, and
  human-in-the-loop.
- **Why not adopted today.** The features the Agents SDK ships for free
  are the features we do not yet exercise. Taking the dependency now
  means shipping an SDK whose value is in surface we don't use. Option A
  is a strict subset that can be extended to an Agents-SDK-backed adapter
  later without breaking the `@wsa/agent-contracts` boundary.

### Option C: LangGraph (JS/TS)

- Licence: **MIT** (`langchain-ai/langgraph`).
- Strong on durable execution and graph-shaped workflows.
- Larger footprint; pulls in much of the LangChain ecosystem by gravity.
- Better fit if/when we need explicit graph checkpointing; today we do not.

### Option D: Claude Agent SDK (TypeScript)

- Licence: MIT, but vendor-owned and vendor-shaped.
- Excellent quality; tight coupling to Anthropic tooling.
- Conflicts with the provider-agnostic requirement unless wrapped —
  and wrapping it is the same effort as any other adapter behind
  `@wsa/agent-contracts`.

### Option E: n8n or similar self-hosted automation platform

- **Rejected.** n8n is distributed under the Sustainable Use Licence
  plus an Enterprise Licence; it is source-available, not OSI open source.
  Using it in the core would contradict our "cleanly open source" goal.

## Decision

Adopt **Option A**: a thin `ModelProvider` contract in
`@wsa/agent-contracts` with direct-REST adapters. Shipped adapters are
`@wsa/agent-openai`, `@wsa/agent-xai` and `@wsa/agent-anthropic`.
A local-inference adapter remains reserved in the provider-id union
(`packages/agent-contracts/src/lib/provider-id.ts`) for a later PR per
ADR-0003's provider matrix. No local adapter is present on disk.

The contract is the abstraction boundary. Swapping to an
OpenAI-Agents-SDK-backed, LangGraph-backed, or fully self-hosted
inference adapter is a per-adapter change, not a platform rewrite.

## Consequences

### Positive

- Permissive MIT licence across Node, TypeScript, Zod, and our own code.
  No vendor-SDK dependency in any adapter package today — consumers wire
  whatever client they already have.
- The abstraction is small: one interface, one function. Adapters are
  contained; their test suites live alongside them.
- Retries, circuit breaking, caching, audit logging, and human-in-the-loop
  layer **above** the interface — they are not entangled with provider
  shape.
- Contributors from adjacent communities (journalists, NGOs, other
  movements) can fork and reuse without licence friction.

### Negative

- We carry the cost of rewriting features the OpenAI Agents SDK ships for
  free (handoffs, guardrails, tracing) if we ever need them. Accepted:
  today we don't, and Option A is a strict subset of an Agents-SDK-shaped
  future adapter.
- Default inference goes through hosted model APIs, so operators must
  fund model calls in ZAR. Mitigated by (a) per-agent monthly budgets,
  (b) a planned local-inference adapter for on-prem operation (not yet
  shipped — see ADR-0003), (c) cache-aware tracing to avoid redundant
  calls. PR-11 reifies this in `@wsa/agent-xai`: every live xAI call can
  now emit append-only telemetry (`model`, token counts, cached tokens,
  `costInUsdTicks`, request id, outcome), enforce a hard preflight cap on
  recorded month-to-date spend, and raise a soft-threshold alert when
  projected spend crosses the configured warning line.

### Neutral

- We do not adopt LangGraph or the OpenAI Agents SDK today but leave the
  door open: a second adapter can be added when (not if) we need their
  features.

## Rollback

Reverting the **decision** here means abandoning the
`@wsa/agent-contracts` boundary and binding the platform directly to a
vendor SDK — we would not do this. Replacing an **adapter** is in-scope
and low-blast-radius: add or remove a sibling package under
`packages/agent-*`; no agent definitions, tools, or schemas change,
because they depend only on the contract.

## Validation

- Each adapter ships its own spec suite that exercises the `ModelProvider`
  contract end-to-end against an injected fake client —
  `packages/agent-openai/src/lib/provider.spec.ts`,
  `packages/agent-xai/src/lib/provider.spec.ts`,
  `packages/agent-anthropic/src/lib/provider.spec.ts`, and siblings. Parity
  between adapters is a **human review invariant** today: when a new
  capability is added to one adapter, the reviewer checks that every
  other shipped adapter either implements it or documents the gap.
- **Not yet enforced by tooling** (intended future work, carried by
  ADR-0003's provider-matrix rollout):
  - An Nx `tag:adapter` target so `pnpm nx run-many -t test --projects=tag:adapter`
    becomes the parity gate.
  - A capability-manifest schema per adapter so gaps are explicit rather
    than implicit.
  - A repo-level ESLint `no-restricted-imports` rule forbidding direct
    imports of provider SDKs (`openai`, `@openai/agents`,
    `@anthropic-ai/sdk`, ...) from outside the adapter packages. Today
    no package depends on any such SDK, so the rule would be inert — it
    is deferred until the first adapter takes a vendor-SDK dependency.

## References

- Shipped contract: `packages/agent-contracts/src/lib/model-provider.ts`
- Shipped adapters:
  - `packages/agent-openai/src/lib/provider.ts`
  - `packages/agent-xai/src/lib/provider.ts`
  - `packages/agent-anthropic/src/lib/provider.ts`
- Anthropic native Messages and structured output:
  <https://platform.claude.com/docs/en/api/messages/create>
  <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- OpenAI Agents SDK (JS/TS) — considered, not adopted:
  <https://github.com/openai/openai-agents-js>
- LangGraph — considered, not adopted:
  <https://github.com/langchain-ai/langgraph>
- Open Source Definition: <https://opensource.org/osd>
- n8n licensing note: <https://docs.n8n.io/sustainable-use-license/>
