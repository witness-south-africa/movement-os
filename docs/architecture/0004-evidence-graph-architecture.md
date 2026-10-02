# 0004 — Evidence graph architecture: append-only canonical store, Postgres + AGE + pgvector, bi-temporal provenance, hybrid retrieval from day one, GraphRAG deferred

- Status: accepted
- Date: 2026-04-18
- Deciders: Rudi (founder); pending Cause Council ratification
- Supersedes: nothing
- Relates to: [ADR-0001](./0001-agent-framework.md), [ADR-0002](./0002-persistent-pursuit.md), [ADR-0003](./0003-llm-provider-matrix.md)

## Context

ADR-0002 committed the platform to **persistent pursuit**: a case is
never quietly abandoned, every method attempt is recorded, every lead
is tracked across years. ADR-0003 locked the LLM posture: schema-first
structured extraction behind a multi-provider contract, never
free-text "the model said so" answers. Neither ADR said anything
about **where the evidence actually lives** or **how it is retrieved**
when a human or an agent asks a question across many cases.

That gap matters. A persistent-pursuit platform that cannot answer
"which unit names, places, and dates recur across all our Phola Park-
era cases" degrades to a fancy filing cabinet. A platform that answers
it from an ungrounded language-model summary degrades to a rumour
engine. Either failure is fatal for a movement whose credibility rests
on provenance.

Three forces shape the decision:

1. **Evidence is append-only.** Facts do not mutate. They get
   superseded by newer facts, contradicted by other sources, or
   revised as witnesses remember more. Mutating a claim row six
   months after the fact would destroy the movement's audit story.
2. **Time is part of the fact.** Every claim has two timelines:
   when we recorded it, and when it is believed true in the world.
   "What did we believe on 2026-05-03 about this case" is a
   first-class query, not an afterthought.
3. **Retrieval must be hybrid from day one.** Operators ask by name,
   by place, by docket number, by narrative description, and by
   graph relationship ("who else worked in that unit that month").
   No single retrieval mode covers all of those. Graph alone, vector
   alone, or text alone is insufficient.

A fourth force — cost and political sovereignty — shapes the storage
choice: the platform must be self-hostable, fully Apache-2.0-friendly
end to end, and must not rely on a commercially licensed datastore to
run in production.

## Decision

### Current implementation

`@wsa/events` ships event envelopes, canonicalisation and hash-chain
utilities. `@wsa/schemas` ships bi-temporal claim/evidence fields and
required claim source references. These are in-memory schema and utility
boundaries. The persistent event store, Postgres deployment, graph
projection, retrieval packages and replay-verification job remain planned.

The platform adopts an **evidence graph architecture** with five
locked commitments. This is the spine for every data-touching package
from here forward.

### 1. Canonical store is append-only and event-sourced

The system of record is an append-only log of immutable events:
witness intake, artifact ingestion, consent capture, chain-of-custody
transfers, claim assertions, supersessions, approvals, and audit
entries. Nothing in that log is ever updated or deleted. Corrections
are new events that reference and supersede earlier ones.

Every event carries a deployment-scoped identity, a timestamp, the
actor who produced it (human or agent, named), and a cryptographic
hash chained to the previous event for that aggregate. The chain is
the reason anyone — operator, journalist, court — can trust the
record years from now.

### 2. Storage target: PostgreSQL + Apache AGE + pgvector, single datastore in phase 1

Phase 1 is intended to run on one Postgres instance with two
open-source
extensions:

- **Apache AGE** provides openCypher graph traversal inside Postgres.
  It is an Apache-2.0 extension and lets the graph projection live in
  the same ACID transaction boundary as the event log and the vector
  indexes.
- **pgvector** provides cosine / inner-product / L2 vector search on
  indexed columns. Open source, operationally boring, and — crucially
  — transactional with the rest of the data.

The canonical event log, the projected graph, and the vector indexes
are intended to live in the same Postgres database. One backup. One
restore. One audit boundary. One POPIA boundary. The intended graph
projection rebuild path is a `DELETE FROM graph_* ;
SELECT replay_projector()` inside a transaction, not a cross-system
migration.

This choice is deliberate and narrow: **phase 1 optimises for
boring, auditable, rebuildable infrastructure, not for graph-engine
benchmarks.** A dedicated graph engine becomes justifiable if and
only if measured traversal cost or query complexity forces it. That
decision gets its own ADR.

### 3. Bi-temporal provenance on every claim edge, from day one

