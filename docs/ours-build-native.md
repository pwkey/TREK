# ours-build-native.md — 460 Trip Planner

Build and distribution runbook for the iOS and Android native apps. Reach for this in Milestone 1 (first-time setup) and every time certificates renew, a new OS release breaks something, or a new build needs to go to TestFlight.

Referenced from `CLAUDE.md` §3 (distribution strategy) and §12 (annual maintenance reminders).

---

## 1. Why a runbook, not tribal knowledge

Native-app signing, provisioning, and store submission have a high activation energy, a high error rate for first-time setup, and a nasty habit of breaking the week before a trip when you most need the app working. This document exists so future-you isn't rediscovering the same fix at 11pm the night before a flight. Update it every time you solve a problem that wasn't already written here.

**Primary source of truth:** always prefer Apple and Google's current documentation over anything in this file for workflow steps. Their interfaces change. Use this runbook for the *decisions we've made* (bundle identifiers, distribution tracks, signing approach) and the *project-specific gotchas*. Use their docs for "which button to click in Xcode."

- Apple: <https://developer.apple.com/documentation/xcode>
- Google: <https://developer.android.com/studio/publish>
- Capacitor: <https://capacitorjs.com/docs>

---

## 2. One-time accounts and tooling

### Accounts

- **Apple Developer Program** — US$99/year. Enrol at <https://developer.apple.com/programs/>. Use the Apple ID you want to permanently own the app. Personal (Individual) membership is sufficient — we don't need an Organization account for a household app. Enrolment verification can take up to 48 hours.
- **Google Play Console** — US$25 one-time, only if we want Play Store Internal Testing distribution. Enrol at <https://play.google.com/console/signup>. Skip this unless direct APK sideload becomes painful.

### Machine requirements

- **Mac** (required for iOS). Apple Silicon preferred. Keep macOS within one major version of current to avoid Xcode pain.
- **Xcode** — install from the Mac App Store. Match the minimum version required by our Capacitor version (check `@capacitor/ios` release notes). Open Xcode once after install and accept all licence prompts before anything else will work.
- **Xcode command-line tools** — `xcode-select --install`.
- **CocoaPods** — `sudo gem install cocoapods`. Needed by Capacitor's iOS build.
- **Android Studio** — <https://developer.android.com/studio>. Install with the default SDK bundle; then in SDK Manager ensure the latest stable Android SDK Platform and Build-Tools are present.
- **Java** — Android Studio bundles a JDK; no separate install needed for normal builds.
- **Node.js 22** (matches upstream TREK requirement).

### Decisions we've locked in

These values must stay stable over the app's lifetime. Changing them later means a new app in the stores and loss of continuity for existing installs.

| Decision | Value |
|---|---|
| App display name | 460 Trip Planner |
| Bundle identifier (iOS) | `com.fourhundredsixty.tripplanner` *(placeholder — confirm before first `cap init`)* |
| Application ID (Android) | Same as iOS bundle identifier |
| URL scheme for deep links | `fourhundredsixty-tripplanner://` |
| Minimum iOS version | Whatever `@capacitor/ios` currently requires; don't go lower |
| Minimum Android SDK | Whatever `@capacitor/android` currently requires |
| iOS distribution method | TestFlight (internal testing, up to 100 invitees) |
| Android distribution method | Direct APK to trusted devices (default); Google Play Internal Testing if needed later |

**If changing the bundle identifier before the first production build:** update `capacitor.config.ts`, the Xcode project's bundle identifier, the Android `applicationId` in `build.gradle`, and any references in this document. Do all of them in one commit.

---

## 3. First-time Capacitor setup

Done once per clone. After this, future builds only need §4.

```bash
# From repo root
npm install @capacitor/core @capacitor/cli
npx cap init "460 Trip Planner" com.fourhundredsixty.tripplanner --web-dir=client/dist

# Add platforms
npm install @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android

# Install the conservative plugin set (see CLAUDE.md §3.5)
npm install @capacitor/preferences @capacitor/filesystem @capacitor/network \
            @capacitor/camera @capacitor/app @capacitor/share

# First build + sync
npm run build --workspace=client   # or whatever the client build command is
npx cap sync                       # copies web assets + updates native plugins
```

### App icons and splash screens

Generate from single source images using `@capacitor/assets`:

```bash
npm install --save-dev @capacitor/assets
# Place source PNGs in resources/: icon-only.png (1024x1024), splash.png (2732x2732)
npx capacitor-assets generate --ios --android
```

Commit the generated assets. Regenerate when the source images change — don't hand-edit the per-size outputs.

### Configure app for WebSocket in production

TREK uses WebSockets on `/ws`. Inside the native WebView, connection URLs need to point at our production server (not `localhost`). Confirm the client reads the server URL from an env var or runtime config, not a hardcoded value. Document the production URL here once it's known:

