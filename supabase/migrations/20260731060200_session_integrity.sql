-- =============================================================================
-- Detector layer, part 3: SESSION-LEVEL CHECKS + scoring.
--
-- These are sequence properties — they need the whole session, so they run
-- once, ten minutes after close (late pings from a reconnecting phone get a
-- chance to land first). Idempotent: raise_flag_once suppresses duplicates and
-- the score is recomputed from scratch, so re-running is always safe.
--
-- Sequence timing uses anchored_at() — see 20260731060000 for why
-- received_at_server cannot be differenced across an offline batch.
-- =============================================================================

create or replace function public.max_plausible_speed_kmh() returns double precision language sql immutable as $$ select 120.0::double precision $$;
create or replace function public.teleport_min_metres()     returns double precision language sql immutable as $$ select 2000.0::double precision $$;
create or replace function public.teleport_max_seconds()    returns double precision language sql immutable as $$ select 90.0::double precision $$;
create or replace function public.ping_gap_minutes()        returns double precision language sql immutable as $$ select 20.0::double precision $$;
create or replace function public.ping_gap_min_session_minutes() returns double precision language sql immutable as $$ select 45.0::double precision $$;
create or replace function public.static_session_metres()   returns double precision language sql immutable as $$ select 300.0::double precision $$;
create or replace function public.geofence_miss_rate_threshold() returns double precision language sql immutable as $$ select 0.40::double precision $$;

create or replace function public.evaluate_session_integrity(p_session_id uuid)
returns jsonb
language plpgsql
security definer
-- PostGIS types are resolved here (ST_Distance via distance_m).
set search_path = public, extensions
as $$
declare
  v_session public.attendance_sessions;
  v_session_minutes double precision;
  v_row record;
  v_gap_count integer := 0;
  v_gaps jsonb := '[]'::jsonb;
  v_span_m double precision;
  v_visit_clients integer;
  v_client_spread_m double precision;
  v_visit_total integer;
  v_visit_missed integer;
  v_miss_rate double precision;
  v_backfill_max integer;
  v_critical integer;
  v_warn integer;
  v_score integer;
