-- pgTAP fixtures for the integrity detector layer.
--
-- Five sessions, each engineered to trip a specific detector and NOTHING
-- else. The "and nothing else" half matters more than the positive half: a
-- detector that also fires on honest work is worse than no detector, because
-- it teaches supervisors to ignore the queue.
--
-- Run inside one rolled-back transaction.

begin;
create extension if not exists pgtap;

select plan(24);

-- =============================================================================
-- Shared fixture scaffolding
-- =============================================================================

create temporary table t (base timestamptz) on commit drop;
insert into t values ('2026-07-30 01:00:00+00');

-- Five agents so each scenario owns a session (one open session per agent).
insert into auth.users (id)
select ('e0000000-0000-4000-8000-00000000000' || n)::uuid
from generate_series(1, 5) n;

update public.agents a set auth_user_id = u.id
from (
  select ('e0000000-0000-4000-8000-00000000000' || n)::uuid as id,
         'DTG-000' || (n + 1) as emp
  from generate_series(1, 5) n
) u
where a.employee_no = u.emp;

insert into public.devices (id, agent_id, android_id, is_current, app_version)
select ('dddd0000-0000-4000-8000-00000000000' || n)::uuid, a.id,
       'devhash0000000' || n, true, '1.4.2'
from generate_series(1, 5) n
join public.agents a on a.employee_no = 'DTG-000' || (n + 1);

-- Sessions: 1=clean 2=teleport 3=battery-gap 4=static 5=zero-jitter
insert into public.attendance_sessions
  (id, agent_id, device_id, opened_at_device, opened_at_server,
   open_lat, open_lng, open_accuracy_m, open_is_mocked,
   open_photo_path, open_photo_sha256, open_branch_id,
   open_jitter_m, open_accuracy_variance, open_null_sensor_count,
   open_sample_count, device_clock_offset_ms,
   status, closed_at_device, closed_at_server,
   close_lat, close_lng, close_accuracy_m, close_is_mocked,
   close_photo_path, close_photo_sha256,
   close_jitter_m, close_null_sensor_count, close_sample_count)
select
  ('55550000-0000-4000-8000-00000000000' || n)::uuid,
  a.id,
  ('dddd0000-0000-4000-8000-00000000000' || n)::uuid,
  (select base from t), (select base from t),
  14.4512, 120.9822, 9.4, false,
  'checkin/' || n || '.jpg', 'sha-open-' || n,
  a.branch_id,
  -- session 5 is the zero-jitter one; the rest wander normally
  case when n = 5 then 0.0 else 5.3 end, 2.1, 0, 5, 1200,
  'closed',
  (select base from t) + interval '5 hours',
  (select base from t) + interval '5 hours',
  14.4512, 120.9822, 8.8, false,
  'checkout/' || n || '.jpg', 'sha-close-' || n,
  4.7, 0, 5
from generate_series(1, 5) n
join public.agents a on a.employee_no = 'DTG-000' || (n + 1);

-- Helper: a ping, with sane defaults so each scenario only overrides what it
-- is actually testing.
create or replace function pg_temp.ping(
  p_session int, p_minutes int, p_lat double precision, p_lng double precision,
  p_battery int default 80
) returns void language plpgsql as $$
declare v_agent uuid; v_base timestamptz;
begin
  select agent_id into v_agent from public.attendance_sessions
   where id = ('55550000-0000-4000-8000-00000000000' || p_session)::uuid;
  select base into v_base from t;
  insert into public.location_pings
    (session_id, agent_id, captured_at_device, received_at_server,
     device_clock_offset_ms, device_uptime_ms, lat, lng, accuracy_m,
     altitude_m, speed_mps, bearing, is_mocked, battery_pct, is_charging, source)
  values
    (('55550000-0000-4000-8000-00000000000' || p_session)::uuid, v_agent,
     v_base + (p_minutes || ' minutes')::interval,
     v_base + (p_minutes || ' minutes')::interval + interval '3 seconds',
     1200, p_minutes * 60000, p_lat, p_lng, 12.0,
     18.0, 0.6, 90.0, false, p_battery, false, 'interval');
