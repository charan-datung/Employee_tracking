# Security notes

## Session storage on the mobile app (residual risk — decision pending)

**Current state:** the Supabase session (refresh + access token) and the
cached agent profile persist through `apps/mobile/src/lib/kvStore.ts`, which
is backed by `@capacitor/preferences` — plain Android **SharedPreferences,
unencrypted at rest**.

**Residual risk:** on a stock device, SharedPreferences lives inside the
app sandbox (`/data/data/com.datung.fieldapp/`) and other apps cannot read
it. On a **rooted device** (or via a malicious `adb backup`-style extraction
on very old OEM builds) the file is readable, which exposes the refresh
token. Combined with the ANDROID_ID spoofability on rooted devices (see
`apps/mobile/src/lib/deviceIdentity.ts`), a rooted phone can impersonate the
agent's session wholesale. Mitigations in place: tokens expire and are
server-revocable, all decisions are server-side, RLS caps what an agent token
can do, and device mismatch still triggers on any non-spoofed device.

**Planned fix:** swap the `KVStore` backing to
`@aparajita/capacitor-secure-storage` (MIT, v8.x targets Capacitor 8,
actively maintained), which wraps keys with the Android Keystore. Per
CLAUDE.md rule 10, that plugin is **not installed until approved**. The
entire swap is one class in `kvStore.ts`; nothing else touches storage
directly. If approval is declined, this entry stands as the record of the
accepted residual risk.

## Device identity

ANDROID_ID limits (factory reset, signing-key rotation, rooted spoofing) are
documented in `apps/mobile/src/lib/deviceIdentity.ts`. Operationally the
sharpest edge: **do not rotate the release keystore casually** — it changes
every device's ANDROID_ID for this app and unbinds the whole field force at
once.

## Rebind request codes

6 characters from a 31-symbol alphabet (~887M combinations), single-use,
24-hour expiry, verifiable only through the `approve_device_rebind` edge
function by an authenticated supervisor whose reporting tree contains the
agent. Unknown, expired, and out-of-tree codes are indistinguishable to the
caller. Codes are not bearer secrets — approval still requires a supervisor
acting on a phone call with the agent.