begin
  select * into v_session from public.attendance_sessions where id = p_session_id;
  if v_session.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_session_minutes := extract(epoch from (
    coalesce(v_session.closed_at_server, now()) - v_session.opened_at_server
  )) / 60.0;

  -- ---------------------------------------------------------------------
  -- 10 + 11. Consecutive-ping geometry: impossible_velocity and teleport.
  -- Distance from PostGIS (distance_m -> ST_Distance on geography), time
  -- from the server-anchored capture times.
  -- ---------------------------------------------------------------------
  for v_row in
    with ordered as (
      select
        public.anchored_at(p.captured_at_device, p.device_clock_offset_ms) as at,
        p.lat, p.lng, p.battery_pct
      from public.location_pings p
      where p.session_id = p_session_id
      order by 1
    ),
    pairs as (
      select
        at,
        lag(at) over (order by at) as prev_at,
        lat, lng,
        lag(lat) over (order by at) as prev_lat,
        lag(lng) over (order by at) as prev_lng
      from ordered
    )
    select
      prev_at, at, prev_lat, prev_lng, lat, lng,
      extract(epoch from (at - prev_at)) as seconds,
      public.distance_m(prev_lat, prev_lng, lat, lng) as metres
    from pairs
    where prev_at is not null
  loop
    -- Two samples at the same instant carry no velocity information.
    if v_row.seconds is null or v_row.seconds <= 0 then
      continue;
    end if;

    -- 11. teleport first: a spoofer that jumps rather than interpolates.
    if v_row.metres > public.teleport_min_metres()
       and v_row.seconds < public.teleport_max_seconds() then
      perform public.raise_flag_once(
        p_session_id, null, v_session.agent_id, 'teleport', 'critical',
        jsonb_build_object(
          'metres', round(v_row.metres::numeric, 0),
          'seconds', round(v_row.seconds::numeric, 1),
          'from', jsonb_build_array(v_row.prev_lat, v_row.prev_lng),
          'to', jsonb_build_array(v_row.lat, v_row.lng),
          'at', v_row.at));

    -- 10. impossible_velocity: physically possible jump, implausible speed.
    elsif (v_row.metres / v_row.seconds) * 3.6 > public.max_plausible_speed_kmh() then
      perform public.raise_flag_once(
        p_session_id, null, v_session.agent_id, 'impossible_velocity', 'critical',
        jsonb_build_object(
          'implied_kmh', round(((v_row.metres / v_row.seconds) * 3.6)::numeric, 1),
          'metres', round(v_row.metres::numeric, 0),
          'seconds', round(v_row.seconds::numeric, 1),
          'at', v_row.at));
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- 12. ping_gap, CORRELATED WITH BATTERY.
  --
  -- The correlation is the entire point. A gap that ends with the battery
  -- far lower than it started, or that starts near empty, is a phone that
  -- died — an ordinary human event that deserves a conversation, if
  -- anything. A gap across which the battery barely moved is a phone that
  -- was alive and awake while the app was not reporting: either an OEM
  -- battery killer or a deliberate stop, and that deserves a look.
  --
  -- Getting this wrong in the harsh direction is how a system like this
  -- destroys trust with the people it monitors. The hint below is written
  -- for a supervisor to read out loud.
  -- ---------------------------------------------------------------------
  if v_session_minutes > public.ping_gap_min_session_minutes() then
    for v_row in
      with ordered as (
        select
          public.anchored_at(p.captured_at_device, p.device_clock_offset_ms) as at,
          p.battery_pct, p.is_charging
        from public.location_pings p
        where p.session_id = p_session_id
        order by 1
      ),
      pairs as (
        select
          at, battery_pct,
          lag(at) over (order by at) as prev_at,
          lag(battery_pct) over (order by at) as prev_battery
        from ordered
      )
      select
        prev_at, at, prev_battery, battery_pct,
        extract(epoch from (at - prev_at)) / 60.0 as gap_minutes
      from pairs
      where prev_at is not null
        and extract(epoch from (at - prev_at)) / 60.0 > public.ping_gap_minutes()
    loop
      v_gap_count := v_gap_count + 1;
      v_gaps := v_gaps || jsonb_build_object(
        'gap_minutes', round(v_row.gap_minutes::numeric, 1),
        'from', v_row.prev_at,
        'to', v_row.at,
        'battery_before_pct', v_row.prev_battery,
        'battery_after_pct', v_row.battery_pct,
        'battery_delta_pct',
          case when v_row.prev_battery is null or v_row.battery_pct is null
               then null else v_row.battery_pct - v_row.prev_battery end,
        'likely_cause',
          case
            when v_row.prev_battery is null or v_row.battery_pct is null
              then 'unknown_no_battery_data'
            when v_row.prev_battery <= 15 and v_row.battery_pct > v_row.prev_battery
              then 'battery_died_then_charged'
            when v_row.battery_pct - v_row.prev_battery <= -15
              then 'heavy_battery_drain'
            when abs(v_row.battery_pct - v_row.prev_battery) <= 3
              then 'app_stopped_while_phone_alive'
            else 'inconclusive'
          end,
        'supervisor_hint',
          case
            when v_row.prev_battery is null or v_row.battery_pct is null
              then 'No battery telemetry across this gap. Ask before assuming anything.'
            when v_row.prev_battery <= 15 and v_row.battery_pct > v_row.prev_battery
              then 'Phone almost certainly died and was charged. Treat as normal; consider a power bank.'
            when v_row.battery_pct - v_row.prev_battery <= -15
              then 'Battery drained hard across the gap — consistent with a dying phone, not a disabled app.'
            when abs(v_row.battery_pct - v_row.prev_battery) <= 3
              then 'Battery barely moved: the phone was alive but the app was not reporting. Check OEM battery settings first — this is usually the phone, not the agent.'
            else 'Mixed signals. Worth a conversation before any conclusion.'
          end);
    end loop;

    if v_gap_count > 0 then
      perform public.raise_flag_once(
        p_session_id, null, v_session.agent_id, 'ping_gap',
        case when v_gap_count >= 2 then 'critical'::public.flag_severity
             else 'warn'::public.flag_severity end,
        jsonb_build_object('gap_count', v_gap_count,
                           'session_minutes', round(v_session_minutes::numeric, 0),
                           'gaps', v_gaps));
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- 13. offline_backfill_bulk — a large block of stale records landing at
  --     once. Normal for an agent who worked a dead cell all morning, so it
  --     is only a WARN; it exists to explain OTHER flags, not to accuse.
  -- ---------------------------------------------------------------------
  select max(cnt) into v_backfill_max
  from (
    select count(*) over (
      order by p.received_at_server
      range between interval '30 seconds' preceding
                and interval '30 seconds' following
    ) as cnt
    from public.location_pings p
    where p.session_id = p_session_id
      and p.received_at_server - p.captured_at_device > interval '4 hours'
  ) dense;

  if coalesce(v_backfill_max, 0) > 40 then
    perform public.raise_flag_once(
      p_session_id, null, v_session.agent_id, 'offline_backfill_bulk', 'warn',
      jsonb_build_object('records_in_one_minute', v_backfill_max,
                         'capture_to_receipt_hours_min', 4));
  end if;

  -- ---------------------------------------------------------------------
  -- 14. static_session — the highest-signal check in the list. The device
  --     never meaningfully moved, yet the agent claims visits to clients
  --     that are far apart from each other. One of those two things is
  --     false, and the GPS trail is the one that is hard to fake downward.
  -- ---------------------------------------------------------------------
  select coalesce(max(public.distance_m(a.lat, a.lng, b.lat, b.lng)), 0)
  into v_span_m
  from public.location_pings a, public.location_pings b
  where a.session_id = p_session_id and b.session_id = p_session_id;

  select count(distinct v.client_id) into v_visit_clients
  from public.visits v where v.session_id = p_session_id;

  select coalesce(max(public.distance_m(c1.lat, c1.lng, c2.lat, c2.lng)), 0)
  into v_client_spread_m
  from public.visits v1
  join public.clients c1 on c1.id = v1.client_id
  join public.visits v2 on v2.session_id = v1.session_id
  join public.clients c2 on c2.id = v2.client_id
  where v1.session_id = p_session_id
    and c1.lat is not null and c2.lat is not null;

  if v_span_m < public.static_session_metres()
     and v_visit_clients >= 3
     and v_client_spread_m > public.static_session_metres() then
    perform public.raise_flag_once(
      p_session_id, null, v_session.agent_id, 'static_session', 'critical',
      jsonb_build_object(
        'device_span_m', round(v_span_m::numeric, 0),
        'distinct_clients_claimed', v_visit_clients,
        'client_spread_m', round(v_client_spread_m::numeric, 0),
        'note', 'device never left a 300m circle while claiming visits to clients further apart than that'));
  end if;

  -- ---------------------------------------------------------------------
  -- 15. geofence_miss_rate — occasional misses are Cavite addressing; a
  --     session that is mostly misses is a different story.
  -- ---------------------------------------------------------------------
  select count(*) filter (where v.is_within_geofence is not null),
         count(*) filter (where v.is_within_geofence is false)
  into v_visit_total, v_visit_missed
  from public.visits v where v.session_id = p_session_id;

  if coalesce(v_visit_total, 0) > 0 then
    v_miss_rate := v_visit_missed::double precision / v_visit_total;
    if v_miss_rate > public.geofence_miss_rate_threshold() then
      perform public.raise_flag_once(
        p_session_id, null, v_session.agent_id, 'geofence_miss', 'warn',
        jsonb_build_object('kind', 'session_geofence_miss_rate',
                           'visits_outside', v_visit_missed,
                           'visits_total', v_visit_total,
                           'miss_rate', round(v_miss_rate::numeric, 2)));
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- SCORING
  --
  -- 100, minus 30 per CRITICAL, minus 8 per WARN, floored at 0.
  --
  -- ============================ READ THIS ============================
  -- THIS SCORE ORDERS A TRIAGE QUEUE. IT DOES NOT DISCIPLINE ANYONE.
  --
  -- It exists so a supervisor with forty agents and twenty minutes knows
  -- which session to open first. It is not a performance metric, not an
  -- input to pay, promotion, or discipline, and not evidence of anything on
  -- its own — every flag beneath it has a human explanation at least as
  -- often as a dishonest one (dead phones, OEM battery killers, bad
  -- subdivision pins, cheap GPS chipsets).
  --
  -- DO NOT BUILD AUTOMATED CONSEQUENCES ON THIS NUMBER. No auto-suspension,
  -- no auto-deduction, no ranking agents by it, no surfacing it to the agent
  -- as a grade. If someone asks for that, the answer is a conversation about
  -- what the flags actually mean, not a threshold.
  -- ==================================================================
  -- ---------------------------------------------------------------------
  select
    count(*) filter (where f.severity = 'critical'),
    count(*) filter (where f.severity = 'warn')
  into v_critical, v_warn
  from public.integrity_flags f
  where f.session_id = p_session_id;

  v_score := greatest(0, 100 - (30 * v_critical) - (8 * v_warn));

  update public.attendance_sessions
  set integrity_score = v_score
  where id = p_session_id;

  return jsonb_build_object(
    'status', 'ok',
    'session_id', p_session_id,
    'integrity_score', v_score,
    'critical_flags', v_critical,
    'warn_flags', v_warn);
