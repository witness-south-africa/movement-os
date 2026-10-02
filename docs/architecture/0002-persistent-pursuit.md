# 0002 — Persistent pursuit is the platform's operating mandate

- Status: accepted
- Date: 2026-04-18
- Deciders: Cause Council (pending formalisation)

## Context

`movement-os` was originally described as a "civic accountability
platform". That framing is true but too small. A research tool helps a
user look something up and then stops. A movement needs something
different: a system that **pursues** a case, through every lawful
channel, across years if needed, and never marks a case "abandoned"
simply because it ran out of easy answers.

The dedication recorded in [`MEMORIAL.md`](../../MEMORIAL.md) gives the
sharpest example. One case is not the point; the point is that every
family asking the same kind of question should land in the same
disciplined process, with the same exhaustion ladder, the same audit
trail, and the same refusal to quietly give up.

This ADR encodes that requirement as a first-class property of the
platform, not a slogan.

## Decision

`movement-os` is a **persistent-pursuit case operating system**. The
architecture and the domain model reflect that at every level.

### 1. Case lifecycle — no "abandoned" state

A `Case` has one of these lifecycle states, and **never** the value
`abandoned`:

- `active` — at least one open `Question` has an untried method or a
  scheduled retry.
- `paused-awaiting` — the next lawful step is blocked on an external
  actor (e.g. a PAIA request is within its 30-day statutory window, a
  subject-access response is pending, a court date has been set). A
  paused case automatically returns to `active` on a timer.
- `resolved-with-finding` — the case has reached one of the
  evidential-completeness statuses below and the finding has been
  signed off by a human reviewer.
- `resolved-insufficient-evidence` — every lawful channel has been
  exhausted and documented. The case is preserved, not closed; new
  evidence reopens it automatically.
- `destroyed-or-missing-record-suspected` — the platform has reason to
  believe the primary record was destroyed or withheld. This is a
  finding in itself and is treated as a publishable claim.

### 2. Evidential-completeness vocabulary

The platform **does not promise conclusive truth.** It promises
maximum evidential completeness. Every `Claim` carries one of:

- `conclusive` — primary record + corroboration + no credible
  counter-evidence.
- `high-confidence` — multiple independent sources agree; no primary
  record, but the weight of evidence is one-sided.
- `contested` — credible sources disagree. Both sides are recorded.
- `insufficient-record` — the record set is too thin to support any
  status above.
- `destroyed-or-missing-record-suspected` — specific records should
  exist and do not; the absence itself is evidence.

This replaces the earlier `unverified | verified | contradicted |
unverifiable` vocabulary used in `@wsa/schemas` v0.1. Migration is
tracked as a follow-up in a separate schema-change ADR.

### 3. The exhaustion ladder (L0 → L4)

A case cannot move to `resolved-insufficient-evidence` without each
rung being tried, logged, and timestamped:

- **L0 — Public web + indexes.** SAFLII, NLSA, TRC/SAHA indexes,
  War Graves, SAHRA, StatsSA, gazetted notices, news archives.
- **L1 — PAIA.** Formal access request to the relevant public or
  private body under the Promotion of Access to Information Act, 2000.
- **L2 — Legal escalation.** Inquest re-opening application, review
  application, referral to the Information Regulator, referral to the
  South African Human Rights Commission or Public Protector where
  mandate allows.
- **L3 — Human field layer.** Archive runners in person at NARSSA /
  NAAIRS, records officers at SAPS / DoD / DoJ / municipalities,
  witness documenters with Commissioner-of-Oaths affidavits, case
  custodians managing family relationships and consent.
- **L4 — Partner handoff.** Structured referral to a partner NGO,
  investigative newsroom, or legal clinic with a complete dossier and
  a chain-of-custody manifest.

Each attempt is a `MethodAttempt` record. Each L3 step is a
`HumanLead` record. Nothing is deleted; failed attempts feed the
method-effectiveness scoreboard (section 5).

### 4. Pipeline

Every case walks the same pipeline. Agents implement the stages;
humans gate the sensitive ones.

```text
ingest → search → cross-match → request → escalate → review → retry → preserve
```

- **ingest** — intake with lawful basis (POPIA).
- **search** — L0 sources.
- **cross-match** — name / date / place / docket-number / service-
  number reconciliation against the case graph; alias and alternate-
  spelling expansion (e.g. older place names, Afrikaans/English
  toponym pairs, pre-1994 district vs current municipal name).