end;
$$;

-- Helper: a visit whose arrival is AT the client's own pin (so the geofence
-- passes and only the detector under test can fire).
create or replace function pg_temp.visit_at_client(
  p_session int, p_minutes int, p_client uuid, p_sha text
) returns void language plpgsql as $$
declare v_agent uuid; v_base timestamptz; v_lat double precision; v_lng double precision;
begin
  select agent_id into v_agent from public.attendance_sessions
   where id = ('55550000-0000-4000-8000-00000000000' || p_session)::uuid;
  select base into v_base from t;
  select lat, lng into v_lat, v_lng from public.clients where id = p_client;
  insert into public.visits
    (session_id, agent_id, client_id, arrived_at_device, arrived_at_server,
     arrive_lat, arrive_lng, arrive_accuracy_m, arrive_is_mocked,
     arrive_jitter_m, arrive_null_sensor_count, arrive_sample_count,
     device_clock_offset_ms, outcome, photo_path, photo_sha256)
  values
    (('55550000-0000-4000-8000-00000000000' || p_session)::uuid, v_agent, p_client,
     v_base + (p_minutes || ' minutes')::interval,
     v_base + (p_minutes || ' minutes')::interval,
     v_lat, v_lng, 11.0, false, 4.2, 0, 5, 1200,
     'contacted_paid', 'visit/' || p_sha || '.jpg', p_sha);
end;
$$;

-- Three seeded clients that are comfortably more than 300m apart.
-- c1 Lourdes Bakeshop (14.4770,121.0208) · c3 Sucat Hardware (14.4645,121.0470)
-- c6 Rowena Salazar   (14.4938,121.0096)

-- =============================================================================
-- (a) CLEAN SESSION — real movement, dense pings, visits inside geofences.
-- =============================================================================
-- 15-minute cadence: inside the 20-minute gap threshold, which is what a
-- real 5-min/50m throttle produces once the agent is moving.
select pg_temp.ping(1, 0,   14.4512, 120.9822, 95);
select pg_temp.ping(1, 15,  14.4560, 120.9900, 94);
select pg_temp.ping(1, 30,  14.4620, 121.0000, 92);
select pg_temp.ping(1, 45,  14.4700, 121.0100, 90);
select pg_temp.ping(1, 60,  14.4770, 121.0208, 88);
select pg_temp.visit_at_client(1, 65, 'cccccccc-cccc-4ccc-8ccc-cccccccc0001', 'sha-visit-a1');
select pg_temp.ping(1, 75,  14.4750, 121.0250, 86);
select pg_temp.ping(1, 90,  14.4700, 121.0350, 84);
select pg_temp.ping(1, 105, 14.4670, 121.0420, 82);
select pg_temp.ping(1, 120, 14.4645, 121.0470, 80);
select pg_temp.visit_at_client(1, 125, 'cccccccc-cccc-4ccc-8ccc-cccccccc0003', 'sha-visit-a2');
select pg_temp.ping(1, 135, 14.4700, 121.0400, 78);
select pg_temp.ping(1, 150, 14.4800, 121.0280, 76);
select pg_temp.ping(1, 165, 14.4870, 121.0180, 74);
select pg_temp.ping(1, 180, 14.4938, 121.0096, 72);
select pg_temp.visit_at_client(1, 185, 'cccccccc-cccc-4ccc-8ccc-cccccccc0006', 'sha-visit-a3');
select pg_temp.ping(1, 195, 14.4850, 121.0000, 70);
select pg_temp.ping(1, 210, 14.4700, 120.9950, 68);
select pg_temp.ping(1, 225, 14.4600, 120.9880, 66);
select pg_temp.ping(1, 240, 14.4512, 120.9822, 64);

-- =============================================================================
-- (b) SPOOFED WITH TELEPORTS — 3km jumps 60s apart.
-- =============================================================================
select pg_temp.ping(2, 0,  14.4512, 120.9822, 90);
select pg_temp.ping(2, 10, 14.4515, 120.9825, 89);
select pg_temp.ping(2, 11, 14.4770, 121.0208, 88);   -- ~3.1km in 60s
select pg_temp.ping(2, 12, 14.4515, 120.9825, 87);   -- and back
select pg_temp.ping(2, 20, 14.4516, 120.9826, 86);

