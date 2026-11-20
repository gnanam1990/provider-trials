# Provider Trials · acceptance contract

### FR-01 — Endpoint ownership

Implement dual proof via key signature and a domain-served nonce, verify exact origin and time window, persist attestation expiry and rotation.

### INV-01 — Endpoint ownership

Both endpoint control and the enrolled principal must match the same nonce and origin.

### FR-02 — Consent and suite freezing

Import consented redacted invoices, create buyer-only truth records, document allowed processors and hash a versioned sample manifest and normalization configuration.

### INV-02 — Consent and suite freezing

A running trial cannot observe edits to its labels or processor permissions silently.

### FR-03 — Budgeted experiment scheduling

Expand the provider-by-sample matrix, reserve per-provider authorized spend and enforce bounded dispatch concurrency. Store completion, quota and timeout reasons separately.

### INV-03 — Budgeted experiment scheduling

Each provider sees the same frozen sample set; unanswered planned samples remain visible.

### FR-04 — Paid execution and receipt matching

Build OCR adapter contracts and receipt capture, bind transport and credential use to the declared provider, and record receipt provenance and attempt latency.

### INV-04 — Paid execution and receipt matching

Every reported cost maps to a verified charge for the corresponding trial; uncertainty is explicit.

### FR-05 — Typed scoring and acceptance

Implement manifest-pinned Unicode, monetary and date normalization, mandatory-field acceptance, timeout handling and interpretable field errors.

### INV-05 — Typed scoring and acceptance

Measure extraction against buyer-approved typed labels with fixed denominators.

### FR-06 — Comparison reports

Generate buyer-private reports with workload, dated sample size, confusion details, cost per accepted invoice, latency percentiles with sample count, and coverage thresholds.

### INV-06 — Comparison reports

Reports with zero accepted invoices have undefined unit cost; suppressed comparison must explain why.

### FR-07 — Audit, freshness and reruns

Add curve of quality over suite versions, opt-in recurring trials, results export, role-scoped evidence and read-only reconstruction from frozen records.

### INV-07 — Audit, freshness and reruns

Comparisons across different suites or scoring rules cannot appear as a like-for-like trend.

### FR-08 — Buyer workflow and acceptance proof

Build the procurement-to-report UI with consent and cap review, coverage filters, small-sample notices and the two-provider acceptance scenario. Exercise API plus browser from clean storage.

### INV-08 — Buyer workflow and acceptance proof

Every displayed provider claim includes workload, relevant date, observed sample count and evidence scope.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
