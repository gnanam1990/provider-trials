# Provider Trials · Product requirements

## Product decision

Start with a versioned Tamil invoice OCR suite, eligible providers that can process approved inputs, per-provider budget limits, field-level evaluation and reproducible buyer-private reports. Evaluate date, tax and total under deterministic typed rules. Show task-specific observations by provider, version and time window.

**Buyer and commercial hypothesis.** Agent platforms buying OCR and extraction. Sell recurrent vendor evaluations or a private benchmark subscription. Start with a Tamil invoice automation team.

**People and responsibilities.** A procurement lead defines a buyer-private benchmark. A dataset steward approves representative inputs and truth labels. A provider operator proves control over a service endpoint. A runner procures measured executions and buyer analysts inspect comparison reports.

## Customer journey

Buyer chooses a consented, held-out invoice batch and labels, freezes scoring and sample policy, and verifies provider bindings. The runner measures each provider on identical inputs under the budget. Analyst compares accepted invoice rate, valid fields, cost and latency alongside incomplete coverage.

## Acceptance scene

Two bound providers each process four invoices with three mandatory fields each under the same frozen suite. A accepts three invoices with 11/12 fields and spends 12 cents; B accepts two with 9/12 fields and spends 10 cents. Display 4 and 5 cents per accepted invoice, respectively, and 4/4 coverage. Results on four samples carry a small-sample warning. If A's settlement is missing, its cost efficiency is unknown until reconciliation.

## Behaviors for the team

- **FR-01 · Endpoint ownership.** Implement dual proof via key signature and a domain-served nonce, verify exact origin and time window, persist attestation expiry and rotation.
- **FR-02 · Consent and suite freezing.** Import consented redacted invoices, create buyer-only truth records, document allowed processors and hash a versioned sample manifest and normalization configuration.
- **FR-03 · Budgeted experiment scheduling.** Expand the provider-by-sample matrix, reserve per-provider authorized spend and enforce bounded dispatch concurrency. Store completion, quota and timeout reasons separately.
- **FR-04 · Paid execution and receipt matching.** Build OCR adapter contracts and receipt capture, bind transport and credential use to the declared provider, and record receipt provenance and attempt latency.
- **FR-05 · Typed scoring and acceptance.** Implement manifest-pinned Unicode, monetary and date normalization, mandatory-field acceptance, timeout handling and interpretable field errors.
- **FR-06 · Comparison reports.** Generate buyer-private reports with workload, dated sample size, confusion details, cost per accepted invoice, latency percentiles with sample count, and coverage thresholds.
- **FR-07 · Audit, freshness and reruns.** Add curve of quality over suite versions, opt-in recurring trials, results export, role-scoped evidence and read-only reconstruction from frozen records.
- **FR-08 · Buyer workflow and acceptance proof.** Build the procurement-to-report UI with consent and cap review, coverage filters, small-sample notices and the two-provider acceptance scenario. Exercise API plus browser from clean storage.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Start with two participating Tamil OCR providers plus a synthetic or rights-cleared benchmark that can be lawfully sent to both. Verify specific registry/payment rails first. Use the tiny example below for correctness; determine minimum production sample size with the buyer and report statistical uncertainty.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [BlockTerms](https://ethglobal.com/showcase/blockterms-10te2); customer willingness to pay requires pilot evidence.

## Larger team scope

- Endpoint ownership rotation, expiry and new-provider probation
- Private benchmark design with versioned labels, locale and sample strata
- Price-quality comparisons including abstentions, failures and confidence intervals
- Periodic reruns, regression alerts and buyer-defined purchasing rules

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
