# Provider Trials · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Two bound providers each process four invoices with three mandatory fields each under the same frozen suite. A accepts three invoices with 11/12 fields and spends 12 cents; B accepts two with 9/12 fields and spends 10 cents. Display 4 and 5 cents per accepted invoice, respectively, and 4/4 coverage. Results on four samples carry a small-sample warning. If A's settlement is missing, its cost efficiency is unknown until reconciliation.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Endpoint ownership • expected behavior

Status: NOT_RUN

A provider signs its challenge and serves the same nonce from its declared origin; binding becomes valid.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Endpoint ownership • failure boundary

Status: NOT_RUN

A valid signature with a nonce hosted on another origin is rejected, and the nonce cannot be replayed.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Consent and suite freezing • expected behavior

Status: NOT_RUN

Correcting one total creates a new suite version with a different manifest hash.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Consent and suite freezing • failure boundary

Status: NOT_RUN

A provider excluded by processor consent cannot receive the invoice or access its signed URL.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Budgeted experiment scheduling • expected behavior

Status: NOT_RUN

Two eligible providers and four frozen samples create eight distinct logical cells after command replay.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Budgeted experiment scheduling • failure boundary

Status: NOT_RUN

A binding that expires before dispatch blocks the affected cells and shows reduced coverage. A changed key or origin leaves historical reports pinned to the original binding and requires fresh enrollment.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Paid execution and receipt matching • expected behavior

Status: NOT_RUN

A settled retry adds its expense but does not increase the logical sample count.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Paid execution and receipt matching • failure boundary

Status: NOT_RUN

A timeout without a provider lookup does not auto-retry the payment or assert zero cost.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Typed scoring and acceptance • expected behavior

Status: NOT_RUN

11 correct fields across four three-field invoices, distributed 3/3/3/2, yield three accepted invoices.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Typed scoring and acceptance • failure boundary

Status: NOT_RUN

An ambiguous day/month date without an allowed format cannot be silently treated as correct.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Comparison reports • expected behavior

Status: NOT_RUN

Twelve cents across three accepted outputs displays exactly four cents per accepted invoice.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Comparison reports • failure boundary

Status: NOT_RUN

One outstanding unpriced attempt makes aggregate cost efficiency unknown even if an output exists.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Audit, freshness and reruns • expected behavior

Status: NOT_RUN

Rebuild an issued report using its cursor and obtain identical counters and input hashes.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Audit, freshness and reruns • failure boundary

Status: NOT_RUN

A later label correction or endpoint key rotation cannot rewrite the original report or transfer its score to a new identity.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-015 — Buyer workflow and acceptance proof • expected behavior

Status: NOT_RUN

The four-sample trial renders 4 versus 5 cents per accepted invoice and both coverage counts as 4/4.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-016 — Buyer workflow and acceptance proof • failure boundary

Status: NOT_RUN

A ranking configured for minimum 20 observations must suppress ordered recommendations for the four-sample example.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