Every factual edge — every `Claim`, `Attribution`, `Relationship`
between people, units, places, artifacts, or events — carries at
least five columns:

- `assertedAt` — wall-clock moment the platform first recorded the
  claim. System time. Never changes.
- `validFrom` — the moment the claim is believed to become true in
  the world. Valid time. Nullable for "unknown start."
- `validTo` — the moment the claim ceases to be true. Nullable for
  "ongoing or unknown end."
- `supersededBy` — optional pointer to the claim that replaces this
  one. Supersession is the only way a fact changes.
- `sourceRef` — required pointer to the canonical event or artifact
  that grounds the claim. A claim with no `sourceRef` is rejected
  at the schema layer.

Claims are additionally tagged with the `confidence` vocabulary
already shipped in `@wsa/schemas` (ADR-0002's V2 status set).
Bi-temporal retrofitting is painful and the platform will never be
smaller than it is today, so this is a phase-1 schema decision, not
a future refinement.

### 4. Hybrid retrieval from day one (phase 1 and phase 2 collapse)

There is no "graph-only" phase in the target design. A graph that
cannot be entered by name, by narrative description, or by docket
number is not operationally useful. Phase 1 is intended to ship with
three retrieval modes answering one `/retrieve` API:

- **Text search** — Postgres full-text on artifact chunks and on
  canonical name fields.
- **Vector search** — pgvector cosine similarity over chunk
  embeddings and entity description embeddings.
- **Graph traversal** — Apache AGE openCypher walks over the
  projected graph, starting from entities the first two modes
  identified.

The planned retrieval layer returns source-backed nodes and chunks,
with provenance attached to every result. That layer does not
synthesise, summarise, or narrate. Synthesis, if any, happens at a
higher layer behind the `ModelProvider` contract of ADR-0003, with a
schema that constrains the output to source-cited fields.

### 5. LLM policy in phase 1: structured extraction only

Agents use `@wsa/agent-contracts` (shipped in `f7260f8`) to perform
exactly three kinds of work in phase 1:

- Structured extraction from raw artifacts into typed `Claim`,
  `Attribution`, and `Entity` events.
- Structured contradiction detection between claims already in the
  graph, producing typed `Contradiction` events.
- Structured query understanding — mapping a user's natural-language
  question to a typed retrieval plan.

Phase 1 **does not** ship free-text answer-time synthesis. An agent
may produce prose, but only as a field of a schema whose other
fields carry the source references. Any prose rendered to an
operator or a published artifact must be accompanied by the
provenance that grounds it. This is a hard policy boundary, not a
stylistic preference.

### 6. Graphiti: adopt the temporal data model, not the runtime

Graphiti's temporal-graph model — episodes, validity intervals,
provenance on every fact — maps cleanly onto this platform's needs.
The platform adopts the **model**: validity intervals per fact,
supersession as the only mutation, source references as a
first-class requirement. The platform does **not** adopt the
runtime; the planned graph projection would use the platform's own code
against Postgres + AGE. This keeps portability and keeps the ADR
count honest — the platform is not pinned to any upstream project's
roadmap or licence changes.

## Options considered

### Neo4j Community Edition — rejected for phase 1

Neo4j is the best-known graph database and has official GraphRAG
tooling. It is rejected here for three reasons. Licensing: Enterprise
is GPLv3/commercial dual-licensed and Community edition does not
include clustering, causal consistency, or hot backups — Neo4j's own
documentation is explicit about that. Political surface: a platform
that exists to scrutinise state and private power should not depend
on a commercially licensed datastore from a single foreign vendor.
Operational doubling: Neo4j would be a second datastore next to
Postgres, doubling backup, restore, and POPIA-boundary work for
phase 1's benefit. The platform may revisit Neo4j when measured
traversal workload justifies it.

### ArangoDB — rejected

ArangoDB 3.12 and later are licensed under BSL 1.1, a
source-available licence that is not OSI-approved. That conflicts
with ADR-0001's "cleanly open source" mandate. Earlier versions
under Apache-2.0 will not receive security fixes indefinitely.

### JanusGraph on Cassandra / ScyllaDB — deferred

JanusGraph is Apache-2.0 and scales further than Postgres + AGE.
It is also materially heavier to operate, requires Cassandra or
ScyllaDB as a backing store, and is overkill for phase-1 corpus
sizes. Revisit when measured data volume justifies.

### Microsoft GraphRAG runtime — deferred to phase 4

Microsoft's GraphRAG repository is, in Microsoft's own words, a
demonstration and warns that indexing can be expensive. It is
optimised for one-shot indexing of large static corpora and for
batch community-summary generation. The platform's corpus is
streaming, contested, and revisable — the wrong shape for a
demonstration pipeline. GraphRAG's batch synthesis approach remains
valuable for corpus-wide pattern questions and will be evaluated as
a phase-4 layer on top of the evidence graph, not as its foundation.

### Graphiti runtime — deferred

Graphiti the runtime is a compelling fit for the model but would
introduce another upstream dependency and another operational
surface. Phase 1 adopts the model in the platform's own code.

## Two hard-coded additions

**Phase 1 and phase 2 collapse.** The original sketched plan had a
"build the evidence graph" phase and a later "add hybrid retrieval"
phase. That split is rejected. A graph without hybrid retrieval is
not operationally useful. Phase 1 is intended to ship the graph with
text, vector, and traversal retrieval together or it does not ship.

**The graph projection is disposable.** The projected graph is a
read-optimised view over the canonical event log. If the projection
is corrupted, re-modelled, or migrated to a different engine, it is
rebuilt from canonical events and artifacts. Nothing in the graph
projection is a source of truth on its own. This is a desired
property of the implementation. When the projector exists, it should
be verified by a periodic rebuild job that drops the projection and
replays the log, comparing node and edge counts and sample hashes
against a reference run.

## Consequences

**Positive.** If implemented as described, phase 1 would use one
datastore, collapsing backup, restore, and POPIA-boundary work. It
would also give a clean story for regulators and journalists: every
claim points to a canonical event; every event is append-only and
hash-chained. Temporal queries ("what was believed when") would be
first-class from day one. The LLM would be structurally prevented
from becoming a parallel source of truth. The platform would remain
portable — a later move to a dedicated graph engine would replace
only the projection code, not the canonical log.

**Negative and bounded.** Postgres + AGE is expected to be slower on
deep traversals than a native graph engine at large corpus sizes.
Mitigated by the explicit commitment to revisit storage when measured
workload demands it. Bi-temporal modelling adds upfront schema
complexity; ADR-0002 already committed the platform to that level of
rigour, so the cost is paid once. Hybrid retrieval will require three
indexes to be maintained in lock-step with the projector; this is a
projector-level concern, not a retrieval-layer concern.

**To revisit.** Deep traversal performance at > 5 million canonical
events. Community-summary synthesis (GraphRAG phase). Introduction of
a local / self-hosted LLM provider for the sensitive-intake lane.
Multi-region deployment and its interaction with the hash-chained
log.

## Rollout

Implementation is sequenced across follow-up commits, each with its
own ADR only if a real decision is required. The packages implied
by this ADR are sketched here, not ratified:

1. `@wsa/events` — canonical event schemas and hash-chain utilities
   are shipped as pure TypeScript with no Postgres dependency. A
   persistent append-only event-log client remains planned.
2. `@wsa/graph-projection` — projector that consumes events and
   writes nodes and edges into the AGE-backed graph tables. Idempotent
   from the event stream.
3. `@wsa/retrieval` — hybrid-retrieval API: one `retrieve(query)`
   entry point that fans out to full-text, pgvector, and openCypher,
   merges results, and returns source-backed hits with provenance.
4. `@wsa/db-postgres` — thin Postgres client wiring, migrations,
   extension bootstrap (AGE, pgvector, pg_trgm), and the projector
   rebuild job.

Items 2-4 are not implemented. `@wsa/schemas` already carries the V2
claim-status vocabulary (ADR-0002) and V3 claim provenance:
`assertedAt`, `validFrom`, `validTo`, `supersededBy`, and required
`sourceRef`. Claim source references currently support `intake` and
`artefact`; an `event` reference is not implemented.

The first field deployment will run on a single Postgres instance
with a measured rebuild benchmark included in the POPIA assessment
pack.

## References

- Apache AGE — Apache-2.0 graph extension for PostgreSQL,
  openCypher support.
- pgvector — open-source vector extension for PostgreSQL.
- Neo4j — operational feature matrix (Enterprise-only clustering,
  backups, causal consistency).
- ArangoDB — licence change to BSL 1.1 from 3.12.
- Microsoft GraphRAG — repository and own documentation noting the
  demonstration status and indexing cost.
- Graphiti — temporal knowledge-graph model: episodes, validity
  intervals, provenance.
- ADR-0001, ADR-0002, ADR-0003, [`POPIA.md`](../../POPIA.md),
  [`MEMORIAL.md`](../../MEMORIAL.md).