-- =============================================================================
-- (c) DEAD-BATTERY GAP — 40 min of silence, battery 8% -> 46% (died, charged).
-- =============================================================================
select pg_temp.ping(3, 0,   14.4512, 120.9822, 40);
select pg_temp.ping(3, 15,  14.4530, 120.9850, 24);
select pg_temp.ping(3, 30,  14.4550, 120.9880, 8);
select pg_temp.ping(3, 75,  14.4570, 120.9900, 46);   -- 45 min gap, recharged
select pg_temp.ping(3, 90,  14.4580, 120.9910, 44);
select pg_temp.ping(3, 105, 14.4590, 120.9920, 42);

-- =============================================================================
-- (d) STATIC SESSION — device never leaves a 50m circle, yet claims three
--     visits to clients kilometres apart, each "arrived" at the client's pin.
-- =============================================================================
select pg_temp.ping(4, 0,   14.4512, 120.98220, 90);
select pg_temp.ping(4, 15,  14.4513, 120.98222, 89);
select pg_temp.ping(4, 30,  14.4512, 120.98218, 88);
select pg_temp.ping(4, 45,  14.4513, 120.98221, 87);
select pg_temp.ping(4, 60,  14.4512, 120.98219, 86);
select pg_temp.ping(4, 75,  14.4513, 120.98220, 85);
select pg_temp.ping(4, 90,  14.4512, 120.98221, 84);
select pg_temp.ping(4, 105, 14.4513, 120.98219, 83);
select pg_temp.ping(4, 120, 14.4512, 120.98220, 82);
select pg_temp.ping(4, 135, 14.4513, 120.98218, 81);
select pg_temp.ping(4, 150, 14.4512, 120.98222, 80);
select pg_temp.visit_at_client(4, 40,  'cccccccc-cccc-4ccc-8ccc-cccccccc0001', 'sha-visit-d1');
select pg_temp.visit_at_client(4, 100, 'cccccccc-cccc-4ccc-8ccc-cccccccc0003', 'sha-visit-d2');
select pg_temp.visit_at_client(4, 140, 'cccccccc-cccc-4ccc-8ccc-cccccccc0006', 'sha-visit-d3');

-- =============================================================================
-- (e) ZERO-JITTER CHECK-IN — open_jitter_m = 0 across 5 samples (set above).
--     Short session, no visits: nothing else can fire.
-- =============================================================================
update public.attendance_sessions
set closed_at_device = (select base from t) + interval '30 minutes',
    closed_at_server = (select base from t) + interval '30 minutes'
where id = '55550000-0000-4000-8000-000000000005';
select pg_temp.ping(5, 0,  14.4512, 120.9822, 90);
select pg_temp.ping(5, 10, 14.4530, 120.9840, 89);
select pg_temp.ping(5, 20, 14.4550, 120.9860, 88);

-- =============================================================================
-- Run the session-level evaluation for all five.
-- =============================================================================
select public.evaluate_session_integrity(
  ('55550000-0000-4000-8000-00000000000' || n)::uuid)
from generate_series(1, 5) n;

-- =============================================================================
-- ASSERTIONS — exact flag sets, then the scores.
-- =============================================================================

-- (a) clean
select is_empty(
  $$ select flag_type::text from public.integrity_flags
     where session_id = '55550000-0000-4000-8000-000000000001' $$,
  '(a) clean session raises NO flags at all');

select is(
  (select integrity_score from public.attendance_sessions
   where id = '55550000-0000-4000-8000-000000000001'),
  100, '(a) clean session scores 100');

-- (b) teleport
select set_eq(
  $$ select distinct flag_type::text from public.integrity_flags
     where session_id = '55550000-0000-4000-8000-000000000002' $$,
  array['teleport'],
  '(b) spoofed session raises teleport and nothing else');