**Production server URL:** *[to be set — e.g. `https://460.example.com`]*

### Deep links

Register `fourhundredsixty-tripplanner://` in:

- iOS: `Info.plist` → `CFBundleURLTypes` (Xcode does this via the Info tab).
- Android: `AndroidManifest.xml` → `<intent-filter>` inside the main `Activity`.

Test with:

```bash
# iOS simulator
xcrun simctl openurl booted "fourhundredsixty-tripplanner://trip/test"
# Android device/emulator
adb shell am start -W -a android.intent.action.VIEW -d "fourhundredsixty-tripplanner://trip/test"
```

---

## 4. Regular build workflow

Run every time you want to push a new version to devices.

### 4.1 Web build

```bash
# Lint, typecheck, test before building
npm run lint
npm run typecheck
npm test

# Build the client
npm run build --workspace=client
```

### 4.2 Copy to native projects

```bash
npx cap copy     # fast: only copies web assets
# or
npx cap sync     # slower: also updates native plugins (after adding/removing plugins)
```

Rule of thumb: `copy` during regular dev; `sync` when `package.json` has changed.

### 4.3 iOS build

```bash
npx cap open ios   # launches Xcode
```

In Xcode:

1. Select the "App" scheme and a device (real device or simulator).
2. Signing & Capabilities → Team → select your Apple Developer Team.
3. Product → Build (⌘B) for a smoke test, or Product → Archive for a distribution build.
4. For TestFlight: after archiving, Organizer opens → Distribute App → App Store Connect → Upload.

### 4.4 Android build

Debug APK (for sideload):

```bash
cd android
./gradlew assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```

Release APK (signed, for distribution):

```bash
cd android
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
# Requires keystore — see §6
```

Release bundle (for Google Play, if using):

```bash
./gradlew bundleRelease
# Output: app/build/outputs/bundle/release/app-release.aab
```

---

## 5. iOS signing and TestFlight distribution

### 5.1 App Store Connect record

One-time, on first release:

1. Sign in to <https://appstoreconnect.apple.com>.
2. My Apps → `+` → New App.
3. Fill in: Name (460 Trip Planner), Primary Language, Bundle ID (`com.fourhundredsixty.tripplanner`), SKU (any unique string, e.g. `TP460`).
4. Under TestFlight → Internal Testing, create an Internal Group.
5. Add testers by Apple ID email. Internal testers must also be members of the Developer team (App Store Connect → Users and Access → `+` → Developer role with minimal permissions).

### 5.2 Certificates and provisioning profiles

Xcode's "Automatically manage signing" handles this for a small team and is the recommended path. If you need manual control:

1. Apple Developer Portal → Certificates, IDs & Profiles.
2. Certificates → `+` → iOS Distribution. Follow the CSR workflow. Download and double-click to install into Keychain.
3. Identifiers → `+` → App ID → Bundle ID matches our app.
4. Profiles → `+` → App Store → select the App ID and Distribution certificate.

Certificates expire annually. Set a calendar reminder.

### 5.3 Upload to TestFlight

After `Archive` → `Distribute App` → `App Store Connect` → `Upload`:

1. Wait for Apple's processing (typically 15–60 minutes). You'll get an email when it's ready.
2. In App Store Connect, select the build and assign it to the Internal Testing group.
3. Testers receive an email invite with a link to install via the TestFlight app.
4. First-time testers need to install TestFlight from the App Store and redeem their invite.

### 5.4 What NOT to do

- **Don't** publish to the App Store (public release) — we're personal-use only. Stick to Internal TestFlight.
- **Don't** use External Testing unless genuinely needed; it requires Beta App Review (usually fast, but it's still a gate).
- **Don't** commit signing certificates or provisioning profiles to git.

---

## 6. Android signing and distribution

### 6.1 Generate a keystore (one-time, NEVER lose this)

```bash
keytool -genkey -v -keystore 460-tripplanner.keystore \
        -alias tripplanner -keyalg RSA -keysize 2048 -validity 10000
```

Answer the prompts. Use a strong passphrase. Store the passphrase in a password manager.

**This keystore is non-recoverable.** If lost, the app cannot be updated — a new app would be required, with a different Application ID, and all existing installs would need to uninstall and reinstall. Back up the keystore file to:

- Primary: password manager secure notes (as file attachment)
- Secondary: encrypted archive in personal cloud storage
- Never: git, Slack, email, or any unencrypted location

### 6.2 Configure Gradle for release signing

Create `android/key.properties` (gitignored):

```
storePassword=<your storepass>
keyPassword=<your keypass>
keyAlias=tripplanner
storeFile=../../460-tripplanner.keystore
```