- **request** — L1 PAIA request generation.
- **escalate** — L2 legal channels.
- **review** — human reviewer gate; nothing published without a
  signed `Approval`.
- **retry** — contradictions, gaps, or new leads go back to **search**
  with the new signal. A case returning to search is a feature, not a
  failure.
- **preserve** — everything, forever, in the hash-chained audit log.

### 5. Method-effectiveness scoreboard

Every `MethodAttempt` records: which method, which source, which
agent or human, outcome, time-to-result, cost. Across cases, the
platform learns which methods work for which question shapes. This
learning is case-agnostic and shared in the OSS repo as anonymised
statistics so other operators benefit.

### 6. HumanLead as a first-class entity

The human field layer is not a fallback — it is a lane. A `HumanLead`
carries its own consent record, affidavit pointer, chain-of-custody
manifest, and safety assessment (NPA witness-protection triage where
relevant). Agents schedule and brief human field workers; humans
schedule and brief agents; both are audit events.

### 7. Non-negotiables

The platform — software and field — operates only within lawful,
ethical, non-coercive bounds:

- No trespass, no hacking, no bypassing authentication.
- No coercion, no intimidation, no deception of witnesses.
- No impersonation of officials, journalists, or family members.
- No public naming of private individuals without informed, recorded
  consent.
- No covert persuasion, astroturfing, or mass-publishing. See
  [`ACCEPTABLE_USE.md`](../../ACCEPTABLE_USE.md).

## Standards the platform aligns with

- **OHCHR monitoring manuals** — interview method, source triangulation,
  safety of sources.
- **Minnesota Protocol on the Investigation of Potentially Unlawful
  Death (2016)** — investigative standard for deaths-in-custody and
  deaths involving state actors.
- **Promotion of Access to Information Act, 2000 (PAIA)** — access
  channel for public and private bodies.
- **Protection of Personal Information Act, 2013 (POPIA)** — lawful
  basis, minimisation, retention, rights of data subjects. See
  [`POPIA.md`](../../POPIA.md).
- **National Prosecuting Authority witness-protection programme** —
  triage and referral when a witness is at risk.

## Consequences

**Positive.**

- The platform has an identity beyond "AI agents that help with
  advocacy". It is a case OS with a named operating doctrine.
- Operators can answer "what happens if a case goes cold?" with a
  concrete next step, not a shrug.
- The method-effectiveness scoreboard turns every failed attempt into
  a contribution to every future case.

**Negative / costs.**

- The domain model grows. New entities: `Case`, `Question`,
  `MethodAttempt`, `HumanLead`, `ConsentRecord`,
  `ChainOfCustodyEntry`. Schema migration is non-trivial and is
  tracked separately.
- The platform takes on moral weight. A "never abandoned" promise
  must be backed by operational discipline, or the promise degrades
  into a lie. That operational discipline is the Cause Council's job.
- Storage grows monotonically. Preservation is a feature; the audit
  log is never trimmed.

## Rollout

The schemas and field documents below are shipped. The case-engine
orchestrator, automatic pause/retry timers and method-effectiveness
aggregation remain planned. The lifecycle descriptions above define the
target policy; schema status values alone do not implement that behavior.

The original implementation plan has three parts:

1. `@wsa/schemas` — add `Case`, `Question`, `MethodAttempt`,
   `HumanLead`, `ConsentRecord`, `ChainOfCustodyEntry`; migrate
   `Claim.status` to the new vocabulary.
2. `@wsa/case-engine` — pipeline orchestrator, retry policy, pause
   timers, method-effectiveness aggregator.
3. `docs/field/` — intake form, consent script, interview checklist,
   affidavit workflow, archive-runner workflow, chain-of-custody
   form. A minimal stub ships with this ADR so the field layer has
   something to work from on day one.

## References

- [`MEMORIAL.md`](../../MEMORIAL.md)
- [`POPIA.md`](../../POPIA.md)
- [`ACCEPTABLE_USE.md`](../../ACCEPTABLE_USE.md)
- OHCHR, _Training Manual on Human Rights Monitoring_ (Chapter 8,
  Interviewing).
- UN, _The Minnesota Protocol on the Investigation of Potentially
  Unlawful Death_ (revised 2016).
