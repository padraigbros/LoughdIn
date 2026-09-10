# Lough’d In — product vision and architectural blueprint

Prepared 8 September 2026. Scope: personal focus and task management on web and Android, with free self-serve onboarding and durable offline use.


## Implementation progress — 9 September 2026

This checklist tracks verified implementation in `app/` on branch `codex/reliable-focus-foundation`. The audit below remains a record of the original commit, not the current code. The rejected prototype is not being used. The original HTML/CSS layout and bundled Kerry scenes remain the starting point.

Architecture adjustment following UI feedback: preserve the existing web interface with JavaScript modules and a Capacitor Android shell. This supersedes the proposed React/Expo UI rewrite. Native SQLite, secure credential storage, live timer ownership and device reliability must still meet their own acceptance gates; packaging alone does not complete them.

- [x] Clone the real source and isolate implementation on a dedicated branch.
- [x] Transactional IndexedDB persistence, account namespaces, cross-tab writes and atomic outbox rollback — automated tests pass.
- [x] Preserve and migrate legacy tasks/settings, map IDs to UUIDs, retain raw legacy backup and aggregate history — automated tests pass.
- [x] Deadline-based Pomodoro/Flow transitions, reload recovery, partial-session accounting, completion deduplication and bounded automatic cycling — automated tests pass.
- [x] Correct date-based daily/weekly calculations and planner midnight/DST/overlap regressions — automated tests pass.
- [x] Scope-relative PWA cache/manifest and allowlisted Pages build — automated tests pass.
- [x] Connect to the user-created Supabase project `kknbyhlwmuzttyxyuffe`; healthy project and public publishable key verified.
- [ ] Apply and verify database migration, RLS, mutation receipts, field conflicts and snapshot protocol.
- [ ] Complete and fault-test the sync client, explicit guest import and conflict resolution UI.
- [ ] Verify existing-screen integration, keyboard task controls, matrix and daily/weekly drag scheduling in a real browser.
- [ ] Configure and exercise real sign-in, confirmation redirects/SMTP or OAuth, account switching and two-client convergence.
- [ ] Build Android APK; verify local persistence, secure auth storage, reminders and lifecycle behavior on a device.
- [ ] Cross-device active timer ownership/takeover and conflict-safe shared timer state.
- [ ] Native SQLite adapter and alarm-intent recovery across reboot/process death.
- [ ] Release signing, published APK checksum, production web deployment and rollback rehearsal.
- [ ] Quota/load measurements, backup/restore exercise and free-tier launch acceptance.

Current verification limit: the computer-use browser launcher is failing before it starts. Node tests and Supabase tools work; visual checks and dashboard-only auth configuration are still pending. Items remain unchecked until their acceptance evidence exists.

## Evidence and review status