Add `key.properties` to `android/.gitignore`. Reference it from `android/app/build.gradle` inside the `signingConfigs` block — check Capacitor's current docs for exact syntax, this evolves.

### 6.3 Build and distribute a release APK

```bash
cd android
./gradlew assembleRelease
```

Share `app-release.apk` with trusted recipients via:

- **AirDrop / Nearby Share** for nearby devices.
- **Secure file-sharing service** (Proton Drive, Tresorit, signed cloud share link) for remote recipients.
- **Self-hosted download** from a private URL.

Recipients need to enable "Install unknown apps" for their file manager or browser. First install of an unsigned or self-signed APK prompts a warning — this is expected.

### 6.4 Optional: Google Play Internal Testing

If direct APK sharing becomes annoying (e.g. users keep missing update notifications):

1. Google Play Console → Create app → fill in basic metadata.
2. Testing → Internal testing → create a release → upload the `.aab` from `./gradlew bundleRelease`.
3. Add tester Google accounts to the Internal Testing email list.
4. Share the opt-in URL; testers get auto-updates through the Play Store.

Internal Testing on Google Play does NOT require review — apps go live to testers within minutes.

---

## 7. Troubleshooting

### WebSocket connection fails inside native WebView

**Symptom:** app works on web but real-time sync silently fails inside the iOS or Android app.

**Check:**

- Is the WebSocket URL absolute (`wss://460.example.com/ws`), not relative (`/ws`)?
- Does the production server have a valid TLS certificate? Self-signed certs don't work in native WebViews by default.
- On iOS, does `Info.plist` allow arbitrary loads for our domain if we're not using standard HTTPS? Avoid this — fix the cert instead.

### `npx cap sync` fails with Cocoapods error

**Usual cause:** Cocoapods cache corruption or Ruby version mismatch.

```bash
cd ios/App
pod cache clean --all
pod install --repo-update
```

If that fails, check Ruby version (`ruby -v` — should be the macOS-provided version) and CocoaPods version (`pod --version`).

### Android Gradle build fails with "SDK location not found"

**Usual cause:** `ANDROID_HOME` not set.

```bash
echo 'export ANDROID_HOME=$HOME/Library/Android/sdk' >> ~/.zshrc
echo 'export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools' >> ~/.zshrc
source ~/.zshrc
```

### Safe area / notch UI issues

Capacitor exposes safe-area insets as CSS environment variables:

```css
padding-top: env(safe-area-inset-top);
padding-bottom: env(safe-area-inset-bottom);
```

Use these on every top-level container. Respect in both the PWA and native — landlord web code shouldn't need native-specific branches for this.

### iOS build succeeds locally but TestFlight rejects

**Common causes:** missing privacy strings in `Info.plist` for plugins (camera, photo library, etc.), export compliance (if using encryption APIs), bundle version not incremented.

- Every Capacitor plugin that accesses a protected API needs a corresponding `NS*UsageDescription` string.
- Increment `CFBundleVersion` (build number) on every upload; App Store Connect won't accept a duplicate.

---

## 8. Annual maintenance checklist

Tick yearly. Calendar reminder: early each year.

- [ ] Apple Developer Program renewed (paid automatically if auto-renewal enabled; verify).
- [ ] iOS Distribution certificate still valid (expiry visible in Developer Portal or Xcode).
- [ ] Android keystore backup verified in password manager and secondary location.
- [ ] Capacitor core and plugins bumped to latest compatible versions.
- [ ] Xcode updated; minimum iOS version reviewed (bump if old versions drop below Apple's active support).
- [ ] Android Studio updated; `targetSdkVersion` reviewed (Google requires target SDK updates periodically or apps get hidden from Play Store).
- [ ] A fresh build uploaded to TestFlight and installed from scratch on one device to verify the full pipeline.
- [ ] This document updated with anything that changed or tripped you up.

---

## 9. Things explicitly left to future-us

Decisions or tasks deferred on purpose. Revisit only when the specific trigger fires.

| Item | Trigger for revisit |
|---|---|
| Switch from direct APK to Google Play Internal Testing | When more than ~5 Android testers need builds and distribution friction is the pain |
| Switch from TestFlight Internal to External Testing | Only if invitee count exceeds 100, which shouldn't happen |
| CI-based builds (GitHub Actions, EAS Build, etc.) | When manual builds are taking more than 30 min per release and it's happening often |
| Push notifications | Not before Milestone 8+; covered in CLAUDE.md §6 out-of-scope list |
| Biometric unlock | Only if the server exposes sensitive data that isn't already behind SSO |
| App Store public listing | Never, per CLAUDE.md §3 — we're personal use |

If any of these get revisited, update CLAUDE.md §3 or §6 accordingly.
