# Provider Trials · Session handoff

Initial state at intake: specification-only pack under `docs/build-pack/`; no product code existed. Dedicated greenfield repo, branch `devin/provider-trials`.

- Target repository / branch / tested SHA: this checkout, branch `devin/provider-trials`.
- Stack decision: Node >=22.18 native type-stripped TypeScript (zero npm deps), `node:sqlite` storage (see DECISION-sqlite.md), `node:test`, Ed25519 via `node:crypto`, server-rendered console (planned M08). Local `FakeProvider` emulator stands in for paid OCR rails — live paid execution is an open external dependency (no paid calls permitted in this run).
- Completed behavior: M01 endpoint ownership. Providers register origin+Ed25519 key; single-use challenges bind nonce to origin+expiry; binding requires BOTH valid key signature over the challenge payload AND the declared origin serving the nonce at `/.well-known/provider-trials/nonce` (INV-01). Challenge consumed on any submission (no replay). Prior valid binding is superseded on rebind; `sweepExpiredBindings` expires attestations and marks provider expired.
- Evidence: `node --test test/m01.test.ts` — T-001 (dual proof -> binding valid, provider bound) and T-002 (valid signature + nonce on wrong origin -> 403 nonce_not_served; replay -> 409 challenge_used). 2 tests, exit 0.
- Entry points: `npm start` (API on PT_PORT, default 8787), `npm test`, PT_DB env selects sqlite file.
- Working tree requiring transfer: none.
- External dependencies: live OCR provider endpoints, real Tamil invoice corpus, Kite Passport/x402 paid execution — all unproven; emulator implements quote/execute/status receipt flow only.
- Next action: M02 — suites/samples/labels, consent processor lists, manifest hashing, freeze semantics, signed sample URLs (T-003/T-004).
- Next agent must reproduce: `npm install` not needed (zero deps); `npm test` or `node --test test/m01.test.ts`.
