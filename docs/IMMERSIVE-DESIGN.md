# Lough Guitane workspace

The background is the owner's corrected LG.png, copied unchanged to `assets/lough-guitane.png`. Its SHA-256 is `E0C96B281765204124C69D9223B89F076B97C21D53EAFC21C810575D04A6C563`.

The photograph fills the viewport behind the workspace. Responsive crops preserve the mountain and reflection; the existing rotating motivational quote sits in the sky above the ridge. A dark gradient and evergreen panels keep controls readable. The brand name has no Kerry suffix.

The matching SVG keyhole uses the photograph's small left summit, saddle, broad right ridge and reflection. Run `npm run icons` to regenerate web/PWA and Android launcher images from `icons/keyhole.svg`. The keyhole stays inside the maskable safe area. The icon deliberately simplifies photographic detail for small sizes.

Focus puts the current task and timer first. Plan exposes scheduling, while Progress exposes statistics. On phones the navigation remains at the bottom. Selecting a different task during a session explicitly queues it for the next session. Task overflow menus expose Edit and Delete without crowding the focus action. Zen preserves the lake and sky quote.

Run `npm run check`, `npm test` and `npm run test:browser`. The browser suite covers desktop, phone, narrow phone and landscape layouts, task selection, pause/resume, navigation, Zen and offline reloads at the GitHub Pages subpath. Install Chromium once with `npx playwright install chromium`. Review screenshots are generated under `test-results/immersive/`.

The same web artifact is copied into Android by `npm run android:sync`. Browser checks do not replace physical-device Android testing or accessibility testing with assistive technology.
