# Security notes

## Session storage on the mobile app

**Current state:** the Supabase session (refresh + access token) and the
cached agent profile persist through `apps/mobile/src/lib/kvStore.ts`,
backed by `@aparajita/capacitor-secure-storage` (MIT, v8.x, approved
2026-07-31): values are **encrypted at rest** with a key held in the
Android Keystore. The plugin declares no manifest permissions.

**Residual risk (reduced, not zero):** on a **rooted device** the Keystore
key material itself is protected, but a root-level attacker can hook the
running app and read tokens from process memory, and can still spoof
ANDROID_ID (see `apps/mobile/src/lib/deviceIdentity.ts`). Mitigations:
tokens expire and are server-revocable, all decisions are server-side, RLS
caps what an agent token can do, and device mismatch still triggers on any
non-spoofed device. Root detection is deliberately NOT relied upon —
integrity is judged server-side from the data instead.

**Invariant:** all persisted auth state goes through the `KVStore`
interface in `kvStore.ts`. Never write auth state via
`@capacitor/preferences` directly.

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
