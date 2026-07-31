# Datung Field

Field attendance and visit verification for a Philippine lending company.
Field sales agents and collectors check in at the start of their day, visit
borrower locations, and check out at the end. Android only, offline-first,
fraud-resistant by design.

**Read [/CLAUDE.md](./CLAUDE.md) before writing any code. Its rules are
non-negotiable.**

## Repository layout

```
apps/mobile      Vite + React 18 + TypeScript, wrapped with Capacitor 8.
                 Android platform only. The app agents carry in the field.
apps/console     Next.js (App Router) + Tailwind. Back-office console.
packages/shared  Shared TypeScript types, zod schemas, constants.
supabase         Migrations, seed SQL, edge functions.
```

npm workspaces monorepo. Run `npm install` once at the repo root.

## Prerequisites

- **Node.js ≥ 20.19** (22 LTS recommended) and npm ≥ 10
- **JDK 21** — required by Capacitor 8's Android tooling
- **Android SDK** — compileSdk/targetSdk **36**, minSdk 24 (project ships
  to Android 10–13 devices; see CLAUDE.md rule 9)
- **Gradle** — nothing to install; the project uses the Gradle wrapper
  (8.14.3), which downloads itself on first build

### JDK 21

- macOS: `brew install --cask temurin@21`
- Ubuntu/Debian: `sudo apt install openjdk-21-jdk`
- Windows: install [Temurin 21](https://adoptium.net/)

Verify with `java -version` (must print 21.x). If you have several JDKs, set
`JAVA_HOME` to the JDK 21 install, or set `org.gradle.java.home` in
`apps/mobile/android/gradle.properties`.

### Android SDK

Option A — **Android Studio** (recommended): install
[Android Studio](https://developer.android.com/studio), then in
*SDK Manager* install:

- Android SDK Platform **36**
- Android SDK Build-Tools (latest)
- Android SDK Platform-Tools (`adb`)
- Android SDK Command-line Tools

Option B — command-line only: download the
[command-line tools](https://developer.android.com/studio#command-line-tools-only),
then:

```sh
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Then point the environment at the SDK (add to your shell profile):

```sh
export ANDROID_HOME="$HOME/Android/Sdk"        # macOS: $HOME/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Capacitor also honours `apps/mobile/android/local.properties` with
`sdk.dir=/absolute/path/to/Sdk` (git-ignored).

### Device setup

Use a **physical device** (this app is about GPS integrity — emulators report
`simulated` fixes and are only useful for UI work). Enable *Developer options*
→ *USB debugging*, plug in, accept the prompt, and confirm it shows in
`adb devices`.

## First run

```sh
npm install                    # once, at the repo root
cd apps/mobile
npm run build                  # Vite build → apps/mobile/dist
npx cap sync android           # copy dist + plugins into android/
npx cap run android            # pick the device; launches the (blank) app
```

## The development loop

Every time web code changes:

```sh
npm run build && npx cap sync android && npx cap open android
```

- `npm run build` — typecheck + Vite build into `dist/`
- `npx cap sync android` — copies `dist/` into the Android project and wires
  up native plugins
- `npx cap open android` — opens the project in Android Studio; press Run.
  (Or skip Android Studio with `npx cap run android`.)

Do **not** use Capacitor live-reload (`server.url`). Assets must always be
bundled in the APK — the app has to cold-start with zero connectivity. See the
comment in `apps/mobile/capacitor.config.ts`.

After adding any Capacitor plugin (ask first — CLAUDE.md rule 10), run
`npx cap sync` and update `AndroidManifest.xml`, stating explicitly which
manifest changes are needed (rule 11).

## Other commands

```sh
npm run build:console          # build the Next.js console
npm run dev --workspace apps/console   # console dev server
npm run typecheck              # typecheck every workspace
```

## Environment variables

Copy `.env.example` and fill in Supabase credentials. Vite exposes only
`VITE_*` variables to the mobile client; Next.js exposes only `NEXT_PUBLIC_*`.
The service-role key is server-only — never ship it to any client.
