-- =============================================================================
-- Auto-close for sessions the agent never closed, plus the self-report flag
-- type the check-in flow needs.
-- =============================================================================

-- Repeated failure to get ANY usable fix (three attempts in a row) is a
-- device-level signal the agent reports about themselves — same category as
-- mock_attempt_blocked, not a detector verdict. Recreated rather than altered
-- because a policy's WITH CHECK cannot be extended in place.
drop policy flags_insert_self_report on public.integrity_flags;

create policy flags_insert_self_report on public.integrity_flags
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and flag_type in (
      'mock_attempt_blocked',
      'sync_anomaly',
      'permission_revoked',
      'accuracy_degraded'
    )
  );

-- -----------------------------------------------------------------------------
-- auto_close_stale_sessions
--
-- A session open longer than 16 hours is not a work day — the agent forgot to
-- check out. The server closes it as 'auto_closed'.
--
-- NOTHING IS FABRICATED. close_lat, close_lng, close_accuracy_m,
-- close_is_mocked, close_photo_path, close_photo_sha256 and closed_at_device
-- all stay NULL: the device never reported a check-out, so there is no
-- observation to record. Only closed_at_server is stamped, because the server
-- genuinely did close it at that moment — status='auto_closed' is what
-- distinguishes it from an agent's real check-out. Any report that treats
-- closed_at_server as "when the agent stopped working" MUST exclude
-- auto_closed rows.
--
-- SECURITY DEFINER, owned by postgres: it is the sanctioned writer for
-- integrity_flags and audit_log here, both of which are closed to every
-- ordinary role.
-- -----------------------------------------------------------------------------

create or replace function public.auto_close_stale_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed integer := 0;
  v_row record;
begin
  for v_row in
    with stale as (
      update public.attendance_sessions s
      set status = 'auto_closed',
          closed_at_server = now()
      where s.status = 'open'
        -- Judged on the SERVER's clock, never the device's claim.
        and s.opened_at_server < now() - interval '16 hours'
      returning s.id, s.agent_id, s.opened_at_server
    )
    select * from stale
  loop
    insert into public.integrity_flags
      (session_id, agent_id, flag_type, severity, detail)
    values
      (v_row.id, v_row.agent_id, 'session_never_closed', 'warn',
       jsonb_build_object(
         'kind', 'auto_closed_after_16h',
         'opened_at_server', v_row.opened_at_server,
         'auto_closed_at', now()));

    insert into public.audit_log
      (actor_auth_user_id, actor_role, action, entity_table, entity_id,
       before, after)
    values
      (null, 'system', 'auto_close_session', 'attendance_sessions', v_row.id,
       jsonb_build_object('status', 'open'),
       jsonb_build_object('status', 'auto_closed', 'close_coordinates', null));

    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

revoke all on function public.auto_close_stale_sessions()
  from public, anon, authenticated;

comment on function public.auto_close_stale_sessions() is
  'Hourly pg_cron job. Closes sessions open >16h as auto_closed with NULL '
  'close coordinates and raises session_never_closed. Never fabricates a '
  'check-out observation.';

-- -----------------------------------------------------------------------------
-- Schedule it hourly. pg_cron must be enabled for the project first
-- (Supabase: Dashboard -> Database -> Extensions -> pg_cron). The migration
-- deliberately does NOT create the extension: on Supabase it must live in the
-- dedicated extensions schema, and failing loudly here would block every
-- other migration on a project where it has not been enabled yet.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (
      select 1 from cron.job where jobname = 'auto-close-stale-sessions'
    ) then
      perform cron.unschedule('auto-close-stale-sessions');
    end if;
    perform cron.schedule(
      'auto-close-stale-sessions',
      '0 * * * *',
      'select public.auto_close_stale_sessions()'
    );
  else
    raise notice
      'pg_cron is not installed — auto_close_stale_sessions() was created but '
      'NOT scheduled. Enable pg_cron and re-run the DO block at the bottom of '
      'this migration, or sessions will never be auto-closed.';
  end if;
end $$;
