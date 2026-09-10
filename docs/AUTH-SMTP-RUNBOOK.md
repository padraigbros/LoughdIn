# Production Auth and SMTP runbook

This checklist records the dashboard/provider work required before public release. Never put passwords, SMTP tokens, service-role keys, or recovery codes in this repository.

## Auth URLs

In Supabase Auth URL Configuration, set the Site URL to:

`https://padraigbros.github.io/LoughdIn/`

Allow only these exact callbacks (retain the localhost origin for development):

- `https://padraigbros.github.io/LoughdIn/`
- `http://localhost:4173/`

Do not use wildcard redirects. Add Android deep-link callbacks only after the package/application identifiers and chosen scheme are confirmed; keep those entries documented separately from browser callbacks.

## Browser callback test matrix

Run each test with a disposable Account A and repeat isolation checks with Account B:

- Sign up; confirm the email; return to the Pages URL and verify the session.
- Sign in, refresh, sign out, and sign back in.
- Request password recovery; follow the link; set a new password; verify expiry and invalid-token errors.
- Resend confirmation and verify rate-limit/error behavior.
- Switch A to B with pending local work; verify no A command is uploaded as B.
- With A signed in, verify B's tasks, blocks, sessions, RPC receipts, and change log are inaccessible; repeat with raw API requests, not only the UI.
- Test an expired/revoked token while offline and after reconnect; local work must remain recoverable.

## Android callback TODO

Record the final application ID, signing flavor, HTTPS/app-link or custom-scheme decision, exact redirect URI, and verification-file ownership here once chosen. Test cold start, process death, link opened on the wrong account, cancellation, and account switching on a physical device. Do not broaden browser allowlists to accommodate native links.

## SMTP and email templates

Before enabling public email/password onboarding, record:

- Provider and account owner:
- Verified sending domain and DNS-zone owner:
- SPF, DKIM, and DMARC record/change references:
- Supabase project owner and SMTP-secret owner:
- Secret storage/rotation location (reference only; never the value):
- Template owner and last review date:

Review confirmation, password-reset, and email-change templates for the exact Pages callback and safe expiry messaging. Test successful delivery, delayed delivery, resend, expired link, invalid/used token, wrong-account link, and provider/Supabase rate limits. Keep error messages generic and ensure tokens and credentials never enter logs, exports, or committed files.
