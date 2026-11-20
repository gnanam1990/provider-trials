# Provider Trials · Final handoff

Initial state at intake: specification-only pack under `docs/build-pack/`; no product code existed. Dedicated greenfield repo, branch `devin/provider-trials`.

- Target repository / branch: this checkout, `devin/provider-trials`.
- Tested SHA: `ee36326`.
- Stack: Node >=22.18 native type-stripped TypeScript (zero npm deps), `node:sqlite` storage (see DECISION-sqlite.md), `node:test`, Ed25519 via `node:crypto`, server-rendered console. `FakeProvider` emulator stands in for paid OCR rails.
- Entry points: `npm start` (API + console on `PT_PORT`, default 8787; `PT_DB` selects the sqlite file), `npm test` (21 tests), `node tools/demo-acceptance.mjs` (seeded demo instance), `node tools/shot-console.mjs <base> <accountId> <subject> <credential> <reportId> <trialId> <providerId>` (headless-Chromium rendered captures via the real login flow — replay notes in BROWSER.md).

## Completed behavior (all eight modules accepted)

- M01 endpoint ownership: Ed25519 + origin-served nonce dual proof, single-use challenges, binding expiry/rotation state (T-001/T-002).
- M02 consent and suite freezing: redacted consented samples, buyer-only labels, allowed-processor lists, content/label/manifest hashing, immutable versions, expiring signed sample URLs, consent exclusions (T-003/T-004).
- M03 budgeted scheduling: provider-by-sample matrix with unique logical cells, global + per-provider budget reserves, bounded dispatch concurrency, deferred/blocked reasons, expired-binding blocking, coverage gaps (T-005/T-006).
- M04 execution and receipts: adapter contract (quote/execute/status), persisted attempts before dispatch, signed receipt verification, timeout -> explicit uncertain state, bounded retries with aggregated cost and no auto-retry of uncertain charges (T-007/T-008 + settle-after-timeout reconciliation).
- M05 typed scoring: manifest-pinned normalizer, Unicode/monetary/date normalization, ambiguous dates rejected, per-field outcomes, acceptance only when all mandatory fields correct (T-009/T-010).
- M06 comparison reports: immutable reports at an evidence cursor — scheduled/attempted/accepted, field denominators, errors, spend, latency n/p50/p95, coverage, binding expiry, run window, cost per accepted in minor units, unknown-cost state, small-sample + min-observations suppression (T-011/T-012).
- M07 audit, freshness, reruns: append-only audit, key/origin rotation pinning old evidence, opt-in recurring reruns, quality curves grouped by normalizer version, JSON/CSV export, restart-proof rebuild (file-db), role-scoped evidence, tenant isolation (T-013/T-014 + extras).
- M08 buyer console: role-aware work queue, provider/suite/trial/report pages, consent + budget-cap review on trial creation, coverage and blocked-reason views, reconcile/issue-report actions, comparison rows with warnings (small-sample, unknown cost, incomplete coverage), suppressed-ranking notice, redacted field evidence drill-down, JSON/CSV export links, HTML error pages, mobile scrollable tables, empty states, visible focus, session-cookie auth with SameSite=Lax (T-015/T-016 e2e).

## Security hardening pass (post-acceptance review)

- Member credentials: enrollment issues a one-time-visible `cred_*` per member row; only a SHA-256 hash is stored (schema migration v2 `member_credentials`). `POST /accounts` returns `bootstrap_credential`, `POST /accounts/{id}/members` returns `credential`.
- API identity is authenticated, not asserted: `x-pt-account` + `x-pt-subject` + `x-pt-credential` verified against the member hash; the role is resolved from the member row and `x-pt-role` is no longer read.
- Console login requires the member credential; the role is never user-selected. `PT_DEMO=1` alone enables the member-picker demo shortcut; normal mode rejects `demo_member`.
- No shared session key: `PT_HMAC_SECRET` unset -> fresh per-boot random secret (sessions expire on restart); no compile-time default remains.
- Provider binding is signature-only end-to-end: the console issues the challenge and displays the payload for local signing; it accepts only `challenge_id` + `signature` and rejects `private_key_pem` outright (`private_key_not_accepted`). The server-side signing helper and the PEM paste form were removed.
- Regression suite `test/auth-hardening.test.ts` (H-01..H-04): credential verification, role-spoof immunity, wrong/missing credential 401s, demo gating both ways, signature-only console bind, `private_key_pem` refusal, non-default session secret.
- Browser proof reworked: `tools/shot-console.mjs` now signs in through the real form via keyboard input, navigates by clicking real links, verifies focus traversal, and adds 320px captures; replay steps in `BROWSER.md`.

## Verification evidence

- `npm test` — 21 tests, exit 0 (T-001..T-016 plus module extras and H-01..H-04).
- `node docs/build-pack/tools/check-build-pack.mjs --root docs/build-pack` — no errors.
- Clean-checkout proof: `git clone --template="" . .clean-checkout/repo && cd .clean-checkout/repo && npm test` — 17/17 at `683304b` (pre-hardening baseline), exit 0.
- Live smoke: `PT_PORT=8791 PT_DB=data/smoke.db node src/server.ts` — `/health` 200, `/accounts` 201, `/console` -> 303 `/console/login`.
- Rendered review (headless Chromium via `tools/shot-console.mjs`, real login flow): `build-progress/provider-trials/shots/` — login at 390/320, work queue with keyboard focus ring, report at 1440/834/390/320, trial coverage, redacted field evidence. Acceptance scene renders A `4¢`/accepted (3/4 accepted, 11/12 fields, 12¢, 4/4) vs B `5¢` (2/4, 9/12, 10¢, 4/4), small-sample warnings, suppressed ordered comparison (`min_observations` requires 20, observed 4). Tables scroll horizontally at 390/320px.
- UI design review: `impeccable` skill, Operate mode — polish pass applied (scroll-wrap tables, HTML error pages, empty states, `light-dark` muted contrast >= 4.5:1, `role="status"` on alerts, escaped dynamic keys); `impeccable detect --json --changed` returned `[]`.
- Acceptance scene numbers verified end-to-end in `test/m08.test.ts`: A 12c/3 accepted = 4c, B 10c/2 = 5c, coverage 4/4 each, ranking suppressed, cross-tenant report access 404.

## External dependencies — unproven, with exact missing proof

- Live OCR provider endpoints: no real provider participated. Missing proof: a dual-proof binding against a provider-controlled origin and a signed receipt from a real invoice OCR run. `FakeProvider` (test emulator) only.
- Real Tamil invoice corpus with consent: sample contents are synthetic placeholders. Missing proof: consented, redacted production invoices plus consent records.
- Kite Passport / x402 paid execution and settlement: no paid calls made (prohibited this run). Missing proof: a real x402 payment flow and its settlement/receipt chain; cost figures come from emulator-signed receipts.
- Hosted deployment / external publication: none by instruction. No push, no PR, no deploy.

## Next action

Nothing pending in this run. If live integrations become available: wire a real OCR adapter behind `src/adapters/ocr.ts`'s contract, run the dual-proof binding against provider infrastructure, and re-run the acceptance scene to capture verified (non-emulated) settlement evidence.

## Next agent must reproduce

`npm test` — no `npm install` needed (zero dependencies). For rendered review: `node tools/demo-acceptance.mjs`, then `node tools/shot-console.mjs` with the printed ids (needs a cached headless Chromium under `~/Library/Caches/ms-playwright/`).
