# Android release and device smoke test

Two workflows build the Android shell:

- `android-debug.yml` validates a debug-signed APK on pull requests. Each run
  signs with a throwaway key, so these APKs cannot update one another. Use them
  for quick checks only.
- `android-release.yml` builds a release-signed APK and AAB. It runs when a
  `v*` tag is pushed, or manually. A tag also publishes a GitHub Release with
  checksums.

The reproducible build baseline is Node 24, Temurin JDK 21, Android SDK 36,
Android Gradle Plugin 8.13.0, checksum-pinned Gradle 8.14.3, and the exact
Capacitor versions in `package-lock.json`. Both workflows rebuild `dist/`
and run `cap sync android` before assembly so committed native assets cannot
silently drift from the web build.

## Release custody

The upload key is the app's identity. Android only installs an update signed
with the same key, so losing it means users must uninstall (and lose unsynced
local data) to move to a new one. Keep the keystore file and both passwords in
a password manager, with an offline backup. Never commit a keystore,
`keystore.properties`, Supabase service key, or auth token.

Record the application ID (`ie.loughdin.app`), the key alias, the certificate
SHA-256 fingerprint, and who can rotate the key.

### One-time key setup

The key owner runs these steps. `keytool` ships with Android Studio's JDK
(`$JAVA_HOME/bin/keytool`) and prompts for both passwords.

```bash
keytool -genkeypair -v -keystore loughdin-release.jks -alias loughdin -keyalg RSA -keysize 4096 -validity 10000
```

```bash
keytool -list -v -keystore loughdin-release.jks -alias loughdin
```

Record the SHA-256 certificate fingerprint from the second command. Then store
the key as repository secrets. Each `gh secret set` without `--body` prompts
for the value, so passwords stay out of shell history.

```bash
base64 -w0 loughdin-release.jks | gh secret set LOUGHDIN_KEYSTORE_BASE64
```

```bash
gh secret set LOUGHDIN_KEYSTORE_PASSWORD
```

```bash
gh secret set LOUGHDIN_KEY_ALIAS --body loughdin
```

```bash
gh secret set LOUGHDIN_KEY_PASSWORD
```

To build a signed release locally instead, create an uncommitted
`android/keystore.properties`:

```properties
KEYSTORE_FILE=C:/path/to/loughdin-release.jks
KEYSTORE_PASSWORD=...
KEY_ALIAS=loughdin
KEY_PASSWORD=...
```

Then run `npm run android:sync` and `gradlew.bat assembleRelease bundleRelease`
from `android/`. Without all four values, release builds are left unsigned and
debug builds are unaffected.

## Versioning and publishing

`package.json` is the only version source. The Android `versionName` is that
version, and `versionCode` is `major*10000 + minor*100 + patch` (`0.3.0` is
300). Android refuses to install a lower `versionCode` over a higher one, so
bump the version for every release:

1. Update `version` in `package.json` (and `package-lock.json`) in a pull
   request, and merge it.
2. Tag the merge commit `v<version>` and push the tag.
3. The release workflow refuses a tag that does not match `package.json`,
   missing secrets, a debug-signed APK, or an APK containing a Supabase secret
   or service-role key. It then publishes `loughdin-<version>.apk`, the AAB,
   and `SHA256SUMS.txt`.

## Update path

The first release-signed APK cannot install over a debug-signed one. Before
switching, export a backup from the app or sign in and let sync finish, then
uninstall the debug build and install the signed APK. After that, each newer
signed APK installs over the previous one and keeps local data.

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
6. Install the next signed version over the previous one and confirm local
   tasks, settings and sign-in survive the update.

Capture device model/Android version, app version, permissions, timestamps,
result, and screenshots/logs for each check. This checklist requires a real
device or configured emulator plus Supabase/Auth credentials; CI compilation
alone is not evidence of runtime or backend certification.
