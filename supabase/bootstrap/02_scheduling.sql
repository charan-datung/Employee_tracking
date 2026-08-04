-- =============================================================================
-- Bootstrap 2/3 — extensions and scheduled jobs
--
-- Run once per project, AFTER `supabase db push`. Idempotent: safe to re-run.
--
-- WHY THIS IS NOT IN A MIGRATION
-- pg_cron and pg_net cannot be created by the migration role on a hosted
-- project, so every migration that wants a schedule guards it with
--   if exists (select 1 from pg_extension where extname = 'pg_cron')
-- and raises a NOTICE otherwise. On a fresh project that guard is false and
-- every schedule is skipped. This file enables the extensions and then re-runs
-- exactly those blocks.
--
-- SKIPPING THIS FILE IS SURVIVABLE. Sessions never auto-close, integrity
-- scores stay null, and no push is sent. Attendance, visits, sync and the
-- console all work. It is a degradation, not an outage.
-- =============================================================================

-- pg_cron installs its own `cron` schema and may only be created in the
-- `postgres` database. On Supabase the SQL editor already runs as a role that
-- can do this; locally, `supabase start` runs as superuser.
create extension if not exists pg_cron;

-- pg_net gives Postgres an async HTTP client, which is how a cron job reaches
-- the dispatch_notifications edge function. Supabase keeps it in `extensions`.
create extension if not exists pg_net with schema extensions;

-- -----------------------------------------------------------------------------
-- Settings the push schedules read at run time.
--
-- REPLACE THE TWO PLACEHOLDERS BELOW BEFORE RUNNING.
--
-- The service key sits in a database setting because pg_cron jobs run with no
-- request context and cannot read an environment variable. `alter database ...
-- set` values are visible to any role that can call current_setting() — which
-- is why every function in this schema pins search_path and why nothing
-- reachable by `authenticated` reads app.settings.*. Treat this as: the key is
-- in the database, so the database's own access control is the boundary.
--
-- Takes effect on NEW connections only. pg_cron opens a fresh connection per
-- job run, so the schedules pick it up immediately; an already-open psql
-- session will not see it until reconnect.
-- -----------------------------------------------------------------------------
do $$
begin
  execute format(
    'alter database %I set app.settings.dispatch_url = %L',
    current_database(),
    'https://<project-ref>.supabase.co/functions/v1/dispatch_notifications'
  );
  execute format(
    'alter database %I set app.settings.service_key = %L',
    current_database(),
    '<service-role-key>'
  );
end $$;

-- -----------------------------------------------------------------------------
-- Schedules. Identical to the DO blocks at the bottom of the migrations that
-- define each function — kept in step by hand, so if you change a schedule
-- there, change it here.
--
-- Times are UTC. Manila is UTC+8 and pg_cron has no timezone support, so
-- 09:15 PHT = 01:15 UTC and 20:00 PHT = 12:00 UTC.
-- -----------------------------------------------------------------------------
do $$
declare
  v_job text;
begin
  foreach v_job in array array[
    'auto-close-stale-sessions',
    'evaluate-session-integrity',
    'push-critical-flags',
    'push-not-checked-in-digest',
    'push-open-sessions-digest'
  ] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;

  -- Hourly. A session open past the 16h ceiling is closed with NULL close
  -- coordinates — the server will not invent a location it never observed.
  perform cron.schedule('auto-close-stale-sessions', '0 * * * *',
    'select public.auto_close_stale_sessions()');

  -- Every 5 minutes. Scores order a triage queue; they discipline nobody.
  perform cron.schedule('evaluate-session-integrity', '*/5 * * * *',
    'select public.evaluate_pending_sessions()');

  -- Critical flags are swept rather than pushed by trigger: a trigger would
  -- fire inside the transaction that raised the flag, and a slow FCM call must
  -- never hold an agent's sync open.
  perform cron.schedule('push-critical-flags', '*/2 * * * *',
    $cron$select net.http_post(
      url := current_setting('app.settings.dispatch_url', true),
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||current_setting('app.settings.service_key', true)),
      body := jsonb_build_object('mode','critical_flag')) $cron$);

  perform cron.schedule('push-not-checked-in-digest', '15 1 * * 1-6',
    $cron$select net.http_post(
      url := current_setting('app.settings.dispatch_url', true),
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||current_setting('app.settings.service_key', true)),
      body := jsonb_build_object('mode','not_checked_in_digest')) $cron$);

  perform cron.schedule('push-open-sessions-digest', '0 12 * * *',
    $cron$select net.http_post(
      url := current_setting('app.settings.dispatch_url', true),
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||current_setting('app.settings.service_key', true)),
      body := jsonb_build_object('mode','open_sessions_digest')) $cron$);
end $$;

-- Verify: five rows, all active.
select jobname, schedule, active from cron.job order by jobname;