end;
$$;

revoke all on function public.evaluate_session_integrity(uuid)
  from public, anon, authenticated;
grant execute on function public.evaluate_session_integrity(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Scheduling: "10 minutes after each session closes".
--
-- pg_cron is interval-based, not event-based, so the equivalent is a sweep
-- every 5 minutes that picks up sessions closed at least 10 minutes ago and
-- not yet scored. Same guarantee, and it self-heals: a session missed during
-- an outage is simply picked up on the next sweep instead of being lost.
-- -----------------------------------------------------------------------------

create or replace function public.evaluate_pending_sessions()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select s.id from public.attendance_sessions s
    where s.status in ('closed', 'auto_closed')
      and s.integrity_score is null
      and coalesce(s.closed_at_server, s.opened_at_server) < now() - interval '10 minutes'
    order by s.closed_at_server
    limit 200
  loop
    perform public.evaluate_session_integrity(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.evaluate_pending_sessions()
  from public, anon, authenticated;
grant execute on function public.evaluate_pending_sessions() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'evaluate-session-integrity') then
      perform cron.unschedule('evaluate-session-integrity');
    end if;
    perform cron.schedule(
      'evaluate-session-integrity',
      '*/5 * * * *',
      'select public.evaluate_pending_sessions()'
    );
  else
    raise notice
      'pg_cron is not installed — evaluate_pending_sessions() was created but '
      'NOT scheduled. Sessions will only be scored when the edge function is '
      'called manually.';
  end if;
end $$;
