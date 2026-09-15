# Production Auth and email runbook

Auth configuration for project `kknbyhlwmuzttyxyuffe`, the decision to stay on
Supabase's built-in email service, and the checks that still need a person with
a real inbox.

Never put passwords, SMTP tokens, service-role keys, or recovery codes in this
repository.

## Configured on 10 September 2026

| Setting | Value |
| --- | --- |
| Site URL | `https://padraigbros.github.io/LoughdIn/` |
| Redirect URL | `https://padraigbros.github.io/LoughdIn/` |
| Redirect URL | `http://localhost:4173/` |
| Wildcards in the allow list | None |
| Enabled providers | Email and password, Google |
| Anonymous sign-in | Off |
| Open sign-up | On |
| Email confirmation required | Yes |
| Custom SMTP | Off, by choice |
| Email rate limit | 2 per hour, project-wide |

The two redirect URLs are exactly what the app asks for. `authRedirectURL` in
[src/app.js](../src/app.js) computes `new URL('.', location.href)` with the
query and fragment stripped, which is the directory the app is served from: the
Pages subpath in production, and the dev server root on `PORT` 4173. Nothing
else needs to be on the allow list: the Android app signs in with Google
natively and never redirects (see below).

## Email delivery

Auth email goes through Supabase's built-in service. No provider account, no
sending domain, and no SPF, DKIM or DMARC records are involved, so there is no
SMTP credential and no DNS zone to own for this project.

Two consequences follow, and both are worth knowing before opening sign-up:

**The whole project can send two emails per hour.** That is a project-wide
ceiling, not a per-user one. Sign-up confirmation, password recovery and email
change all draw on it. A third person signing up inside the same hour gets no
email and cannot confirm their address. The dashboard field is fixed at 2 and
only becomes editable once custom SMTP is enabled.

**The templates cannot be edited.** Supabase only unlocks subject and body
editing for projects on custom SMTP. The default templates are in use, and their
links resolve through the project's verify endpoint to the Site URL above, which
is why setting that value correctly is what makes confirmation work.

Supabase documents the built-in service as intended for testing, with no
delivery guarantee, sent from a shared address. That is an acceptable trade for
a private beta with a handful of known testers. Revisit it when any of these
becomes true:

- More than two people are likely to sign up or reset a password in one hour.
- Confirmation mail starts landing in spam for testers.
- The app needs its own sender identity.

The fix at that point is a transactional provider, a verified sending domain,
the three DNS records, and custom SMTP. Record the provider, the domain, the
DNS-zone owner, and where the SMTP secret is stored in the table below when that
happens. Never the secret itself.

| Field | Value |
| --- | --- |
| Provider | Supabase built-in |
| Sending domain | None |
| DNS-zone owner | Not applicable |
| SMTP secret owner | No secret exists |
| Template owner | Supabase defaults, not editable |

## Verified against the live project

These were checked against `https://kknbyhlwmuzttyxyuffe.supabase.co` with the
publishable key alone, which is the position an attacker starts from:

- Reading `public.tasks` is refused with SQLSTATE `42501`, permission denied.
- All four sync functions are refused with `42501`. None is reachable without a
  signed-in token.
- The `private` schema is not exposed through the REST layer at all. Only
  `public` and `graphql_public` are.

Together those show that no data and no write path is reachable without
authentication, and that the tables holding devices, receipts, change history
and conflicts are not addressable from the internet at any privilege level.

## Still needs a person with a real inbox

Signing up, receiving mail and clicking a confirmation link cannot be automated
here. Run these with two disposable accounts, A and B, and mind the two-per-hour
ceiling: spread the email-sending steps across separate hours or they will fail
for the wrong reason.

1. Sign up as A. Confirm from the email. Check the link returns to the Pages URL
   and the session is live.
2. Sign in, reload, sign out, sign back in.
3. Request recovery for A. Follow the link, set a new password. Then reuse the
   same link and confirm it is refused, and let one expire and confirm that too.
4. Resend a confirmation and confirm the rate-limit response is handled without
   leaking whether the address exists.
5. Create tasks as A while offline, then switch to B with that work still
   pending. No command of A's may upload as B.
6. Signed in as B, attempt to read A's tasks, blocks and sessions. Do it with
   raw REST and RPC calls carrying B's token, not only through the UI.
7. Let A's token expire while offline, then reconnect. Local work must survive
   and upload once the session refreshes.

Steps 5 to 7 are covered by `tests/two-client-acceptance.test.js` against a
reference server. Running them live is what proves the real project behaves the
same way.

## Google sign-in

Google project `nth-celerity-508422-r0`, consent screen **In production**.

**Web.** The "Lough'd In Web" OAuth client redirects through
`https://kknbyhlwmuzttyxyuffe.supabase.co/auth/v1/callback`, so Google's consent
page names that domain. A Supabase custom domain (paid add-on) is the fix, and
its callback must then be added to the client alongside the existing one.

**Android.** Google does not allow its sign-in page inside an app's WebView, so
the app uses `@capgo/capacitor-social-login`, which shows the system account
sheet (Credential Manager). The resulting ID token goes to
`supabase.auth.signInWithIdToken` with a nonce: Google receives the SHA-256 hex
digest and Supabase the raw value (`src/google-nonce.js`). There is no redirect
URL or deep link, and nothing was added to the allow list.

Credential Manager only answers apps it recognises. In the same Google project:

1. Create an OAuth client of type **Android** for package `ie.loughdin.app`
   with the SHA-1 of the release upload key. Get it with
   `keytool -list -v -keystore ~/.loughdin-release/loughdin-release.jks -alias loughdin`.
2. Add another Android client (or fingerprint) for every other key that signs
   an APK you test on a phone, such as Android Studio's local debug key, and
   Google Play's app-signing key if the app is published through Play.
3. Leave Supabase's Google provider as it is. The app passes the **Web** client
   ID as `webClientId`, so tokens are issued for the Web client that Supabase
   already lists first. Keep **Skip nonce check** off.

CI debug APKs are signed with a new throwaway key on every run, so Google
sign-in fails on them with `[28444] Developer console is not set up correctly`.
Test it on a release-signed APK or a local build whose key is registered.

On a physical device, test: first sign-in and consent, cancelling the sheet,
choosing between two Google accounts, signing out and back in, a device with
no Google account, a revoked grant (Google Account → Security → Third-party
access), process death during sign-in, and account switching with pending
guest work.