**Reviewed repository:** `padraigbros/LoughdIn`, branch `master`, initial commit [`e0e22c100ed39ca839f61157c762ed8d2c448085`](https://github.com/padraigbros/LoughdIn/commit/e0e22c100ed39ca839f61157c762ed8d2c448085). Repository access initially failed, then succeeded after the owner made it public. The final recommendations incorporate the source review rather than assuming an existing framework.

Read: the complete architectural brief, full HTML/CSS/JavaScript application, service worker, manifest, deployment workflow and complete recursive file tree. Checked: branch list (only `master`) and Actions history (zero runs returned). Ran: original app locally in a browser, task creation and reload checks, and seven isolated defect reproductions against original functions. The reproduction harness stubs DOM and timer scheduling; it is not a native-device test. Verified current vendor documentation and published free-tier limits.

Not performed: production deployment, authenticated backend testing (there is no backend in this commit), APK build/device testing (there is no Android project), external music-stream verification, live paid AI requests, or a complete accessibility/performance certification. No remote source changes were made. Local source snapshots and the audit harness are in `review-source/`.

## Current architecture audit

### What exists and what is worth keeping

The current app is a roughly 42 KB, 416-line standalone HTML file with inline CSS and JavaScript, three bundled SVG landscapes, work/personal task lists, priority colors, task-linked Pomodoro counts, configurable 20/5/15-minute intervals, optional automatic cycling, a Zen screen, radio streams and local statistics. Its persistence is a single `localStorage` document, `loughdin-v2`. A small service worker and web manifest aim to make it installable; a GitHub Actions workflow aims to publish it to Pages.

There is **no application framework, package manifest, lockfile, test suite, backend, auth flow, database schema, sync service, calendar, Eisenhower grid, or native Android build project** in the reviewed tree. Work/personal tabs and high/medium/low priorities are useful existing features, but do not implement the matrix or time-blocking requirements. A PWA manifest is not an APK build pipeline.

Keep the Kerry/Lough Guitane identity, bundled landscapes, immediate task entry, task-to-timer association and optional quiet mode. These give the product more character than a generic productivity dashboard. Task text is escaped before HTML rendering in `esc()`/`rTasks()`; that is a useful existing protection. The static application shell is lightweight and has no framework dependency supply chain to unwind.

The architectural assessment is: **a promising personal prototype whose durability and timer semantics need repair before cross-device features are added.** More UI alone will not solve its current loss-of-state problems.

### Findings ranked by consequence

P1 means fix before relying on the application for durable focus/task records. P2 means a concrete functional or accessibility defect. Requirement gaps are listed separately below; they are not presented as vulnerabilities in features that do not exist.

| Priority | Finding and trigger | Impact | Evidence |
|---|---|---|---|
| **P1** | Storage errors are silently swallowed. `STORE.set()` catches every exception and returns normally; callers update the visible UI first. | Quota/blocked-storage failures look successful, then tasks disappear on reload. | [`index.html:262–264`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L262-L264), [`addTask():366`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L366). Reproduced with a throwing storage adapter. |
| **P1** | Two open tabs each retain a private in-memory copy and overwrite the whole stored document. There is no storage-event reconciliation or transaction/version check. | A later write from a stale tab silently removes tasks created in the other. | [`save():402`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L402). Reproduced with two isolated app instances sharing storage. |
| **P1** | Active timer state, mode and selected task are never persisted. Reload while a short break is running. | App returns to stopped 20:00 focus and forgets the selected task; partially elapsed focus is not reliably saved either. | [`timer state:313–316`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L313-L316), [`save/load:402–409`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L402-L409). Reproduced in both browser and harness. |
| **P1** | Elapsed time is measured by counting `setInterval` callbacks (`tl--`, `fSec++`). | Suspended/throttled browser execution delays completion and undercounts time. A native wrapper does not fix the underlying algorithm. | [`tick/startStop:322–324`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L322-L324). Static finding; real-device background timing not benchmarked. |
| **P1** | Completed timer remains at zero. Press Start again without Reset or changing mode. | Next tick decrements to −1 and records another Pomodoro immediately, corrupting task/session totals. | [`tick/startStop:322–324`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L322-L324). Reproduced: Pomodoro count 1 → 2 in one tick. |
| **P1** | The service worker caches `/`, `/index.html` and `/manifest.json`; manifest start/icon URLs are also origin-root paths. | At the intended `/LoughdIn/` Pages path, it requests the wrong shell/icons and starts outside the app. A missing cache asset can reject installation; network responses are not added for later offline use. | [`sw.js:1–6`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/sw.js#L1-L6), [`manifest.json`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/manifest.json#L5-L13). Conditional on project-path hosting, as the workflow intends. |
| **P2** | Deploy workflow only triggers on pushes to `main`; the repository’s sole branch is `master`. | Pushing the existing branch does not run the deployment. Actions history returned no runs. | [`deploy.yml:3–5`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/.github/workflows/deploy.yml#L3-L5), verified branch metadata. |
| **P2** | Auto-cycle schedules `setTimeout(startStop,1200)` without retaining/cancelling its handle. Reset, manual start or mode change during that delay still receives the queued toggle. | Timer restarts after Reset, or a manually started timer is unexpectedly paused. | [`tick:322`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L322), [`reset:325`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L325). Reset/restart case reproduced. |
| **P2** | Completed sessions always write `wk[6]`, but the graph has fixed Monday–Sunday labels and highlights the actual weekday. Reload after several absent days shifts the array only once; midnight rollover only occurs on load. | Weekly activity is shown on the wrong day, older data survives incorrectly, and an open app can keep yesterday’s daily totals. | [`tick:322`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L322), [`rHeat:328`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L328), [`load:403`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L403). Index-6 write reproduced. |
| **P2** | Scene generation calls Anthropic directly with only a content-type header, without API authentication/version headers. Entering Zen also triggers it automatically. | Standalone deployment cannot authenticate this request; errors quietly restore the scene label. Adding a private key to the browser would create a credential exposure. | [`genScene:307`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L307), [`Zen:336`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L336). Static request inspection; no paid requests sent. |
| **P2** | Generated SVG is inserted as `innerHTML` after a regular-expression extraction, without sanitization or an isolated renderer. | If the generation path is made operational, model-returned event attributes/external references become an injection boundary in the same origin as tasks and future auth tokens. This is a latent risk, not a demonstrated current remote exploit. | [`renderScenes:305`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L305), [`genScene:307`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L307). |
| **P2** | Task completion is a clickable `div`, activation a `span`/row click, and reordering is drag-only. Priority is represented by border color after creation. | Essential actions lack native keyboard semantics and accessible state; reordering has no keyboard/touch fallback. | [`task markup/events:355–362`](https://github.com/padraigbros/LoughdIn/blob/e0e22c100ed39ca839f61157c762ed8d2c448085/index.html#L355-L362). Browser accessibility tree exposes the text but no checkbox for completion. |

Related lower-priority issues: editing the active task refreshes its list row but not `rAStrip()`; the focus caption keeps the old text until another action refreshes it. `sStats()` rebuilds the heatmap every timer second, even when its values have not changed. Settings labels are not associated with their range controls. Several text/control sizes fall to 8–11px, and no reduced-motion rule is present. These are source observations, not measured claims of a specific WCAG contrast ratio or performance regression.

Fix the timer with a persisted, explicit state machine and idempotent transitions. Fix storage with a transactional local database, durable commands and surfaced write failures. Fix the weekly display with date-keyed event aggregates, not another array-index patch. For the existing PWA, use relative manifest paths (`./`, `./icons/...`), scope-relative precache URLs, a namespaced cache prefix, and delete only caches owned by this application. The current activation handler deletes every differently named cache on the origin, which can affect other projects sharing a Pages origin. Include icons in the app shell and test a cold offline launch at the actual deployment subpath.

Use bundled/pre-rendered scenery for the core product. If dynamic generation later earns its place, put credentials and rate limits on an authenticated server endpoint, validate the result and render it in a constrained image/isolated context. The request’s missing headers and the injection boundary are different issues. [Anthropic API requirements](https://platform.claude.com/docs/en/api/overview), [MDN on innerHTML injection](https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML), [browser timer delays](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#reasons_for_delays_longer_than_specified).

### Required capability gaps

| Requirement | Current state | Architectural addition |
|---|---|---|
| Same tasks on web and APK | Origin-local JSON only; no user identity or server. | Authenticated ownership, local databases, command sync and native build. |
| Durable offline work | Task JSON survives ordinary same-browser reload, but save errors and multi-tab overwrites are unhandled; shell paths are incorrect for project hosting. | Local transactions, migrations, outbox, cache repair and recovery UI. |
| Pomodoro and Flow | Pomodoro intervals exist; no Flow mode, durable active session or immutable logs. | Shared timer state machine, deadline accounting, session/event schema. |
| Eisenhower matrix | High/medium/low color and Work/Personal categories only. | Explicit urgency/importance classification, matrix view and accessible move command. |
| Calendar/time blocks | Absent. | Linked block entity, interval validation, day/week planner and DST semantics. |
| Cross-user security | No accounts/backend to isolate today. | RLS, owner foreign keys, authenticated RPC authorization and account-scoped caches. |
| Native Android reliability | Manifest only; no Android project, alarms or push pipeline. | Expo native build, SecureStore, SQLite, native notification/alarm adapter. |

### Migration from this exact prototype

1. **Protect existing local data before changing origins.** Provide a versioned JSON export/import on the old site. Browser storage is origin-scoped: moving from Pages to Cloudflare cannot directly read the old origin’s `loughdin-v2`. A new Android app cannot simply inherit that browser database either. Keep export available during the migration.
2. Import Work/Personal as task categories, preserve priority, completion and text, and map `(legacy list, legacy id)` to a fresh UUID. Preserve the original export unchanged for recovery. `nId` is local and can collide across devices; it is not a sync identity.
3. Leave new quadrant values unclassified: high priority does not prove urgency or importance. Do not fabricate historical focus sessions from `pom`, `fSec` or the unreliable `wk` array. Preserve them as explicitly labelled legacy aggregates with their limitations.
4. First extract storage, timer and task commands from the monolith while preserving its working UI. Add the database/outbox contract, then introduce React views. The existing SVG landscapes can remain assets; they do not require a generative service.
5. Deliver one authenticated task shared between web and a physical Android build before investing in the full calendar. Replace the timer implementation as a unit rather than accumulating lifecycle flags around `setInterval`.

The requested Expo/Flutter/TWA comparison follows below. **Capacitor is also worth a short proof of concept given this existing DOM app:** it could reuse more HTML while adding native plugins. I still recommend Expo for the stated long-term native interaction goals, but do not reject Capacitor without a measured alarm/storage/accessibility spike if minimizing UI migration is the overriding priority. This is an additional candidate, not a claim that TWA itself supplies native alarm access. [Capacitor runtime](https://capacitorjs.com/docs), [native local notifications](https://capacitorjs.com/docs/apis/local-notifications).

## Product direction: protect the next meaningful hour

The core promise should be: **“Know what matters. Give it time. Stay with it.”**

A timer, matrix, and calendar become useful when they operate on the same task and lead naturally into one another. Make that continuity the product’s defining quality.

1. **Capture:** add an unfinished thought in one field, without mandatory prioritization or signup. Save locally immediately. Offer account creation when the user wants another device.
2. **Decide:** classify importance and urgency. An unclassified inbox remains distinct from “neither urgent nor important.” Ask for the next concrete action, not an elaborate project hierarchy.
3. **Plan:** put the task into a real available interval. Show estimated effort and available time. A task may need several blocks; scheduling it does not complete it.
4. **Focus:** enter a quiet surface containing the task, its first step, timer, pause/end, and a small distraction capture action. Keep a scratchpad reachable without opening the backlog.
5. **Return:** record what happened, save a short restart note, and offer the next block. A partial session is useful information; a missed day does not incur a penalty.

### Information architecture and visual design

Use **Today, Decide, Plan, Review**. Today is the default, with one nominated task, a short realistic agenda, and quick capture. Decide contains the Eisenhower grid. Plan opens day or week scheduling. Review is a restrained record of time spent and unfinished work.

The visual direction extends the existing identity: quiet lake greens, mineral neutrals, generous spacing, crisp text, and a restrained serif accent for the current intention. Keep the existing Kerry landscape as an optional focus backdrop; use calmer opaque surfaces for dense planning. Support light and dark appearance with the same hierarchy. Reserve strong color for the current action; quadrant meaning must also be written out. No decorative analytics wall on the home screen.

On desktop, Today can show the next focus block beside a narrow agenda. In focus mode, remove secondary navigation and agenda. On Android, use a single column, reachable primary action, and day agenda; the week grid is optional. Never shrink a seven-column desktop calendar onto a phone.

Required interaction details:

- Matrix drag writes one classification command. Also provide “Move to…” and keyboard actions. Use labels “Do first,” “Make time,” “Handle briefly,” and “Let go,” alongside precise urgency/importance descriptions. “Handle briefly” does not imply a delegation feature in a personal tool.
- Calendar desktop drag supports move and resize, a ghost preview, five-minute snap, Escape to cancel, and Undo after save. The phone path is tap task → choose available time → confirm; long-press drag is an accelerator.
- Suggested 25/5/15-minute Pomodoro defaults are editable. Offer 50-minute focus and untimed Flow. Avoid forcing every user into a fixed cadence.
- Default to an automatic break after a focus interval and explicit confirmation before another work interval. Full automatic cycling is an opt-in with a finite cycle count.
- Present sync precisely: “Saved on this device,” “Up to date,” or “Changes need attention.” An offline badge must not interrupt focus. Never show “Synced” merely because a WebSocket is connected.
- Account creation offers “Bring these tasks into my account” with a count. Import with stable operation IDs so a retry cannot duplicate the inbox.
- Reduce motion, visible focus indicators, screen-reader labels, comfortable touch targets, and no color-only status are release requirements. Do not announce the timer every second to assistive technology.

Useful differentiators after the foundation: **restart notes**, a **distraction inbox** that does not abandon the session, and **schedule repair** that previews where unfinished blocks could move. Schedule repair must respect existing appointments, duration, available hours, and locked blocks; never silently rearrange the day. Begin with deterministic rules and local calculations. Paid AI services are unnecessary for the core promise.

Success criteria: time from opening to starting intended work; recovery of unsynced changes after restart; trustworthy session continuity; and whether planned meaningful tasks received time. These are product measures, not a reason to collect task contents or pressure people with streaks.

## Stage 1 — infrastructure evaluation

### Backend comparison

The free-tier figures below are published limits verified on the preparation date, not capacity promises. Actual longevity depends on active devices, retained data, connection fan-out, and query patterns.

| Option | Free tier and longevity | Durable offline behavior | Developer experience | Calendar/matrix data | Lock-in and operational risk |
|---|---|---|---|---|---|
| **Supabase / Postgres** | 500 MB database, 50,000 MAU, 5 GB egress; inactive free projects pause after a week. Database size and realtime connections can constrain this tool before auth MAU. | Realtime is not a local database or durable outbox. Add IndexedDB/SQLite and a sync protocol, or evaluate a separate sync service and its cost. | SQL, constraints, migrations, RLS, auth, RPCs. More initial sync engineering. | Best fit: relations, range overlap constraints, joins, historical reports. | Portable SQL/data; auth, realtime, and custom RPC integration still create migration work. |
| **Firebase / Firestore** | Standard free quota: 1 GiB, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, 10 GiB egress/month. Listener reads and reconnects matter. | Strongest built-in option here: persistent SDK cache and queued writes on supported web/native platforms. Cache covers fetched data; same-document changes use last-write-wins semantics. | Fast path to an offline CRUD MVP; security rules and denormalization require discipline. | Matrix queries are straightforward. Task/block joins and arbitrary overlap exclusion are harder; cached checks cannot enforce a global invariant. | SDK, security rules, indexes, data model and functions create meaningful coupling. |
| **Convex** | Free resources include 0.5 GB DB and 1M function calls; distinguish the capped Free plan from pay-as-you-go Starter. Reactive query cost depends on subscription behavior. | Officially does not provide full durable offline sync. Reconnect handling and optimistic mutations do not establish persistence across process death. | Excellent typed reactive functions and server transactions. | Document model supports indexed application queries, but relational integrity and interval policy are application concerns. | Functions and reactive query model couple application behavior to the platform; self-hosting does not remove that work. |
| **PocketBase / self-hosted** | Software is free; no first-party managed free hosting. A persistent server, backups, upgrades, delivery of auth emails, and recovery are your responsibility. | Realtime events do not provide a durable mobile outbox or merge protocol. | Compact Go/SQLite deployment, integrated auth and admin interface. | Relations supported; advanced scheduling invariants may require server hooks/custom SQL and careful migrations. | Portable binary and SQLite data; application hooks and API semantics still need migration. Operational ownership is the major tradeoff. |

Sources: [Supabase pricing](https://supabase.com/pricing), [Firestore billing](https://firebase.google.com/docs/firestore/pricing), [Firestore offline persistence](https://firebase.google.com/docs/firestore/manage-data/enable-offline), [Convex pricing](https://www.convex.dev/pricing), [Convex offline limitations](https://www.convex.dev/sync), [PocketBase hosting FAQ](https://pocketbase.io/faq/), [PocketBase production guidance](https://pocketbase.io/docs/going-to-production/).

**Decision: Supabase**, because scheduling integrity, linked task/session history, explicit conflict handling, and ownership constraints justify Postgres. This is not the cheapest implementation in engineering time. If access reveals an established Firestore application with good offline behavior, retain it until a measured limitation outweighs a migration. If the brief were only offline checklists and a simple timer, Firestore would be the faster default.

Firestore transactions require connectivity; durable queued writes do not by themselves provide transactional offline conflict resolution. Enforcing arbitrary interval exclusion would need server arbitration or a discrete-slot reservation model. Cloud Functions deployment requires a billing-enabled project even when usage stays within allowances; do not describe that as the same operating model as an unbilled Spark app. [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [Firebase pricing](https://firebase.google.com/pricing).

### Runtime comparison

| Runtime | Sharing and web quality | Drag and touch | Local storage | Timers and notifications | Verdict |
|---|---|---|---|---|---|
| **React Native + Expo** | Share TypeScript domain logic, schemas, sync, timer reducer and design tokens. Use React DOM for the rich web planner and native components for Android. Do not promise an unmeasured sharing percentage. | DOM pointer/keyboard interaction on web; native gesture handler and animated native views on mobile. Same commands underneath. | Expo SQLite on Android; IndexedDB/Dexie on web. WatermelonDB is an alternative requiring its own sync backend. | Native notifications and alarm integration are possible through a development/release build and, where needed, a small native module. OS restrictions still apply. | **Recommended** balance for this brief. |
| **Flutter** | Strong shared Dart UI and logic across mobile and app-like web. Browser semantics, startup budget and accessibility must be measured. | Good native gesture composition; drag target APIs suit both methods. | SQLite with an appropriate adapter/ORM for relations; Hive-style key/value storage is a less natural fit for scheduling joins. Web storage adapters differ. | Native plugin or platform-channel alarm integration; same Android restrictions as Expo. | Credible if the repository already uses Flutter or Dart is preferred. No justified rewrite without evidence. |
| **PWA + TWA** | Greatest web UI reuse; one DOM application and an Android wrapper with verified site association. | Excellent desktop web interaction; phone touch still needs dedicated design. | IndexedDB and service-worker app-shell caching; browser eviction and storage availability must be handled. | A TWA does not convert browser JavaScript into a reliable native background timer. Native alarm behavior needs additional native integration and a state bridge. | Good distribution shortcut if reminders are best effort; insufficient as the sole answer to this brief’s timer reliability requirements. |

Flutter describes its web support as suited to application experiences. A TWA displays web content through a supporting browser. Expo SQLite’s documented web support remains alpha in the reviewed SDK 55 page; verify the chosen SDK before adoption. Separate adapters avoid making that experimental path foundational. [Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq), [TWA overview](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities), [Expo SQLite](https://docs.expo.dev/versions/v55.0.0/sdk/sqlite/), [WatermelonDB sync backend contract](https://watermelondb.dev/docs/Sync/Backend).

### Definitive proposed stack

| Layer | Selection |
|---|---|
| Web | React + TypeScript + Vite; DOM-based planner; service worker for versioned application shell. |
| Android | React Native + Expo development/release builds; Expo Router; small Kotlin alarm adapter if required by reliability tests. |
| Shared packages | Domain commands, validation, timer state machine, sync protocol, schedule calculations, design tokens. |
| Local database | Dexie/IndexedDB on web, Expo SQLite on Android; same repository/transaction interfaces and conformance tests. |
| Server | Supabase Postgres; versioned SQL migrations; authenticated transactional RPCs. |
| Auth | Supabase Auth, Google OAuth for zero-email-cost initial public onboarding; email/password and magic links with configured SMTP. |
| Sync | Local transactional outbox, server operation receipts, grouped-field optimistic concurrency, durable change log and cursor; realtime invalidation triggers catch-up. |
| Web hosting | Static Cloudflare Pages free tier and provider subdomain initially. No always-on Node server required. |
| Build/distribution | Signed EAS APK for direct installation; AAB only when publishing through Play. Native Gradle builds remain an alternative. |

This deliberately shares behavior while allowing each platform to handle interaction, storage, credentials and alarms appropriately. A query cache such as TanStack Query is not the durable application database. Zustand or React state should contain transient UI, not the only copy of tasks.

Suggested package boundaries:

```text
apps/web                 React DOM views, service worker, web auth
apps/android             Expo views, SecureStore, native alarms
packages/domain          entities, commands, validation, interval rules
packages/focus-engine    pure reducer, clock interfaces, session accounting
packages/sync            outbox, receipts, rebasing, protocol versions
packages/storage-web     IndexedDB adapter and migrations
packages/storage-native  SQLite adapter and migrations
packages/design          tokens and interaction specifications
supabase/migrations      schema, permissions, RPCs, indexes
tests/contracts          shared storage/sync behavior fixtures
```

### Making the zero-baseline-cost requirement honest

Google OAuth + static provider-domain hosting + Supabase Free + direct APK distribution can avoid mandatory recurring hosting charges within quotas. Public email signup needs a mail delivery arrangement: Supabase’s default SMTP serves authorized project-team addresses and is unsuitable for public onboarding. Configure a provider, delivery limits and a verified sending domain before advertising email/password recovery or magic links. Do not silently disable verification to work around delivery. [Supabase SMTP restrictions](https://supabase.com/docs/guides/auth/auth-smtp).

Free hosting does not promise indefinite free operation, backups, or an uptime SLA. Track database/index size, egress and connections. Supabase Free permits 200 concurrent realtime connections and 100 messages/second; 100 people with two connected devices can reach the connection limit. [Realtime limits](https://supabase.com/docs/guides/realtime/limits).

Cloudflare Pages Free currently provides 500 builds/month, one concurrent build, and a 25 MiB maximum individual asset. Distribute APKs through a suitable release/download service rather than assuming a large APK fits a Pages asset. Expo Free currently includes up to 15 Android builds in its monthly allocation, with a low-priority queue. App signing is required; Play publication has a separate one-time registration fee, while direct APK installation does not require Play registration. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Expo pricing](https://expo.dev/pricing), [Expo build setup](https://docs.expo.dev/build/setup/).

Example workload assumptions, not measurements: 100 daily users × 8 sessions × 4 transitions = 3,200 session commands/day. Add 30 edits/user/day for 6,200 commands before receipts, change-log rows, reads, retries and delivery overhead. Writing once per second for 8 × 25-minute sessions would instead generate 12,000 timer writes per person/day. Persist transitions only.

Model storage with measured index-inclusive row sizes: `daily growth = entity growth + receipts + change log + conflicts`. Measure `pg_total_relation_size`, not JSON size. Alert at proposed 60/80/90% quota thresholds, with an explicit retention and upgrade decision at 80%. These thresholds are operational choices. Disconnect background listeners, share a connection across web tabs where practical, and pull on resume. Never drop unsynced work to protect a quota.

## Stage 2 — data and synchronization architecture

### Entity semantics

Tasks are intentions; blocks reserve time; sessions record activity. They have separate lifecycles. Moving a block changes neither priority nor task deadline. Completing a timer never automatically claims a task is finished.

Use random UUIDs generated on the device; order using server revisions, not UUID timestamps. Represent instants in UTC and retain an IANA zone such as `Europe/Dublin`. Store an all-day due date separately from a due instant if that feature is introduced. Priority is an optional rank independent of quadrant. Store one quadrant value rather than redundant urgency/importance booleans.

The following SQL is a **schema design excerpt, not an applied or production-complete migration**. RPCs, protocol validation, retention, complete policies and database tests must be implemented before exposing writes.

```sql
create extension if not exists btree_gist;

create type public.task_status as enum ('inbox','ready','done','cancelled');
create type public.quadrant as enum (
  'urgent_important', 'not_urgent_important',
  'urgent_not_important', 'not_urgent_not_important'
);

create table public.tasks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  title text not null check (length(trim(title)) between 1 and 300),
  details text not null default '' check (length(details) <= 20000),
  status public.task_status not null default 'inbox',
  quadrant public.quadrant, -- null = not classified
  priority smallint not null default 2 check (priority between 0 and 3),
  estimate_minutes integer check (estimate_minutes between 1 and 10080),
  next_action text not null default '' check (length(next_action) <= 1000),
  revision bigint not null default 0 check (revision >= 0),
  field_revisions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);

create table public.time_blocks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  task_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null,
  color_key text not null default 'lake'
    check (color_key in ('lake','clay','heather','neutral')),
  status text not null default 'confirmed'
    check (status in ('draft','confirmed','cancelled')),
  revision bigint not null default 0 check (revision >= 0),
  field_revisions jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  primary key (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  exclude using gist (
    owner_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (deleted_at is null and status = 'confirmed')
);

create table public.focus_sessions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  task_id uuid,
  block_id uuid,
  mode text not null check (mode in ('pomodoro','flow')),
  state text not null check (state in ('running','paused','ended')),
  owner_device_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  phase text not null check (phase in ('focus','short_break','long_break')),
  phase_index integer not null default 0 check (phase_index >= 0),
  phase_started_at timestamptz not null,
  phase_deadline_at timestamptz,
  paused_remaining_ms bigint check (paused_remaining_ms >= 0),
  focus_ms bigint not null default 0 check (focus_ms >= 0),
  break_ms bigint not null default 0 check (break_ms >= 0),
  interruptions integer not null default 0 check (interruptions >= 0),
  completed_focus_cycles integer not null default 0,
  outcome text check (outcome in ('completed','partial','abandoned','needs_review')),
  ended_at timestamptz,
  config_snapshot jsonb not null,
  primary key (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id),
  foreign key (owner_id, block_id) references public.time_blocks(owner_id, id),
  check (completed_focus_cycles >= 0),
  check ((state = 'ended') = (ended_at is not null)),
  check ((state = 'ended') = (outcome is not null))
);

create unique index one_active_session_per_owner
  on public.focus_sessions(owner_id) where state in ('running','paused');

create table public.focus_events (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null, -- command/event idempotency key
  session_id uuid not null,
  device_id uuid not null,
  kind text not null check (kind in
    ('start','pause','resume','phase_end','interrupt','end','takeover','correct')),
  logical_key text not null, -- e.g. phase:3:end; unique semantic transition
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  elapsed_ms bigint check (elapsed_ms >= 0),
  payload jsonb not null default '{}'::jsonb,
  primary key (owner_id, id),
  unique (owner_id, session_id, logical_key),
  foreign key (owner_id, session_id)
    references public.focus_sessions(owner_id, id)
);

create index tasks_matrix on public.tasks(owner_id, quadrant, status)
  where deleted_at is null;
create index blocks_agenda on public.time_blocks(owner_id, starts_at)
  where deleted_at is null;
create index sessions_history on public.focus_sessions(owner_id, ended_at);
```

Use the range exclusion constraint for confirmed internal work blocks. Adjacent intervals are valid because ranges are half open. Draft conflict proposals do not reserve capacity. Imported external calendars, if later supported, may contain legitimate overlaps and need a different policy/table. Validate the IANA zone, JSON configuration shape, task/block consistency, state transitions and maximum payload sizes in RPCs; the excerpt’s JSON types alone are not validation. Postgres documents this range-exclusion pattern. [PostgreSQL range constraints](https://www.postgresql.org/docs/current/rangetypes.html).

Additional required persistence:

| Table | Key fields and purpose |
|---|---|
| `devices` | `(owner_id,id)`, platform, last_seen, revoked_at, acknowledged_cursor, supported_protocol; token registration stored privately. |
| `sync_heads` | `owner_id`, current sequence, minimum retained sequence, epoch; one row locked by every mutation. |
| `operation_receipts` | `(owner_id,op_id)`, device, canonical request hash, outcome, result revision, processed_at; duplicate requests return the original result. |
| `change_log` | `(owner_id,sequence)`, entity type/id, canonical row or tombstone, transaction group; server allocated and immutable. |
| `conflicts` | owner, operation, entity, base/proposed/current values, reason, status, resolved_by_op; private, durable and bounded by retention. |
| `notification_jobs` | owner, dedupe key, entity revision, target device, due_at, expiry, attempts, status; optional remote reminder delivery. |
| Local `outbox` | op_id, command payload, base group revisions, predecessor operation, attempt count, last error; persisted in the same transaction as UI projection. |
| Local `sync_metadata` | account/device namespace, cursor, epoch, schema version, hydration coverage and in-flight status. |

All server tables containing personal data need ownership policies or placement in an unexposed schema. Never publish push tokens or the full operation log through public realtime channels.

### Exact sync algorithm: durable commands with grouped-field concurrency

Use **optimistic local projection + transactional outbox + server-serialized commands + grouped-field revision checks + cursor-based catch-up**. This is not a CRDT. Task titles and single-user scheduling do not require a rich-text CRDT’s metadata and merge semantics.

Each UI command writes both the local projected row and an outbox entry atomically. The UI reads local storage. A network failure cannot erase a command that was acknowledged locally. Dexie provides transactions over IndexedDB; keep network requests outside those transactions. [Dexie transactions](https://dexie.org/docs/Dexie/Dexie.transaction()).

```ts
type Command = {
  protocol: 1;
  opId: string;
  deviceId: string;
  entityId: string;
  kind: 'task.edit' | 'task.classify' | 'block.move' | 'session.transition';
  baseGroups: Record<string, number>; // server-issued group revisions
  afterOpId?: string;                // local causal dependency
  payload: unknown;                  // validated by command-specific schema
};

// Conceptual algorithm; storage, validation and transport are adapter interfaces.
async function commitLocally(command: Command) {
  await local.transaction(async tx => {
    await tx.applyOptimistic(command);
    await tx.outbox.insert(command);
  });
  requestSync();
}

async function synchronize() {
  // A single sync worker per account/device; web tabs coordinate a leader.
  await pullAndRebase();
  for (const command of await outbox.readyInCausalOrder()) {
    const receipt = await rpc.applyCommand(command);
    await local.transaction(async tx => {
      await tx.applyReceipt(receipt);
      await tx.rebaseDependentCommands(command.opId, receipt);
      await tx.outbox.acknowledge(command.opId);
      await tx.reapplyRemainingOptimisticCommands();
    });
  }
  await pullAndRebase();
}
```

Server `applyCommand` executes in one database transaction:

1. Derive `owner_id` from the authenticated session. Validate protocol version, registered/non-revoked device, shape, length, allowed field names and bounded work. Never trust a submitted owner ID.
2. Lock that owner’s `sync_heads` row using `SELECT … FOR UPDATE`. Every mutation path, including cleanup that changes replicated data, must use this serialization rule.
3. Check the operation receipt. Matching ID and canonical request hash returns the saved outcome; same ID with a different payload is rejected. Check `afterOpId` belongs to the same owner/device causal chain and succeeded; unresolved dependencies remain pending.
4. Compare only the groups touched by the command. Suggested task groups: `title`, `details`, `classification` (quadrant + priority), `status`, `estimate`, `next_action`. Treat a block’s start/end/zone/task mapping as one `placement` group so merging cannot split interval endpoints.
5. For a same-group mismatch, retain the attempted values as a conflict and return `conflict`. Do not overwrite either side silently. For independent groups, apply the patch and retain all untouched current values.
6. Check ownership links, deletion state, schedule constraints and timer state/expected revision. Persist canonical changes, receipt and change-log entries; advance the owner sequence within the locked transaction.
7. Commit, then optionally notify connected devices that catch-up is available. Lost notification delivery is recovered by resume/reconnect pulls.

**Why the owner lock matters:** a bare SQL sequence is allocated before commit. Transaction A can allocate 41, transaction B commit 42, and a reader advance past A before A commits. A per-owner locked transactional counter prevents this gap for an owner’s stream when all writers obey the rule. UUIDs and `updated_at > last_sync` do not solve it.

**Dependent local edits:** if a user renames a task twice offline, the second command refers to the first. After the first is acknowledged, use its returned group revision to rebase the second before its first transmission. Once an operation has been sent, its ID and payload are immutable because it might have committed despite a lost response. A changed attempt needs a new operation ID and an explicit supersession relationship. If the first conflicts, quarantine that dependency chain for resolution while unrelated commands continue. Never fabricate new base revisions to force a conflicting change through.

**Pull contract:** return ordered full canonical rows/tombstones after cursor C and up to a captured committed high-watermark H. Use a bounded byte/record page size. Group multi-entity transactions so clients apply a complete group atomically; cap command fan-out or supply explicit chunks with a completion marker. Advance the durable cursor only with the local transaction applying the complete group. Do not advance it to H after reading only the first page.

Maintain a canonical local base separately from optimistic edits, or store sufficient undo/base data to rebuild the projection. A pull must not overwrite pending local edits. A reconnect runs pull, rebase, push, then pull; sockets are optional hints, not the source of truth.

**First load and stale cursors:** produce a consistent server snapshot and cursor H in one database snapshot. For a paged initial bootstrap, materialize an expiring owner-scoped snapshot or use an equivalent consistent snapshot mechanism; independent “current state” pages are not a consistent snapshot. Build new local base tables, replay pending commands, then swap atomically. Propose a 90-day incremental-sync window; older devices must rebootstrap, preserving their outbox. Expired operations are surfaced for review rather than blindly replayed after receipt retention expires. Never reuse deleted entity UUIDs, never upsert a missing entity as the side effect of an update, and reject stale epoch commands. This prevents deleted tasks returning from long-offline devices.

Retry transient errors with exponential backoff, jitter and a cap; honor `Retry-After`. A 401 pauses upload and prompts reauthentication without removing local work. Distinguish validation failures, conflicts, quota exhaustion and temporary connection loss. Persist a terminal receipt/conflict so a malformed command cannot block the entire queue forever.

### Required offline conflict outcomes

| Concurrent actions | Canonical result and UX |
|---|---|
| Mobile reschedules block; web changes linked task quadrant | Separate entities/groups; both changes survive. Calendar reads task classification through its task ID. |
| Web edits title; mobile changes quadrant | Independent groups merge. Neither client sends a full stale task replacement. |
| Two devices change the same title | First committed version remains current; second becomes a conflict showing both strings. User selects or edits a merged title. |
| Two devices move the same block | Placement group conflicts; preserve the second proposed interval and show both alternatives. |
| Different offline blocks claim the same slot | First accepted reservation wins. Second is a saved draft proposal with alternatives; no silent loss or automatic displacement. |
| Task is deleted while another device edits it | Tombstone wins over ordinary edits; retain recoverable proposed text. Restore requires an explicit new command/new identity where retention demands it. |
| Request commits but its response is lost | Retry with the identical op_id and payload; receipt returns the prior result without a duplicate event. |
| Two offline devices start timers | Both local sessions are provisional; reconcile to one canonical active session, preserving the other as a reviewable partial log. Do not double-count overlapping time. |

Task deletion must atomically cancel/tombstone future blocks and end or detach active focus according to a defined command policy. Preserve historical sessions with the soft-deleted task link. Final account deletion has a separate server-side purge path covering all owned data, tokens and pending delivery jobs.

### Authentication and tenant isolation

**Web:** use OAuth authorization code flow with PKCE and exact redirect allowlists. A static SPA with a persistent Supabase session uses browser-readable token storage, normally localStorage via its auth adapter. It is not protected by HttpOnly cookies. Apply a restrictive CSP, render task text without HTML interpretation, pin dependencies, avoid third-party scripts on authenticated routes, and prohibit tokens in logs. Provide a remembered-device option; use session-only credential storage on shared machines. IndexedDB remains readable by same-origin code, so storage choice does not cure XSS.

If the risk profile later requires HttpOnly refresh cookies, introduce a same-origin backend-for-frontend with Secure/SameSite cookies, CSRF protection and server token handling; this changes the static architecture and its deployment responsibilities. Do not claim a browser SDK can read an HttpOnly token.

**Android:** use system-browser PKCE and verified application links where available. Save credentials with Expo SecureStore, backed by Android Keystore encryption. Refresh on app resume and before upload; failure preserves the local outbox. Do not put tokens in SQLite or ordinary AsyncStorage. SecureStore protects credentials, not the whole task database; evaluate SQLCipher separately if stronger device-at-rest protection is required. Exclude sensitive database/token artifacts from inappropriate backups. [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).

**Email/password and magic link:** Supabase stores/verifies passwords. Configure production SMTP, anti-abuse rate limits, generic error responses and redirect allowlists. Magic links need a recoverable same-device PKCE flow or a properly implemented verification/deep-link route. Test opening in a different browser/device and link scanners; never depend on an unavailable local verifier. Password recovery must be functional before offering email/password publicly.

**Account switching:** stop subscriptions/sync workers, cancel account-specific notifications, remove credentials, and clear or lock that account’s local database. Never attach user A’s pending commands to user B. If logout would discard unsynced work, offer export or keep an explicitly locked local copy; do not block local use because tokens expired. A cached login does not authorize server access after revocation.

The following SQL illustrates the read boundary. Apply it to every appropriate tenant table; internal tables stay in an unexposed schema. Privileged mutation functions need their own explicit checks because `SECURITY DEFINER` may bypass RLS.

```sql
alter table public.tasks enable row level security;
create policy tasks_read_own on public.tasks
  for select to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.tasks from anon;
revoke insert, update, delete on public.tasks from authenticated;
grant select on public.tasks to authenticated;

-- Example function boundary only: implement the transaction algorithm above.
-- create function public.apply_command(command jsonb) returns jsonb
-- language plpgsql security definer set search_path = '' as $$ ... $$;
-- Inside: require auth.uid(); qualify every object; reject unexpected fields;
-- lock only that owner's head; check device and every referenced entity owner.
-- Then restrict execution on the real function:
-- revoke all on function public.apply_command(jsonb) from public, anon;
-- grant execute on function public.apply_command(jsonb) to authenticated;
```

RLS is not enough if a client can write revision metadata directly or bypass command processing. Revoke direct entity writes; restrict every RPC, storage bucket and realtime subscription; enforce composite owner foreign keys. Use an audited least-privileged function owner, fully qualified names and fixed empty search path. No client-supplied dynamic SQL identifiers. Service-role credentials and push sending credentials stay server-side. [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Ship tests with two real test identities: cross-owner read/write, forged owner/device ID, foreign task/block reference, outbox injection, unauthenticated RPC, change-log access and channel subscription. Test raw API requests in addition to UI flows. Redact task titles/details and credentials from telemetry. Backups and account export are separate from sync; a synchronized deletion is still a deletion.

## Focus engine, scheduling and notification contracts

### Timer correctness and continuity

Persist an absolute phase deadline plus pause state, accumulated active milliseconds, configuration snapshot, phase index, owner device and server revision. A screen interval merely asks for a redraw. It never decrements the authoritative remaining-time value or writes a heartbeat each second.

```ts
type Phase = 'focus' | 'short_break' | 'long_break';
type Timer = {
  state: 'running' | 'paused' | 'ended';
  mode: 'pomodoro' | 'flow';
  phase: Phase;
  phaseIndex: number;
  deadlineServerMs: number | null;
  pausedRemainingMs: number | null;
  completedFocusCycles: number;
  revision: number;
};

function remainingMs(timer: Timer, estimatedServerNowMs: number) {
  if (timer.state === 'ended') return 0;
  if (timer.state === 'paused') return timer.pausedRemainingMs;
  if (timer.mode === 'flow') return null; // elapsed-time presentation
  return Math.max(0, timer.deadlineServerMs! - estimatedServerNowMs);
}

// State-machine specification, not executable production code:
// START      -> running focus; persist + schedule phase boundary
// PAUSE      -> account elapsed active segment; save remaining; cancel alarm
// RESUME     -> new deadline = trustedNow + remaining; schedule alarm
// INTERRUPT  -> append one event; optionally PAUSE according to user intent
// PHASE_END  -> close phase once, keyed by (sessionId, phaseIndex, 'end')
//   focus -> short break; every N completed focuses -> long break
//   break -> await user start, unless finite auto-cycle mode enabled
// END        -> ended; partial/completed outcome; cancel alarm
// TAKEOVER   -> server compare-and-swap ownership + revision; reschedule
// EXPIRED WHILE CLOSED -> reconcile boundaries; ask about uncertain work
```

Freeze the chosen interval configuration for a running session; settings changes affect the next session unless the user explicitly changes this one. Focus totals exclude breaks and pauses. Flow has no implicit deadline; calculate elapsed active segments and allow a separately configured reminder. Count interruptions using idempotent events rather than concurrent read/modify/write counters.

**Clock skew:** an authenticated time endpoint captures server time near response transmission. Estimate offset against the client request/response midpoint; measure round-trip time and retain a low-latency sample plus uncertainty. Use a monotonic local anchor (`performance.now()` in a live browser, Android elapsed realtime in native code) so wall-clock edits cannot move a running countdown. On resume/restart, sample again if online. Persisted UTC deadlines provide recovery; a cold offline restart after a manual clock change has irreducible uncertainty, so mark it and preserve the log rather than fabricate precision. Native elapsed realtime needs a boot identity because it resets on reboot.

**Cross-device active state:** server permits one active canonical session per owner. Opening mobile pulls the active session, estimates server time, and shows its remaining interval without starting another. Timer commands include expected session revision and owner device; an explicit takeover serializes on the server. Finite lease expiry may permit recovery, but it cannot prove an offline device stopped running; do not hide this distributed-systems limitation behind a lease.

A network partition makes globally unique active execution impossible while allowing each device to start offline. Preserve local availability and label new offline sessions provisional. On reconciliation, retain both event histories, select the canonical active session via the server transaction, and ask the user which overlapping activity should count. Never count overlapping wall-clock intervals twice in aggregate focus totals without an explicit accounting policy.

If a tab sleeps through several automatic cycles, reconstruct phase boundaries from the saved configuration and timeline; deliver at most the current useful reminder. Mark unobserved intervals unconfirmed instead of reporting several hours as verified work. Catch-up work is bounded by the configured cycle limit. Web tabs elect one local leader using a browser lock/coordination channel; server event uniqueness remains the final protection.

### Time blocking

Represent ranges as `[start,end)`. Two blocks conflict precisely when `a.start < b.end && b.start < a.end`. Query a day/week with `starts_at < windowEnd && ends_at > windowStart`; filtering only by start time misses a block that began the previous day.

While dragging, compute the proposed local wall time from pointer position, snap to a five-minute grid, preserve duration for moves and enforce a configurable minimum duration for resizes. Render a ghost and validate against the locally available interval set. For sorted blocks, checking nearest neighbors is enough for an already non-overlapping schedule; an interval tree is appropriate only when scale or overlapping draft layers justify it. Do not write on each pointer move.

On drop, save an optimistic command. The server range constraint arbitrates concurrent accepted reservations. When it rejects a proposed placement, keep it as a draft with “Keep current,” “Use next available slot,” or “Choose time.” The proposed next slot scans the ordered reservations within user working hours and respects locked commitments. Do not truncate tasks, push them into the night, or rearrange other blocks without an explicit preview.

Store instant + IANA zone, never a fixed UTC offset alone. Existing one-off appointments keep their instant during travel and display in the chosen viewing zone. Future recurring “09:00 local time” blocks need a wall-time rule and zone; postpone recurrence until that distinction is implemented. During DST gaps, ask for the next valid time; during a repeated hour, choose explicitly between offsets. A day column must handle 23/25-hour days and repeated-hour labels rather than assuming 1,440 real minutes.

“Two-way task-to-calendar” means drag a task to create a linked block, reschedule from either the task detail or calendar, and reflect the same canonical relationship. It does not imply Google/Outlook calendar integration. If external two-way sync is desired later, add a separate connector with provider event IDs, ETags/sync tokens, recurrence handling, token refresh and echo-loop prevention. That scope has not been presumed.

### Native alarms and push delivery

Use local native scheduling for precise Android timer boundaries and already-known block reminders. JavaScript may be suspended; WorkManager is for deferrable reconciliation, not exact second-level timing. Android exact-alarm permission and notification permission are separate. Check actual capability before scheduling and offer an inexact fallback with accurate UX. Avoid requesting broad battery exemptions by default. [Android alarm scheduling](https://developer.android.com/develop/background-work/services/alarms?hl=en).

`expo-notifications` covers local notifications and remote push integration; Android remote push requires a development build rather than Expo Go in recent SDKs. A bounded Kotlin adapter may be needed for monotonic alarm scheduling, native boundary recording, permission inspection and reboot reconciliation; prove requirements on the selected SDK before committing to that work. [Expo notifications](https://docs.expo.dev/versions/latest/sdk/notifications/).

Pipeline:

1. Local transaction writes timer/block state plus a local scheduling intent. A worker schedules/cancels the native alarm using an ID derived from account, entity, revision and phase.
2. Process-death recovery replays scheduling intents idempotently. On alarm receipt, native code validates the persisted revision before notifying; stale pause/reschedule alarms are ignored. Record pending phase completion for the next sync.
3. On reboot, permission change, account change or app resume, rebuild upcoming alarms from persisted state. An Android force-stop is a stronger user action than OS process reclamation and can suppress delivery until the app is reopened; no architecture should promise otherwise.
4. A server notification outbox optionally covers web push and remotely created events. A scheduled server worker claims due rows, verifies current entity revision, sends via Web Push/FCM or Expo, retries transient delivery failures, prunes expired tokens, and suppresses expired reminders. Sign and authenticate worker calls. Do not schedule one server job per displayed timer second.
5. Sender retries mean delivery is at least once. Dedupe by session/phase/revision and destination; the local alarm is the timer’s primary Android channel. Remote timer push is unnecessary when a known local alarm is scheduled. A cancelled reminder can still appear on a disconnected device that has not received the change; reconcile on reconnect and avoid claiming instantaneous offline cancellation.

Web service workers handle push and cached application assets but are not permanent execution contexts. A closed offline browser cannot be promised an exact local reminder. Server push needs connectivity and OS delivery cooperation. Test ordinary process killing, Doze, reboot, denied permissions and force-stop separately. Record display accuracy and reminder delivery as different metrics.

## Stage 3 — implementation roadmap and acceptance gates

Effort ranges are planning estimates for one experienced engineer extending the reviewed prototype, including essential tests. Its existing visuals and task interactions reduce design discovery, but durable sync, calendar and native alarms are new work. A 7–11 week implementation range is an estimate, not a delivery commitment; custom sync and Android device behavior are the largest uncertainty. Favor vertical slices and avoid treating generated code volume as progress.

### Phase 1 — backend and data foundation (approximately 2–3 weeks)

1. Start from the reviewed commit and address the audit findings. Add legacy JSON export/import before an origin change. Repair deployment/PWA paths and preserve the existing task categories, settings and landscape assets. There is no existing backend or native client to migrate.
2. Write short decision records for stack, local storage, sync semantics, session ownership and free-tier limits. Bootstrap shared command schemas and protocol versioning.
3. Implement migrations, composite ownership links, interval constraint, private sync tables, read policies and transactional mutation/pull RPCs. Add privileged-call and raw-API isolation tests.
4. Deliver create/edit task → local persistence → sync → second client → offline edit → restart → reconnect. Both storage adapters should satisfy this slice before calendar polish.
5. Configure OAuth and guest import. Configure SMTP only when email flows are exposed. Add account-scoped local data and recoverable logout behavior.

**Exit:** no acknowledged local task is lost on restart; repeated commands apply once; two identities cannot access each other’s records; independent edits merge; same-field conflicts survive; snapshots and cursor pagination pass forced concurrency tests. Do not defer offline architecture until the APK phase.

### Phase 2 — web and core focus UI (approximately 2–3 weeks)

1. Implement Today, quick capture and next-action details on local queries. Add service-worker shell caching, update handling and storage-unavailable states.
2. Build matrix drag plus keyboard/menu equivalents; one classification transaction per drop. Include unclassified inbox and undo.
3. Build a day planner, then week view. Share placement commands between calendar and task details. Add touch-friendly scheduling forms before mobile drag polish.
4. Implement pure timer reducer with injectable monotonic/wall clocks. Add Pomodoro, breaks, Flow, pause/resume, interruptions and restart notes.
5. Add meaningful sync state and conflict resolution. Keep analytics secondary and derive totals from trusted session data.

**Exit:** keyboard-only user can capture, classify, schedule and start focus; browser reload/offline works after initial load; long titles and 320px width do not break layouts; DST fixtures pass; no network writes occur merely because the timer redraws or pointer moves.

### Phase 3 — Android and native reliability (approximately 2–3 weeks)

1. Build Expo development client and Android SQLite adapter; verify migrations, transaction failure recovery, account partitioning and outbox replay.
2. Implement native layouts with comfortable touch targets, quick add, day agenda and tap-to-schedule. Reuse domain logic, not desktop-specific drag code.
3. Integrate SecureStore and OAuth deep links. Verify real authentication recovery and account switching on a physical device.
4. Implement and test alarm intent recovery, permission-denied fallback, paused/rescheduled cancellation, reboot behavior and native transition queue. Add the Kotlin adapter only if needed by the proven reliability contract.
5. Produce a signed APK and retain the signing key securely. Use AAB for later Play release. Record runtime version and compatible protocol/database versions.

Example EAS configuration and commands (to apply within the future Android app, not commands executed during this review):

```json
{
  "build": {
    "development": {"developmentClient": true, "distribution": "internal"},
    "preview": {"distribution": "internal", "android": {"buildType": "apk"}},
    "production": {"android": {"buildType": "app-bundle"}}
  }
}
```

```powershell
npx expo-doctor
npx eas-cli build --platform android --profile preview
```

EAS normally produces AAB for store distribution; the preview profile explicitly selects APK. Pin tooling versions in the implementation’s lockfile/CI. A local Windows build can use Android SDK/JDK/Gradle; do not assume EAS `--local` has full Windows support. [Expo APK configuration](https://docs.expo.dev/build-reference/apk/).

**Exit:** installed signed APK works offline after process death; resumes web session without duplicate starts; a simulated network partition preserves both histories; supported Android reminder behavior is measured on at least a reference device and a second vendor device where available. Document force-stop and permission-denied limits.

### Phase 4 — sync validation and free-tier launch (approximately 1–2 weeks)

1. Automate typecheck, lint, unit/property tests, adapter contract tests, Postgres/RLS integration tests, web end-to-end and Android smoke tests. Pin CI actions and restrict job permissions.
2. Run a two-client fault suite: lost acknowledgement, replay, reordering, restart during local commit, same-field conflict, delete/edit race, overlapping block inserts, timer takeover, quota failure, token expiry, stale cursor and old APK protocol.
3. Load test using representative agenda ranges and measured row/index sizes. Set alerts, bounded retention, export, and a backup/restore runbook. Verify restore in a separate environment.
4. Deploy static web from a reviewed build; configure OAuth callbacks, CSP and HTTPS; verify service-worker update behavior. Deploy database changes with expand/contract compatibility so old APKs survive web updates.
5. Publish a direct signed APK download with version/checksum and update instructions. Keep secrets out of artifacts and source maps; verify the APK contains only public backend configuration.

**Exit:** two physical/logical devices converge to the expected canonical state in all defined scenarios; pending work is never silently discarded; cost instrumentation exists; rollback is rehearsed. A provider quota failure leaves local work usable and recoverable, with truthful sync status.

### Concrete validation matrix

| Test | Required assertion |
|---|---|
| Crash before/after local transaction commit | Projection and outbox either both exist or neither exists. |
| Server commit, lost reply, retry | Same receipt; one entity mutation and one semantic timer event. |
| Concurrent commit/cursor ordering | Pull never permanently skips a later-committing mutation. |
| Offline edit followed by incoming pull | Pending local intent remains projected until accepted/resolved. |
| Same task two groups vs same group | Independent changes merge; conflicting group is preserved for review. |
| Schedule endpoints and adjacency | No zero/negative range; 10:00–10:30 and 10:30–11:00 coexist. |
| Concurrent overlapping blocks | At most one confirmed reservation; rejected proposal is recoverable. |
| Dublin spring/autumn DST | Missing/repeated hours are handled explicitly; existing instants preserved. |
| Timer with wall clock ±10 minutes | Live monotonic countdown is stable; restart uncertainty is surfaced. |
| Pause/takeover races and duplicate alarm | Revision validation and logical event keys prevent double accounting. |
| Revoked token / offline restart | Local task access follows device policy; upload waits for valid auth. |
| Account A → B | No A data, subscriptions, reminders or queued writes appear under B. |
| 90-day stale device / schema upgrade | Consistent rebootstrap, preserved pending work, no deleted-task revival. |
| Storage quota / failed migration | No misleading save success; recover/export path remains available. |
| Old APK after web/backend deploy | Supported protocol still functions or preserves work behind an update notice. |

## Validation record and deliverable boundaries

The original source was inspected at the pinned commit. Browser checks verified task creation and ordinary local persistence, then demonstrated that a running 05:00 break reloads to stopped 20:00 focus with no selected task. The isolated Node harness reproduced seven defects: zero-timer double completion, uncancelled auto-cycle restart, incorrect weekday write, missing active timer persistence, swallowed storage failure, multi-tab overwrite and stale active-task text after edit.

Run the local reproduction harness with `node review-source/reproduce-findings.cjs`. It intentionally asserts the current defective outcomes; it is not a passing regression suite for a repaired app. No existing automated checks were available in the repository. Static findings about deployment, cache paths, API credentials and accessible task controls are labelled separately from executed checks.

The accompanying interactive concept illustrates Today, classification, scheduling and entering focus with sample tasks. Browser checks exercised capture, quadrant changes, overlap rejection, rescheduling, start/pause/resume/end, and all three planning views at 320, 360, 736 and 1024px in light/dark appearance. No horizontal page overflow or console errors were observed in those checks. This is not a complete accessibility audit. The concept does not implement cloud sync, native alarms, full drag-and-drop calendars or the production timer state machine. The SQL and TypeScript examples here are architecture specifications, not deployed infrastructure. No remote repository changes, releases or deployments were made during this evaluation.
