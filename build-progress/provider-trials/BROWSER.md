# Browser proof replay

Rendered evidence for the console lives in `shots/`. It is produced by real
headless-Chromium runs over the Chrome DevTools Protocol — no cookie minting,
no test-only shortcuts: the script signs in through the normal credential
login form using real keyboard input and navigates by clicking real links.

## Prerequisites

- This repository's working tree (`node >=22`).
- A cached headless Chromium from Playwright at
  `~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  (adjust the path in `tools/shot-console.mjs` if your cache layout differs).

## Steps

1. Seed and serve the reference acceptance scene:

   ```sh
   node tools/demo-acceptance.mjs
   ```

   It prints the console URL, the report/trial/provider ids, the analyst's
   member credential, and a ready-to-run shots command. Leave it running.

2. Capture rendered evidence (second terminal, repo root):

   ```sh
   node tools/shot-console.mjs <baseUrl> <accountId> <subject> <credential> <reportId> <trialId> <providerId>
   ```

   The script drives Chromium over CDP and:
   - loads `/console` unauthenticated (expecting the login redirect) at 390px
     and 320px (`login-phone.png`, `login-320.png`),
   - clicks into each field, types the account/subject/credential, Tabs
     between fields and submits with Enter — the session cookie is only ever
     issued by the server's real login POST,
   - presses Tab on the landed page and logs `focus after Tab:` to prove
     keyboard traversal (`workqueue-phone.png` shows the focus ring),
   - clicks the `Reports` nav link and then the report row — real link
     navigation, no direct URL for the detail page,
   - screenshots the comparison report at 1440, 834, 390 and 320 px
     (`report-desktop/tablet/phone/320.png`) plus the trial coverage page and
     the redacted field drill-down (`trial-phone.png`, `fields-phone.png`).

3. Review `build-progress/provider-trials/shots/*.png`.

## Identity model exercised by the proof

- Members get a single-use-visible credential at enrollment
  (`POST /accounts` returns `bootstrap_credential`, member creation returns
  `credential`); only a SHA-256 hash is stored.
- Programmatic calls authenticate with `x-pt-account`, `x-pt-subject` and
  `x-pt-credential`; the role is resolved from the member row, never from a
  header.
- The console session cookie is HMAC-signed with `PT_HMAC_SECRET`; when the
  variable is unset the service generates a fresh per-boot secret (sessions
  simply expire on restart) — there is no shared compile-time default.
- `PT_DEMO=1` alone enables the member-picker demo shortcut on the login
  page; without it the only way in is the credential form.
- Provider binding is signature-only: the console issues the challenge and
  shows the payload to sign; the operator signs locally and submits
  `challenge_id` + `signature`. Posting `private_key_pem` is rejected with
  `private_key_not_accepted`.
