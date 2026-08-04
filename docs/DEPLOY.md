# Deployment runbook

Order matters. Steps 1–4 are one-time setup; step 5 is the chicken-and-egg
bootstrap everything else depends on.

## 1. Supabase project

```sh
supabase link --project-ref <ref>
supabase db push                 # applies all migrations in order
supabase functions deploy register_device
supabase functions deploy approve_device_rebind
supabase functions deploy evaluate_session_integrity
supabase functions deploy dispatch_notifications
```

## 2. Storage bucket (photos 404 without this)

Dashboard → Storage → New bucket: name `field-photos`, **Private**.

Then the upload policy. Supervisors need no Storage grant — the console mints
short-lived signed URLs server-side after RLS has already authorised the
session read.

```sql
-- Agents may upload ONLY into their own folder (<agent_id>/<photo>.jpg),
-- which is the path savePhotoLocal() generates.
create policy field_photos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'field-photos'
    and (storage.foldername(name))[1] = (select (public.current_agent()).id)::text
  );
```

## 3. Extensions

Dashboard → Database → Extensions: enable **pg_cron** and **pg_net**.

The scheduling blocks no-op'd with a NOTICE during migration, so re-run them:

```sql
select cron.schedule('auto-close-stale-sessions', '0 * * * *',
  'select public.auto_close_stale_sessions()');
select cron.schedule('evaluate-session-integrity', '*/5 * * * *',
  'select public.evaluate_pending_sessions()');
```

Push schedules also need:

```sql
alter database postgres set app.settings.dispatch_url =
  'https://<ref>.supabase.co/functions/v1/dispatch_notifications';
alter database postgres set app.settings.service_key = '<service-role-key>';
```

…then the three `cron.schedule` calls at the bottom of
`20260731070100_push_dispatch.sql`.

**Skipping this section is survivable:** sessions never auto-close, integrity
scores stay null, no push is sent. Everything else works.

## 4. Environment

Copy `.env.example`. Day-one required: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (console,
server-only), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (mobile).

Optional: `NOMINATIM_URL`, `NEXT_PUBLIC_TILE_URL` (move off the public OSM
server before real traffic), `FCM_*`.

## 5. Bootstrap the first admin

**The only account created by hand.** Everyone else comes from `/admin/agents`.

1. Dashboard → Authentication → Add user
   - email `dtg-0000@datung.internal`
   - a password you change immediately
   - ✅ Auto Confirm User
2. Copy the UUID, then:

```sql
insert into public.branches (name, code, address, lat, lng)
values ('Head Office', 'HO', 'Las Piñas', 14.4512, 120.9822)
on conflict (code) do nothing;

insert into public.agents
  (auth_user_id, employee_no, full_name, role, branch_id,
   employment_status, hired_at)
values
  ('<uuid-from-step-1>', 'DTG-0000', 'System Administrator', 'admin',
   (select id from public.branches where code = 'HO'), 'active', now());
```

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
