-- =============================================================================
-- Push notification selection.
--
-- WHO gets notified, ABOUT WHAT, and WHETHER THE RATE LIMIT ALLOWS IT is all
-- decided here in SQL, so it is inspectable and testable. The edge function
-- only turns the resulting rows into FCM calls. Same split as the integrity
-- detectors: policy in the database, transport at the edge.
--
-- The rate limit is the load-bearing part. A supervisor with eight agents can
-- easily generate forty critical flags in a bad morning; sending forty pushes
-- guarantees notifications get muted, and a muted channel is worse than none
-- because everyone believes alerting exists. So: at most one push per agent
-- per 30 minutes, and everything suppressed is recorded and rolled into the
-- next digest rather than dropped.
-- =============================================================================

-- Queue immediate pushes for unresolved CRITICAL flags nobody has been told
-- about yet. Returns the rows the dispatcher should actually send.
create or replace function public.queue_critical_flag_pushes()
returns table (
  notification_id uuid,
  push_token text,
  title text,
  body text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_flag record;
  v_supervisor public.agents;
  v_allowed boolean;
  v_id uuid;
  v_title text;
  v_body text;
begin
  create temporary table if not exists _queued (
    notification_id uuid, push_token text, title text, body text, payload jsonb
  ) on commit drop;
  delete from _queued;

  for v_flag in
    select f.id, f.agent_id, f.flag_type, f.severity, f.session_id,
           a.full_name, a.supervisor_agent_id
    from public.integrity_flags f
    join public.agents a on a.id = f.agent_id
    where f.severity = 'critical'
      and f.resolved_at is null
      and f.raised_at > now() - interval '24 hours'
      and not exists (
        select 1 from public.notification_log n
        where n.kind = 'critical_flag'
          and n.payload ->> 'flag_id' = f.id::text
      )
    order by f.raised_at
    limit 200
  loop
    -- The agent's direct supervisor is the recipient. No supervisor means no
    -- push — deliberately silent rather than escalating to everyone.
    select * into v_supervisor from public.agents
    where id = v_flag.supervisor_agent_id and employment_status = 'active';
    continue when v_supervisor.id is null;

    v_allowed := public.may_push_now(v_supervisor.id, v_flag.agent_id);

    -- Taglish, under 100 characters, and names the agent — a supervisor
    -- glancing at a lock screen must know WHO without opening anything.
    v_title := 'Critical flag: ' || v_flag.full_name;
    v_body := 'May seryosong isyu sa session niya. Tingnan sa console.';

    insert into public.notification_log
      (recipient_agent_id, subject_agent_id, kind, title, body, payload, suppressed)
    values
      (v_supervisor.id, v_flag.agent_id, 'critical_flag', v_title, v_body,
       jsonb_build_object('flag_id', v_flag.id, 'flag_type', v_flag.flag_type,
                          'session_id', v_flag.session_id,
                          'agent_id', v_flag.agent_id),
       not v_allowed)
    returning id into v_id;

    -- Suppressed rows are logged (so the digest can pick them up) but not
    -- returned for sending.
    if v_allowed then
      insert into _queued
      select v_id, d.push_token, v_title, v_body,
             jsonb_build_object('session_id', v_flag.session_id,
                                'agent_id', v_flag.agent_id)
      from public.devices d
      where d.agent_id = v_supervisor.id and d.is_current
        and d.push_token is not null;
    end if;
  end loop;

  return query select * from _queued;
end;
$$;

-- 09:15 digest — who has not checked in. This is the same number the console
-- board shows in red; the push exists for the supervisor who is in a jeepney
-- at 9:15, not at a desk.
create or replace function public.queue_not_checked_in_digest()
returns table (
  notification_id uuid, push_token text, title text, body text, payload jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sup record;
  v_missing text[];
  v_id uuid;
  v_title text;
  v_body text;
begin
  create temporary table if not exists _digest (
    notification_id uuid, push_token text, title text, body text, payload jsonb
  ) on commit drop;
  delete from _digest;

  for v_sup in
    select distinct s.id, s.full_name
    from public.agents s
    where s.role = 'field_supervisor' and s.employment_status = 'active'
  loop
    select array_agg(a.full_name order by a.full_name) into v_missing
    from public.agents a
    where a.supervisor_agent_id = v_sup.id
      and a.employment_status = 'active'
      and not exists (
        select 1 from public.attendance_sessions x
        where x.agent_id = a.id
          and x.opened_at_server >= (date_trunc('day', now() at time zone 'Asia/Manila')
                                     at time zone 'Asia/Manila')
      );

    continue when v_missing is null or array_length(v_missing, 1) = 0;

    v_title := array_length(v_missing, 1) || ' hindi pa naka-check in';
    v_body := array_to_string(v_missing[1:3], ', ')
      || case when array_length(v_missing, 1) > 3
              then ' at ' || (array_length(v_missing, 1) - 3) || ' pa' else '' end;

    insert into public.notification_log
      (recipient_agent_id, subject_agent_id, kind, title, body, payload)
    values
      (v_sup.id, null, 'not_checked_in_digest', v_title, v_body,
       jsonb_build_object('missing', to_jsonb(v_missing)))
    returning id into v_id;

    insert into _digest
    select v_id, d.push_token, v_title, v_body, jsonb_build_object('kind', 'digest')
    from public.devices d
    where d.agent_id = v_sup.id and d.is_current and d.push_token is not null;
  end loop;

  return query select * from _digest;
end;
$$;

-- 20:00 digest — sessions still open. Catches the forgotten check-out before
-- the 16h auto-close turns it into a flag.
create or replace function public.queue_open_sessions_digest()
returns table (
  notification_id uuid, push_token text, title text, body text, payload jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sup record;
  v_open text[];
  v_id uuid;
  v_title text;
  v_body text;
begin
  create temporary table if not exists _digest2 (
    notification_id uuid, push_token text, title text, body text, payload jsonb
  ) on commit drop;
  delete from _digest2;

  for v_sup in
    select s.id, s.full_name from public.agents s
    where s.role = 'field_supervisor' and s.employment_status = 'active'
  loop
    select array_agg(a.full_name order by a.full_name) into v_open
    from public.agents a
    join public.attendance_sessions x on x.agent_id = a.id and x.status = 'open'
    where a.supervisor_agent_id = v_sup.id;

    continue when v_open is null or array_length(v_open, 1) = 0;

    v_title := array_length(v_open, 1) || ' bukas pa ang session';
    v_body := array_to_string(v_open[1:3], ', ') || ' — hindi pa naka-check out.';

    insert into public.notification_log
      (recipient_agent_id, subject_agent_id, kind, title, body, payload)
    values
      (v_sup.id, null, 'open_sessions_digest', v_title, v_body,
       jsonb_build_object('open', to_jsonb(v_open)))
    returning id into v_id;

    insert into _digest2
    select v_id, d.push_token, v_title, v_body, jsonb_build_object('kind', 'digest')
    from public.devices d
    where d.agent_id = v_sup.id and d.is_current and d.push_token is not null;
  end loop;

  return query select * from _digest2;
end;
$$;

revoke all on function public.queue_critical_flag_pushes() from public, anon, authenticated;
revoke all on function public.queue_not_checked_in_digest() from public, anon, authenticated;
revoke all on function public.queue_open_sessions_digest() from public, anon, authenticated;
grant execute on function public.queue_critical_flag_pushes() to service_role;
grant execute on function public.queue_not_checked_in_digest() to service_role;
grant execute on function public.queue_open_sessions_digest() to service_role;

-- Schedules. Times are UTC; Manila is UTC+8, so 09:15 PHT = 01:15 UTC and
-- 20:00 PHT = 12:00 UTC. pg_cron has no timezone support, so this conversion
-- is the schedule — if PH ever adopts DST these need revisiting.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'push-critical-flags') then
      perform cron.unschedule('push-critical-flags');
    end if;
    if exists (select 1 from cron.job where jobname = 'push-not-checked-in-digest') then
      perform cron.unschedule('push-not-checked-in-digest');
    end if;
    if exists (select 1 from cron.job where jobname = 'push-open-sessions-digest') then
      perform cron.unschedule('push-open-sessions-digest');
    end if;
    -- Critical flags are swept every 2 minutes rather than pushed by trigger:
    -- a trigger would fire inside the transaction that raised the flag, and a
    -- slow FCM call must never hold an agent's sync open.
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
  else
    raise notice
      'pg_cron not installed — push queues created but NOT scheduled. Also '
      'requires pg_net and: alter database ... set app.settings.dispatch_url / '
      'app.settings.service_key.';
  end if;
end $$;
