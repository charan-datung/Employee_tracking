-- =============================================================================
-- Detector layer, part 1: persist the P5 derived signals + shared helpers.
--
-- captureVerifiedFix() already computes jitter_m, accuracy_variance and
-- null_sensor_count on the device (they are the browser-grade heuristics that
-- catch a spoofer who patched the native `simulated` flag), but nothing
-- carried them to the server. Checks 7 and 8 cannot exist without them.
--
-- These are OBSERVATIONS, not verdicts: the client reports what its sensors
-- did, and the server decides what that means. A lying client can report
-- flattering numbers — which is exactly why zero_jitter and
-- null_sensor_fields are corroborating signals inside a scoring model, never
-- a single-source conviction.
-- =============================================================================

alter table public.attendance_sessions
  add column open_jitter_m double precision,
  add column open_accuracy_variance double precision,
  add column open_null_sensor_count smallint,
  add column open_sample_count smallint,
  add column close_jitter_m double precision,
  add column close_accuracy_variance double precision,
  add column close_null_sensor_count smallint,
  add column close_sample_count smallint;

alter table public.visits
  add column arrive_jitter_m double precision,
  add column arrive_accuracy_variance double precision,
  add column arrive_null_sensor_count smallint,
  add column arrive_sample_count smallint;

grant insert (
  open_jitter_m, open_accuracy_variance, open_null_sensor_count,
  open_sample_count
) on public.attendance_sessions to authenticated;

grant update (
  close_jitter_m, close_accuracy_variance, close_null_sensor_count,
  close_sample_count
) on public.attendance_sessions to authenticated;

grant insert (
  arrive_jitter_m, arrive_accuracy_variance, arrive_null_sensor_count,
  arrive_sample_count
) on public.visits to authenticated;

-- -----------------------------------------------------------------------------
-- Server-anchored capture time.
--
-- READ THIS BEFORE CHANGING ANY SEQUENCE DETECTOR.
--
-- Velocity, teleport and gap analysis need the time an observation was MADE.
-- received_at_server cannot supply it: the sync engine ships offline records
-- in batches of 50, so fifty pings spanning three hours and four kilometres
-- can share one received_at_server to the second. Differencing those would
-- manufacture infinite speeds on every agent who worked through a dead cell.
--
-- So sequence detectors use the device's capture time RE-ANCHORED to server
-- time with device_clock_offset_ms — an offset the SERVER measured against
-- its own clock at sync (never a value the device chose). The device's raw
-- claim is never used directly, and clock_skew / uptime_regression run first
-- precisely so a manipulated clock is itself flagged and visible next to
-- whatever the sequence detectors concluded.
--
-- Durations that become STORED FACTS (dwell_seconds_server) still use pure
-- server timestamps and are untouched by this.
-- -----------------------------------------------------------------------------

create or replace function public.anchored_at(
  p_captured_at_device timestamptz,
  p_offset_ms bigint
) returns timestamptz
language sql immutable parallel safe
as $$
  select p_captured_at_device
       + coalesce(p_offset_ms, 0) * interval '1 millisecond';
$$;

-- -----------------------------------------------------------------------------
-- raise_flag_once — one unresolved flag per (session, visit, type).
--
-- Without this, a batch of 50 pings from a device with a skewed clock would
-- produce 50 identical clock_skew flags and bury the triage queue. A
-- supervisor needs to know THAT the clock is wrong, once, with evidence — not
-- fifty times. Re-raising is allowed only after someone resolves the previous
-- one.
-- -----------------------------------------------------------------------------

create or replace function public.raise_flag_once(
  p_session_id uuid,
  p_visit_id uuid,
  p_agent_id uuid,
  p_type public.integrity_flag_type,
  p_severity public.flag_severity,
  p_detail jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.integrity_flags f
    where f.flag_type = p_type
      and f.resolved_at is null
      and f.session_id is not distinct from p_session_id
      and f.visit_id is not distinct from p_visit_id
  ) then
    return false;
  end if;

  insert into public.integrity_flags
    (session_id, visit_id, agent_id, flag_type, severity, detail)
  values
    (p_session_id, p_visit_id, p_agent_id, p_type, p_severity, p_detail);
  return true;
end;
$$;

revoke all on function public.raise_flag_once(uuid, uuid, uuid, public.integrity_flag_type, public.flag_severity, jsonb)
  from public, anon, authenticated;
revoke all on function public.anchored_at(timestamptz, bigint) from anon;
