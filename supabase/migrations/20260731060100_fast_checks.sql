-- =============================================================================
-- Detector layer, part 2: FAST CHECKS — evaluated as records arrive.
--
-- Every one of these is a property of a single record (or of it and its
-- immediate predecessor), so they run in AFTER INSERT triggers and a
-- supervisor sees them within seconds of a sync. All thresholds and all
-- comparisons are server-side; the record only supplies the observation.
-- =============================================================================

-- Thresholds, named once so the tests and the detectors cannot drift apart.
create or replace function public.clock_skew_warn_ms()     returns bigint language sql immutable as $$ select 300000::bigint $$;    -- 5 min
create or replace function public.clock_skew_critical_ms() returns bigint language sql immutable as $$ select 3600000::bigint $$;   -- 1 hour
create or replace function public.max_capture_accuracy_m() returns double precision language sql immutable as $$ select 100.0::double precision $$;
create or replace function public.zero_jitter_min_samples() returns integer language sql immutable as $$ select 4 $$;
create or replace function public.null_sensor_accuracy_m() returns double precision language sql immutable as $$ select 20.0::double precision $$;

-- -----------------------------------------------------------------------------
-- Shared evaluators, applied to whichever capture the trigger is looking at.
-- -----------------------------------------------------------------------------

-- 1. mock_location. P5 rejects simulated fixes AT CAPTURE and never persists
--    one, so a true value arriving here means the reject path did not run:
--    a patched APK, or a build old enough to predate the check. The app
--    version is recorded because that distinction decides the response —
--    "update your app" versus "we need to talk about your phone".
create or replace function public.check_mock_location(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid,
  p_is_mocked boolean, p_context text
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_device public.devices;
begin
  if p_is_mocked is not true then return; end if;
  select d.* into v_device
  from public.devices d
  where d.agent_id = p_agent_id and d.is_current
  limit 1;

  perform public.raise_flag_once(
    p_session_id, p_visit_id, p_agent_id, 'mock_location', 'critical',
    jsonb_build_object(
      'context', p_context,
      'app_version', v_device.app_version,
      'os_version', v_device.os_version,
      'webview_version', v_device.webview_version,
      'note', 'is_mocked=true should be impossible after P5 capture rejection'));
end;
$$;

-- 3. clock_skew — how far the device's clock sits from the server's, using
--    the offset the SERVER measured at sync.
create or replace function public.check_clock_skew(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid,
  p_offset_ms bigint, p_context text
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_severity public.flag_severity;
begin
  if p_offset_ms is null then return; end if;
  if abs(p_offset_ms) > public.clock_skew_critical_ms() then
    v_severity := 'critical';
  elsif abs(p_offset_ms) > public.clock_skew_warn_ms() then
    v_severity := 'warn';
  else
    return;
  end if;

  perform public.raise_flag_once(
    p_session_id, p_visit_id, p_agent_id, 'clock_skew', v_severity,
    jsonb_build_object(
      'context', p_context,
      'offset_ms', p_offset_ms,
      'offset_minutes', round((p_offset_ms / 60000.0)::numeric, 1)));
end;
$$;

-- 5. accuracy_degraded on a capture event.
create or replace function public.check_capture_accuracy(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid,
  p_accuracy_m double precision, p_context text
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_accuracy_m is null or p_accuracy_m <= public.max_capture_accuracy_m() then
    return;
  end if;
  perform public.raise_flag_once(
    p_session_id, p_visit_id, p_agent_id, 'accuracy_degraded', 'warn',
    jsonb_build_object('context', p_context,
                       'accuracy_m', round(p_accuracy_m::numeric, 1)));
end;
$$;

-- 6. duplicate_photo_hash — the same image bytes submitted twice by one
--    agent. This catches resubmitting a saved selfie, which is the most
--    common low-effort attendance fraud there is. Scoped per agent: two
--    agents cannot produce the same hash by accident, and if they do it is a
--    different (worse) problem than this check is for.
create or replace function public.check_duplicate_photo(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid,
  p_sha256 text, p_context text
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_prior text;
begin
  if p_sha256 is null then return; end if;

  select 'session:' || s.id::text into v_prior
  from public.attendance_sessions s
  where s.agent_id = p_agent_id
    and (s.id <> coalesce(p_session_id, '00000000-0000-0000-0000-000000000000'::uuid)
         or p_visit_id is not null)
    and (s.open_photo_sha256 = p_sha256 or s.close_photo_sha256 = p_sha256)
  limit 1;

  if v_prior is null then
    select 'visit:' || v.id::text into v_prior
    from public.visits v
    where v.agent_id = p_agent_id
      and v.photo_sha256 = p_sha256
      and v.id is distinct from p_visit_id
    limit 1;
  end if;

  if v_prior is null then return; end if;

  perform public.raise_flag_once(
    p_session_id, p_visit_id, p_agent_id, 'duplicate_photo_hash', 'critical',
    jsonb_build_object('context', p_context, 'sha256', p_sha256,
                       'previously_used_by', v_prior));
end;
$$;

-- 7 + 8. Heuristics over the P5 derived signals — the checks that survive a
--        spoofer patching the native `simulated` flag.
create or replace function public.check_derived_signals(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid,
  p_jitter_m double precision, p_sample_count smallint,
  p_null_sensor_count smallint, p_accuracy_m double precision,
  p_context text
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- 7. zero_jitter: real stationary GPS always wanders 3-10m across samples.
  --    Exactly zero wander across four or more samples means the coordinates
  --    were synthesised, not measured.
  if p_jitter_m is not null
     and p_sample_count is not null
     and p_jitter_m = 0
     and p_sample_count >= public.zero_jitter_min_samples() then
    perform public.raise_flag_once(
      p_session_id, p_visit_id, p_agent_id, 'zero_jitter', 'critical',
      jsonb_build_object('context', p_context, 'sample_count', p_sample_count,
                         'jitter_m', 0));
  end if;

  -- 8. null_sensor_fields: altitude, speed AND bearing all absent on a fix
  --    claiming high accuracy. Real Android high-accuracy GPS populates them;
  --    most spoofers return null for all three. WARN, not critical — a cold
  --    fix from a cheap chipset can legitimately look like this.
  if p_null_sensor_count = 3
     and p_accuracy_m is not null
     and p_accuracy_m < public.null_sensor_accuracy_m() then
    perform public.raise_flag_once(
      p_session_id, p_visit_id, p_agent_id, 'null_sensor_fields', 'warn',
      jsonb_build_object('context', p_context,
                         'accuracy_m', round(p_accuracy_m::numeric, 1),
                         'null_sensors', 'altitude,speed,bearing'));
  end if;
end;
$$;

-- 9. motion_contradiction — RESERVED, v2.
--    When DeviceMotion sampling exists on the client, flag "GPS reports
--    >15 km/h while the accelerometer reports a stationary device". The flag
--    type is already in the enum and this stub keeps the contract visible;
--    it deliberately raises nothing until there is real accelerometer data to
--    contradict the GPS with. Do not invent a proxy signal here.
create or replace function public.check_motion_contradiction(
  p_session_id uuid, p_visit_id uuid, p_agent_id uuid
) returns void
language plpgsql immutable
as $$ begin return; end; $$;

comment on function public.check_motion_contradiction(uuid, uuid, uuid) is
  'Reserved for v2. Requires client-side DeviceMotion sampling that does not '
  'exist yet. Raises nothing by design.';

-- -----------------------------------------------------------------------------
-- Trigger: attendance_sessions (check-in on insert, check-out on update)
-- -----------------------------------------------------------------------------

create or replace function public.sessions_fast_checks()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_bound uuid;
begin
  if tg_op = 'INSERT' then
    perform public.check_mock_location(new.id, null, new.agent_id, new.open_is_mocked, 'check_in');
    perform public.check_clock_skew(new.id, null, new.agent_id, new.device_clock_offset_ms, 'check_in');
    perform public.check_capture_accuracy(new.id, null, new.agent_id, new.open_accuracy_m, 'check_in');
    perform public.check_duplicate_photo(new.id, null, new.agent_id, new.open_photo_sha256, 'check_in');
    perform public.check_derived_signals(new.id, null, new.agent_id,
      new.open_jitter_m, new.open_sample_count, new.open_null_sensor_count,
      new.open_accuracy_m, 'check_in');

    -- 2. device_mismatch — the session claims a device that is not the one
    --    currently bound to this agent. Either an old binding resurfaced or
    --    the record was authored somewhere it should not have been.
    select d.id into v_bound
    from public.devices d where d.agent_id = new.agent_id and d.is_current limit 1;
    if v_bound is not null and new.device_id <> v_bound then
      perform public.raise_flag_once(
        new.id, null, new.agent_id, 'device_mismatch', 'critical',
        jsonb_build_object('record_device_id', new.device_id,
                           'agent_current_device_id', v_bound,
                           'context', 'check_in'));
    end if;

  elsif tg_op = 'UPDATE' and old.closed_at_device is null
        and new.closed_at_device is not null then
    perform public.check_mock_location(new.id, null, new.agent_id, new.close_is_mocked, 'check_out');
    perform public.check_clock_skew(new.id, null, new.agent_id, new.device_clock_offset_ms, 'check_out');
    perform public.check_capture_accuracy(new.id, null, new.agent_id, new.close_accuracy_m, 'check_out');
    perform public.check_duplicate_photo(new.id, null, new.agent_id, new.close_photo_sha256, 'check_out');
    perform public.check_derived_signals(new.id, null, new.agent_id,
      new.close_jitter_m, new.close_sample_count, new.close_null_sensor_count,
      new.close_accuracy_m, 'check_out');
  end if;

  return null;
end;
$$;

create trigger sessions_fast_checks_trg
  after insert or update on public.attendance_sessions
  for each row execute function public.sessions_fast_checks();

-- -----------------------------------------------------------------------------
-- Trigger: visits
-- -----------------------------------------------------------------------------

create or replace function public.visits_fast_checks()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.check_mock_location(new.session_id, new.id, new.agent_id, new.arrive_is_mocked, 'visit_arrive');
  perform public.check_clock_skew(new.session_id, new.id, new.agent_id, new.device_clock_offset_ms, 'visit_arrive');
  perform public.check_capture_accuracy(new.session_id, new.id, new.agent_id, new.arrive_accuracy_m, 'visit_arrive');
  perform public.check_duplicate_photo(new.session_id, new.id, new.agent_id, new.photo_sha256, 'visit');
  perform public.check_derived_signals(new.session_id, new.id, new.agent_id,
    new.arrive_jitter_m, new.arrive_sample_count, new.arrive_null_sensor_count,
    new.arrive_accuracy_m, 'visit_arrive');
  return null;
end;
$$;

create trigger visits_fast_checks_trg
  after insert on public.visits
  for each row execute function public.visits_fast_checks();

-- -----------------------------------------------------------------------------
-- Trigger: location_pings
--
-- Pings arrive in batches of 50, so this stays cheap: two column tests and
-- one indexed lookup for the uptime comparison. raise_flag_once collapses a
-- whole bad batch into one flag.
-- -----------------------------------------------------------------------------

create or replace function public.pings_fast_checks()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_prev public.location_pings;
  v_wall_delta_ms bigint;
  v_uptime_delta_ms bigint;
begin
  perform public.check_mock_location(new.session_id, null, new.agent_id, new.is_mocked, 'ping');
  perform public.check_clock_skew(new.session_id, null, new.agent_id, new.device_clock_offset_ms, 'ping');

  -- 4. uptime_regression — wall clock moved BACKWARDS while the monotonic
  --    clock moved forwards. Only a deliberately reset clock does that.
  --
  --    NOTE: device_uptime_ms is performance.now(), which RESETS when the app
  --    restarts (documented in services/location/plugins.ts). A decrease in
  --    uptime is therefore an expected restart, not tampering, and is
  --    ignored. Only the forwards-uptime/backwards-wall-clock combination is
  --    evidence.
  if new.device_uptime_ms is not null then
    select p.* into v_prev
    from public.location_pings p
    where p.session_id = new.session_id
      and p.id <> new.id
      and p.device_uptime_ms is not null
      and p.device_uptime_ms <= new.device_uptime_ms
    order by p.device_uptime_ms desc
    limit 1;

    if v_prev.id is not null then
      v_uptime_delta_ms := new.device_uptime_ms - v_prev.device_uptime_ms;
      v_wall_delta_ms := (extract(epoch from
        (new.captured_at_device - v_prev.captured_at_device)) * 1000)::bigint;

      if v_uptime_delta_ms > 0 and v_wall_delta_ms < 0 then
        perform public.raise_flag_once(
          new.session_id, null, new.agent_id, 'uptime_regression', 'critical',
          jsonb_build_object(
            'uptime_delta_ms', v_uptime_delta_ms,
            'wall_clock_delta_ms', v_wall_delta_ms,
            'note', 'wall clock moved backwards while monotonic uptime advanced'));
      end if;
    end if;
  end if;

  return null;
end;
$$;

create trigger pings_fast_checks_trg
  after insert on public.location_pings
  for each row execute function public.pings_fast_checks();
