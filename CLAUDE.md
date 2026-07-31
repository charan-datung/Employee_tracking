PROJECT: Field attendance and visit verification. Capacitor, Android only.
Offline-first. Fraud-resistant by design.

HARD RULES
1. Android only. No iOS code, no iOS testing, no iOS conditionals.
2. Never trust the client. Every timestamp, distance, and duration used for a
   decision is computed server-side. The device sends observations; the server
   decides facts.
3. Every location record stores BOTH device_captured_at and server_received_at,
   plus the device clock offset measured at sync time.
4. Location is NEVER sampled outside an open attendance session. There is no
   tracking when the agent is checked out. This is a legal requirement under
   the Philippine Data Privacy Act (RA 10173) proportionality principle, not a
   preference. Any code path that could sample location with no open session is
   a bug, not a feature.
5. GPS integrity is mandatory. Every reading captures the `simulated` boolean
   from @capacitor-community/background-geolocation plus accuracy in metres.
   A reading that is simulated, or worse than 100m accuracy, is REJECTED at
   capture. Never fall back to coarse/network location. Never proceed on a
   rejected fix under any circumstance.
6. Photos are captured through an in-app live camera preview (getUserMedia,
   facingMode 'user'). The @capacitor/camera plugin and any file-input or
   gallery path must not exist in this codebase. Grep for `<input type="file"`
   in review — if it exists, it's a bug.
7. No money. This app records contact OUTCOME only. No amounts, no balances,
   no receipts. Odoo owns money.
8. The strings "hours worked", "overtime", "total_hours", "duration" must not
   appear in the database schema. Duration is a presentation-layer computation
   behind a feature flag. Ask me before changing this — it has Philippine
   labor-law consequences under Article 82 of the Labor Code.
9. Assume 2GB-RAM Android 10-13 devices on intermittent LTE, and assume the
   Android System WebView may be several versions behind. Every screen must
   function with zero connectivity, offline, from a cold start.
10. No new npm dependencies or Capacitor plugins without asking me first.
    Justify each one and state its licence.
11. After adding any Capacitor plugin, run `npx cap sync` and update
    AndroidManifest.xml. State explicitly which manifest changes are needed.

STACK
Web: Vite + React 18 + TypeScript (strict) + React Router + TanStack Query +
zod + Tailwind.
Native: Capacitor + @capacitor/device + @capacitor/preferences +
@capacitor/network + @capacitor/app + @capacitor-community/sqlite +
@capacitor-community/background-geolocation +
@capacitor/local-notifications + @capacitor/push-notifications.
Backend: Supabase (Postgres + PostGIS, Auth, Storage, Edge Functions).
Console: Next.js App Router + Supabase SSR + Tailwind + MapLibre GL.
State: React Context + TanStack Query only. No Redux, Zustand, or MobX.

CODE STYLE: strict TS, no `any`, zod-validate every network boundary in both
directions, no default exports except route components.
