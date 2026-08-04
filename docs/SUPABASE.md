# Integrating Supabase

Read this once before touching a real project. `DEPLOY.md` is the checklist;
this is the explanation of what you are connecting and why it is shaped this
way.

## 1. What "Supabase" is in this project

Four services, used for four separate jobs. They are not interchangeable and
mixing them up is how this system would leak.

| Service | Used for | Where it's wired |
|---|---|---|
| **Postgres + PostGIS** | Every table, every distance calculation, every server-side fact | `supabase/migrations/` |
| **Auth** | Agent and supervisor logins (synthetic emails, no mailboxes) | `apps/mobile/src/lib/supabaseClient.ts`, `apps/console/lib/supabase.ts` |
| **Storage** | Check-in/check-out/visit selfies, private bucket | `supabase/bootstrap/01_storage.sql` |
| **Edge Functions** | The four operations the client is not trusted to perform | `supabase/functions/` |

**All of the code is already written.** Nothing in the app needs building to
"add Supabase" — the clients, the schema, the policies and the functions exist.
What you are doing is pointing them at a project that exists, applying the
migrations, and creating the one account that bootstraps the rest.

## 2. The tables

Ten tables, all in `public`, created by
`migrations/20260731000000_v1_core_schema.sql`. You do not write these by
hand — `supabase db push` creates them.

| Table | Holds | Note |
|---|---|---|
| `branches` | Offices, each with a geofence centre and radius | Check-in is judged against this point |
| `agents` | The roster: employee no, role, branch, supervisor | `auth_user_id` links to `auth.users` |
| `devices` | ANDROID_ID binding, one current device per agent | Push tokens live here |
| `attendance_sessions` | One row per check-in → check-out | At most one open per agent, enforced by a partial unique index |
| `clients` | Borrower locations to visit | `geog` is generated, GIST-indexed |
| `visits` | Contact outcome + selfie + where the agent actually was | Outcome only — no amounts (rule 7) |
| `location_pings` | The sampled track during an open session | Agents may INSERT, never SELECT |
| `integrity_flags` | What the detector layer found | Raised server-side only |
| `audit_log` | Who changed what | Written by triggers; no role may INSERT, UPDATE or DELETE directly |
| `consent_records` | RA 10173 acceptance, versioned | Blocks tracking until accepted |

Two rules shaped nearly every column:

- **Every device claim has a server-stamped sibling.** `*_device` columns are
  what the phone said; `*_server` columns are what the server observed. Only
  the second kind is used for a decision. That is why timestamps look
  duplicated — they are not duplicates, they are a claim and a fact.
- **Distance is never computed in JavaScript.** Every lat/lng pair has a
  generated `geography(Point,4326)` column and a GIST index; `distance_m()`
  does the arithmetic in SQL. The client is not even granted the geofence
  result columns.

Also created by the migrations, and easy to miss: 8 enums, the RLS policy set
(deny-by-default on all ten tables), `current_agent()` / `is_supervisor_of()` /
`is_admin()` helpers, the visit and session triggers, the 15 integrity
detectors, and the roster-write functions the console's admin pages call.

## 3. Connecting a project

### 3.1 Create the project

Supabase dashboard → New project. Pick the **Singapore** region (closest to
Manila; every sync round-trip pays this latency). Save the database password.

Then note two things from Settings → API: the **Project URL** and the **anon
key**. The **service_role key** is on the same page — that one is server-only
and must never reach a phone or a browser.

### 3.2 Install the CLI

The Supabase CLI is a standalone binary, deliberately **not** an npm
dependency of this repo (CLAUDE.md rule 10 — and Supabase no longer supports
global npm installs):

```sh
brew install supabase/tap/supabase      # macOS / Linuxbrew
scoop install supabase                  # Windows
# or download a release binary from github.com/supabase/cli/releases
```

Verify with `supabase --version`. The npm scripts below shell out to whatever
is on your PATH.

### 3.3 Link and push the schema

```sh
supabase login
supabase link --project-ref <your-project-ref>
npm run db:push          # applies all 14 migrations, in filename order
```

`db:push` is the whole "create tables" step. It is transactional per migration
and it records what it applied, so re-running it is safe and does nothing.

**Check `supabase/config.toml` first**: `[db] major_version` must match your
project's Postgres version (Dashboard → Settings → Database). It defaults to
17. A mismatch does not break `db push`, but it makes `db diff` produce
noise that looks like schema drift and is not.

### 3.4 Run the three bootstrap scripts

These are in `supabase/bootstrap/` and are **not** migrations, for reasons
documented at the top of each file. Run them in the SQL editor, in order:

1. **`01_storage.sql`** — creates the private `field-photos` bucket and the
   one upload policy. Without this, every photo upload 404s and check-in
   cannot complete.
2. **`02_scheduling.sql`** — enables `pg_cron` and `pg_net`, then registers
   five jobs. **Edit the two placeholders first** (`<project-ref>` and
   `<service-role-key>`). Skipping this file is survivable: sessions never
   auto-close, integrity scores stay null, no push is sent, everything else
   works.
3. **`03_first_admin.sql`** — the one account created by hand. Create the auth
   user in the dashboard first (the file tells you exactly how), paste its
   UUID in, run it, and you can log into the console and create everyone else
   from `/admin/agents`.

Each is idempotent. Re-running any of them is a no-op.

### 3.5 Deploy the edge functions

```sh
npm run functions:deploy
```

Four functions, each doing something the client is deliberately not trusted
with:

- `register_device` — binds ANDROID_ID to an agent. RLS forbids clients from
  writing `devices` at all, so this is the only path in.
- `approve_device_rebind` — a supervisor approving a device change.
- `evaluate_session_integrity` — runs the detectors and scores a session.
- `dispatch_notifications` — sends FCM pushes; the only holder of the FCM
  service account.

### 3.6 Environment variables

Copy `.env.example` and fill in. Day one you need five:

```
NEXT_PUBLIC_SUPABASE_URL=        # console
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # console
SUPABASE_SERVICE_ROLE_KEY=       # console, SERVER-ONLY — never NEXT_PUBLIC_
VITE_SUPABASE_URL=               # mobile
VITE_SUPABASE_ANON_KEY=          # mobile
```

The `NEXT_PUBLIC_` / `VITE_` prefixes are not decoration: both bundlers inline
prefixed variables into client JavaScript. A service_role key with either
prefix is a total compromise — it bypasses every RLS policy in this document.

### 3.7 Turn off self-signup

Dashboard → Authentication → Sign In / Providers → disable **Allow new users
to sign up**. `config.toml` sets this for the local stack only; it does not
travel to the hosted project. An open signup endpoint lets anyone mint an
`authenticated` role and start probing the policies.

### 3.8 Verify

```sql
-- 10 tables, all with RLS on
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;

-- 5 cron jobs, all active (empty if you skipped 02)
select jobname, schedule, active from cron.job order by jobname;

-- the bucket, private
select id, public from storage.buckets;
```

Then log into the console. If **Agents** and **Branches** are in the nav, the
admin row in step 3.4.3 landed against the user you actually signed in as.

## 4. Local development

You do not need a hosted project to work on the schema:

```sh
npm run db:start     # docker: postgres + auth + storage + studio
npm run db:reset     # re-applies every migration, then seed.sql
npm run db:test      # the pgTAP suites — 36 RLS + 24 integrity assertions
```

`db:reset` is the fast way to prove the migration chain still applies from
scratch. Run `db:test` before any policy change merges. The local stack creates
the `field-photos` bucket from `config.toml`, but you still need to run
`bootstrap/01_storage.sql` against it for the upload policy.

## 5. How the app talks to the database

**Two clients in the console, and the default matters.** `userClient()` runs as
the signed-in supervisor, so RLS decides what comes back — a supervisor sees
their reporting tree because the database says so, not because a `WHERE` clause
remembered to filter. `adminClient()` is service_role and bypasses everything;
it is reserved for SECURITY DEFINER RPCs that re-check authority themselves,
and for minting signed photo URLs. Reaching for `adminClient()` to render a
page means an RLS policy is missing, and that is the bug to fix.

**The mobile client** stores its session through `kvStore` rather than
`localStorage`, and never parses tokens out of URLs (`detectSessionInUrl:
false`) — there is no OAuth redirect in this app, so that code path is only an
attack surface.

**Access is enforced three times over**, on purpose: table privileges, then
column-level grants, then RLS policies. An agent cannot read `location_pings`
even though they write them — reading your own track tells you where the
geofence edges are.

## 6. When it goes wrong

| Symptom | Cause |
|---|---|
| Photo upload 404s | `bootstrap/01_storage.sql` not run |
| Sessions stay open forever | `pg_cron` not enabled → `02_scheduling.sql` not run |
| Integrity scores always null | Same |
| Console nav has no Agents/Branches | The `agents` row's `auth_user_id` is not the user you logged in as |
| PostgREST errors on geography columns | `extra_search_path` missing `extensions` |
| Every query returns zero rows | Expected. RLS denies by default; the caller has no matching policy |
| `db diff` shows drift you did not write | `[db] major_version` does not match the project |
