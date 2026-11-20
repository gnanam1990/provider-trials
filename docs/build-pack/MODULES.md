# Provider Trials · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Endpoint ownership](prompts/M01.md) — Implement dual proof via key signature and a domain-served nonce, verify exact origin and time window, persist attestation expiry and rotation.
2. [M02 · Consent and suite freezing](prompts/M02.md) — Import consented redacted invoices, create buyer-only truth records, document allowed processors and hash a versioned sample manifest and normalization configuration.
3. [M03 · Budgeted experiment scheduling](prompts/M03.md) — Expand the provider-by-sample matrix, reserve per-provider authorized spend and enforce bounded dispatch concurrency. Store completion, quota and timeout reasons separately.
4. [M04 · Paid execution and receipt matching](prompts/M04.md) — Build OCR adapter contracts and receipt capture, bind transport and credential use to the declared provider, and record receipt provenance and attempt latency.
5. [M05 · Typed scoring and acceptance](prompts/M05.md) — Implement manifest-pinned Unicode, monetary and date normalization, mandatory-field acceptance, timeout handling and interpretable field errors.
6. [M06 · Comparison reports](prompts/M06.md) — Generate buyer-private reports with workload, dated sample size, confusion details, cost per accepted invoice, latency percentiles with sample count, and coverage thresholds.
7. [M07 · Audit, freshness and reruns](prompts/M07.md) — Add curve of quality over suite versions, opt-in recurring trials, results export, role-scoped evidence and read-only reconstruction from frozen records.
8. [M08 · Buyer workflow and acceptance proof](prompts/M08.md) — Build the procurement-to-report UI with consent and cap review, coverage filters, small-sample notices and the two-provider acceptance scenario. Exercise API plus browser from clean storage.
