# Lough'd In

A personal focus tool with the original Kerry landscape and glass-panel interface. Work and personal tasks, Pomodoro and Flow sessions, an Eisenhower matrix, and day/week scheduling share durable local state.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:4173. For a production artifact:

```sh
npm run check
npm run build
npm test
```

`dist/` contains only the app shell, public configuration and bundled client libraries. Serve it over HTTPS (or localhost). GitHub Pages supports the repository subpath.

## Data and cloud

Local writes use IndexedDB transactions; task changes and their sync commands commit together. Existing `loughdin-v2` localStorage data migrates once and its raw backup is preserved. Backup export/import lives below the existing panels. Guest data stays separate from account data and uploads only when the user chooses **Import guest data**.

The public Supabase project configuration is in `src/config.js`. It contains a publishable key, which is intended for browser use; authorization is enforced by RLS and authenticated mutation RPCs. Never put service-role keys in this file.

Sign in or create an account through **Account & sync**. New email accounts require confirmation. Hosted mail is initially limited to the provider's default sending restrictions; general public onboarding requires configured SMTP or an OAuth provider. Configure the app's deployed URL and allowed callbacks in Supabase before release. No real authentication test or public deployment is implied by a successful local test.

See [the sync contract](docs/SYNC.md) for commands, receipts, conflicts and database verification. See [the implementation checklist](docs/BLUEPRINT.md) for completed gates and remaining work, including active-timer ownership across devices, native storage and release testing.

See [the production Auth and SMTP runbook](docs/AUTH-SMTP-RUNBOOK.md) for exact callbacks, browser isolation tests, Android deep-link TODOs, and provider/DNS/secret ownership fields.

## Development scope

The existing HTML/CSS layout and bundled scenery are intentionally retained. Application logic now lives in tested modules rather than the original inline script. The Android shell uses the same interface. A countdown redraw never writes to the network; session transitions persist, while completed focus records feed statistics.

A running timer is currently local to its device. Tasks, time blocks and recorded focus sessions are the sync scope; live timer takeover remains an explicit blueprint item.
