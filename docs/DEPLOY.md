# Deployment runbook

The checklist. For *why* any of this is shaped the way it is, read
[SUPABASE.md](./SUPABASE.md) first.

Order matters. Steps 1–4 are one-time setup; step 5 is the chicken-and-egg
bootstrap everything else depends on.

## 1. Supabase project

Check `supabase/config.toml` — `[db] major_version` must match the project's
Postgres version (Dashboard → Settings → Database).

```sh
supabase link --project-ref <ref>
npm run db:push            # applies all migrations in order — creates every table
npm run functions:deploy   # all four edge functions
```

## 2. Storage bucket (photos 404 without this)

Run `supabase/bootstrap/01_storage.sql` in the SQL editor. It creates the
private `field-photos` bucket and the one upload policy: agents may write only
into their own `<agent_id>/` folder.

Supervisors need no Storage grant — the console mints short-lived signed URLs
server-side after RLS has already authorised the session read.

## 3. Extensions and schedules

Edit the two placeholders at the top of `supabase/bootstrap/02_scheduling.sql`
(`<project-ref>`, `<service-role-key>`), then run it. It enables **pg_cron**
and **pg_net** and registers five jobs — the migrations skipped them with a
NOTICE because the extensions did not exist yet.

Expect the closing `select` to return five active rows.

**Skipping this section is survivable:** sessions never auto-close, integrity
scores stay null, no push is sent. Everything else works.

## 4. Environment

Copy `.env.example`. Day-one required: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (console,
server-only), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (mobile).

Optional: `NOMINATIM_URL`, `NEXT_PUBLIC_TILE_URL` (move off the public OSM
server before real traffic), `FCM_*`.

Then Dashboard → Authentication → Sign In / Providers → **disable "Allow new
users to sign up"**. `config.toml` only does this for the local stack.

## 5. Bootstrap the first admin

**The only account created by hand.** Everyone else comes from `/admin/agents`.

1. Dashboard → Authentication → Add user
   - email `dtg-0000@datung.internal`
   - a password you change immediately
   - ✅ Auto Confirm User
2. Copy the UUID into `supabase/bootstrap/03_first_admin.sql`, adjust the
   branch to your real head office, and run it.
3. Log into the console — **Agents** and **Branches** should appear in the nav.

No migration creates this account on purpose: a migration that ships a login
ships a default credential.

## 6. Mobile build (sideload — no Play Store for a pilot)

```sh
cd apps/mobile
npm run build && npx cap sync android
npx cap open android      # Build → Generate Signed Bundle / APK
```

Host the APK or `adb install` it. For five agents this beats store review and
loses nothing.

**Back up the keystore.** Changing it changes every device's ANDROID_ID for
this app — unbinding every agent at once.

## 7. Password resets

Agents have no mailbox, so there is no self-service reset. An admin issues a
temporary password from `/admin/agents` → **Reset password** and reads it out.
Every reset is written to `audit_log`.