select is(
  (select count(*)::int from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000002'
     and flag_type = 'teleport'),
  1, '(b) the two jumps collapse into ONE flag, not a queue full of them');

select is(
  (select severity::text from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000002'
     and flag_type = 'teleport'),
  'critical', '(b) teleport is CRITICAL');

select ok(
  (select (detail->>'metres')::numeric from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000002'
     and flag_type = 'teleport') > 2000,
  '(b) teleport detail carries the displacement');

select is(
  (select integrity_score from public.attendance_sessions
   where id = '55550000-0000-4000-8000-000000000002'),
  70, '(b) one critical scores 100-30 = 70');

-- (c) dead-battery gap
select set_eq(
  $$ select distinct flag_type::text from public.integrity_flags
     where session_id = '55550000-0000-4000-8000-000000000003' $$,
  array['ping_gap'],
  '(c) dead-battery session raises ping_gap and nothing else');

select is(
  (select severity::text from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000003'),
  'warn', '(c) a single gap is WARN, not CRITICAL');

select is(
  (select detail->'gaps'->0->>'likely_cause' from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000003'),
  'battery_died_then_charged',
  '(c) BATTERY CORRELATION: the gap is identified as a dead phone');

select matches(
  (select detail->'gaps'->0->>'supervisor_hint' from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000003'),
  'Treat as normal',
  '(c) the supervisor hint tells them this is NOT an investigation');

select is(
  (select (detail->'gaps'->0->>'battery_before_pct')::int from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000003'),
  8, '(c) battery before the gap is recorded');

select is(
  (select integrity_score from public.attendance_sessions
   where id = '55550000-0000-4000-8000-000000000003'),
  92, '(c) one warn scores 100-8 = 92');

-- (d) static session
select set_eq(
  $$ select distinct flag_type::text from public.integrity_flags
     where session_id = '55550000-0000-4000-8000-000000000004' $$,
  array['static_session'],
  '(d) static session raises static_session and nothing else');

select is(
  (select severity::text from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000004'),
  'critical', '(d) static_session is CRITICAL');

select ok(
  (select (detail->>'device_span_m')::numeric from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000004') < 300,
  '(d) detail shows the device never left a 300m circle');

select is(
  (select (detail->>'distinct_clients_claimed')::int from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000004'),
  3, '(d) detail shows three distinct clients were claimed');

select ok(
  (select (detail->>'client_spread_m')::numeric from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000004') > 300,
  '(d) detail shows those clients are far apart');

-- (e) zero jitter
select set_eq(
  $$ select distinct flag_type::text from public.integrity_flags
     where session_id = '55550000-0000-4000-8000-000000000005' $$,
  array['zero_jitter'],
  '(e) zero-jitter check-in raises zero_jitter and nothing else');

select is(
  (select severity::text from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000005'),
  'critical', '(e) zero_jitter is CRITICAL');

select is(
  (select (detail->>'sample_count')::int from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000005'),
  5, '(e) detail records how many samples showed zero wander');

-- Scoring floor and the fast-check path, proven directly.
select is(
  (select greatest(0, 100 - 30 * 4 - 8 * 1)),
  0, 'scoring floors at 0 rather than going negative');

-- A mocked ping must flag CRITICAL and name the app version, since that is
-- what distinguishes a stale build from a patched APK.
select lives_ok(
  $$ insert into public.location_pings
       (session_id, agent_id, captured_at_device, lat, lng, accuracy_m,
        is_mocked, source)
     select '55550000-0000-4000-8000-000000000001', agent_id,
            '2026-07-30 03:00:00+00', 14.45, 120.98, 10, true, 'interval'
     from public.attendance_sessions
     where id = '55550000-0000-4000-8000-000000000001' $$,
  'a mocked ping inserts (the server records it, then judges it)');

select is(
  (select detail->>'app_version' from public.integrity_flags
   where session_id = '55550000-0000-4000-8000-000000000001'
     and flag_type = 'mock_location'),
  '1.4.2',
  'mock_location records the app version that produced it');

select * from finish();
rollback;
