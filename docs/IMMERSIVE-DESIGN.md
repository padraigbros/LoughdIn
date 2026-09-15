# Lough Guitane workspace

The background is the owner's corrected LG.png, copied unchanged to `assets/lough-guitane.png`. Its SHA-256 is `E0C96B281765204124C69D9223B89F076B97C21D53EAFC21C810575D04A6C563`.

The photograph fills the viewport behind the workspace. Responsive crops preserve the mountain and reflection; the existing rotating motivational quote sits in the sky above the ridge. A dark gradient and evergreen panels keep controls readable. The brand name has no Kerry suffix.

The matching SVG keyhole uses the photograph's small left summit, saddle, broad right ridge and reflection. Run `npm run icons` to regenerate web/PWA and Android launcher images from `icons/keyhole.svg`. The keyhole stays inside the maskable safe area. The icon deliberately simplifies photographic detail for small sizes.

Focus puts the current task and timer first. Plan exposes scheduling, while Progress exposes statistics. On phones the navigation remains at the bottom. Selecting a different task during a session explicitly queues it for the next session. Task overflow menus expose Edit and Delete without crowding the focus action. Zen preserves the lake and sky quote.

Run `npm run check`, `npm test` and `npm run test:browser`. The browser suite covers desktop, phone, narrow phone and landscape layouts, task selection, pause/resume, navigation, Zen and offline reloads at the GitHub Pages subpath. Install Chromium once with `npx playwright install chromium`. Review screenshots are generated under `test-results/immersive/`.

The same web artifact is copied into Android by `npm run android:sync`. Browser checks do not replace physical-device Android testing or accessibility testing with assistive technology.

## Responsive refinement — September 2026

Quote spacing is content-sized, with compact timer typography on short screens and a two-column timer in phone landscape. Phone content scrolls in a viewport ending above the bottom navigation. Plan and Progress omit the quote on phones, and navigation starts each workspace at the top. Planner grid children shrink within their container; the task tray and week calendar retain intentional horizontal scrolling.

Primary timer controls retain emphasis; dialog actions use consistent 44px minimum heights and compact widths. Sign-in inputs use 16px text, long account addresses wrap, and dialogs scroll within the available viewport. Routine saving, syncing, pending counts and success dots are silent. Account identity and actionable authentication/conflict/error messages remain available. Automatic persistence and retry behavior are unchanged.

Validation: 103 unit/integration tests, production build, and Chromium checks at desktop, 1366×768, 390×844, 360×640, 320×740 and 844×390. Checks cover empty/running timers, session controls above navigation, dialog proportions and reachability, planner container widths, navigation, Zen and offline reload. Generated screenshots are in `test-results/immersive/`. Android assets are refreshed with Capacitor; no device installation or live deployment is part of this local validation.
