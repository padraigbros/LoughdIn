# Android release and device smoke test

The repository workflow validates a standard debug-signed APK only. It does
not use the release key, publish, or certify a release build.

The reproducible build baseline is Node 24, Temurin JDK 21, Android SDK 36,
Android Gradle Plugin 8.13.0, checksum-pinned Gradle 8.14.3, and the exact
Capacitor versions in `package-lock.json`. The CI workflow rebuilds `dist/`
and runs `cap sync android` before assembly so committed native assets cannot
silently drift from the web build.

## Release custody

Keep the upload keystore and passwords in a dedicated secrets manager. Never
commit a keystore, signing properties, Supabase service key, or auth token.
Record the application ID (`ie.loughdin.app`), version code/name, build tools,
and the person/process that can rotate the key. A release build must use an
explicit signing configuration and a protected CI secret; debug signing is not
release signing.

Before distribution, record a SHA-256 checksum, APK version, and install/update
instructions. Verify the artifact contains only public client configuration.

## Device smoke test

On a reference Android device and, where available, a second vendor/device:

1. Install the signed APK, create a task, kill/reopen the process, and confirm
   the task and timer state survive.
2. Start, pause, resume, finish, and reset a timer across background/resume;
   confirm elapsed time is not based on redraw callback count.
3. Create a reminder, inspect notification permission and delivery, then test
   denied permission, reboot, timezone change, and force-stop behavior. Document
   any best-effort limitation rather than promising delivery.
4. Sign in through the system browser, return via the configured deep link, and
   confirm credentials are stored in secure Android storage. Test sign-out,
   account switching, expired auth, and offline edits/outbox recovery.
5. With network disabled, create/edit/delete work; restore connectivity and
   verify sync converges without duplicate sessions or lost local work.

Capture device model/Android version, app version, permissions, timestamps,
result, and screenshots/logs for each check. This checklist requires a real
device or configured emulator plus Supabase/Auth credentials; CI compilation
alone is not evidence of runtime or backend certification.
