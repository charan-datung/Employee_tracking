-- pgTAP proof of the v1 RLS policies. Run with `supabase test db` (or psql as
-- a superuser against a database with both migrations applied).
-- Everything happens in one rolled-back transaction; fixtures use fixed UUIDs
-- in ranges the seed does not use.

begin;
create extension if not exists pgtap;

-- =============================================================================
-- Fixtures (inserted as superuser/owner — bypasses RLS)
--
-- Reporting tree:            top_sup            other_sup   (different branch,
--                               │                            no reports)
--                            mid_sup
--                            ┌──┴──┐
--                        agent_a  agent_b
-- =============================================================================

insert into auth.users (id) values
  ('f0000000-0000-4000-8000-00000000000a'),  -- agent_a
  ('f0000000-0000-4000-8000-00000000000b'),  -- agent_b
  ('f0000000-0000-4000-8000-00000000000c'),  -- top_sup
  ('f0000000-0000-4000-8000-00000000000d'),  -- mid_sup
  ('f0000000-0000-4000-8000-00000000000e');  -- other_sup

insert into public.agents (id, auth_user_id, employee_no, full_name, role, branch_id, supervisor_agent_id) values
  ('99999999-9999-4999-8999-999999999901', 'f0000000-0000-4000-8000-00000000000c',
   'TST-9001', 'Top Supervisor', 'field_supervisor', '11111111-1111-4111-8111-111111111101', null),
  ('99999999-9999-4999-8999-999999999902', 'f0000000-0000-4000-8000-00000000000d',
   'TST-9002', 'Mid Supervisor', 'field_supervisor', '11111111-1111-4111-8111-111111111101',
   '99999999-9999-4999-8999-999999999901'),
  ('99999999-9999-4999-8999-999999999903', 'f0000000-0000-4000-8000-00000000000e',
   'TST-9003', 'Other Branch Supervisor', 'field_supervisor', '11111111-1111-4111-8111-111111111102', null),
  ('99999999-9999-4999-8999-999999999904', 'f0000000-0000-4000-8000-00000000000a',
   'TST-9004', 'Agent Alpha', 'sales_agent', '11111111-1111-4111-8111-111111111101',
   '99999999-9999-4999-8999-999999999902'),
  ('99999999-9999-4999-8999-999999999905', 'f0000000-0000-4000-8000-00000000000b',
   'TST-9005', 'Agent Bravo', 'collector', '11111111-1111-4111-8111-111111111101',
   '99999999-9999-4999-8999-999999999902');

insert into public.devices (id, agent_id, android_id, is_current) values
  ('88888888-8888-4888-8888-888888888801', '99999999-9999-4999-8999-999999999904', 'a1b2c3d4e5f60001', true),
  ('88888888-8888-4888-8888-888888888802', '99999999-9999-4999-8999-999999999905', 'a1b2c3d4e5f60002', true);

insert into public.attendance_sessions
  (id, agent_id, device_id, opened_at_device, open_lat, open_lng, open_accuracy_m,
   open_is_mocked, open_photo_path, open_photo_sha256, open_branch_id,
   status, closed_at_device, closed_at_server, close_lat, close_lng, close_accuracy_m, close_is_mocked)
values
  -- agent_a: one open, one already closed
  ('77777777-7777-4777-8777-777777777701', '99999999-9999-4999-8999-999999999904',
   '88888888-8888-4888-8888-888888888801', now(), 14.4512, 120.9822, 8.0, false,
   'checkin/a-open.jpg', 'sha-a-open', '11111111-1111-4111-8111-111111111101',
   'open', null, null, null, null, null, null),
  ('77777777-7777-4777-8777-777777777702', '99999999-9999-4999-8999-999999999904',
   '88888888-8888-4888-8888-888888888801', now() - interval '1 day', 14.4512, 120.9822, 7.0, false,
   'checkin/a-closed.jpg', 'sha-a-closed', '11111111-1111-4111-8111-111111111101',
   'closed', now() - interval '1 day' + interval '9 hours',
   now() - interval '1 day' + interval '9 hours', 14.4515, 120.9825, 9.0, false),
  -- agent_b: one open
  ('77777777-7777-4777-8777-777777777703', '99999999-9999-4999-8999-999999999905',
   '88888888-8888-4888-8888-888888888802', now(), 14.4512, 120.9822, 8.5, false,
   'checkin/b-open.jpg', 'sha-b-open', '11111111-1111-4111-8111-111111111101',
   'open', null, null, null, null, null, null);

insert into public.clients (id, display_name, account_type, city, lat, lng, assigned_agent_id) values
  ('66666666-6666-4666-8666-666666666601', 'Client Of Alpha', 'coco_martin_group',
   'Las Piñas', 14.4400, 120.9900, '99999999-9999-4999-8999-999999999904'),
  ('66666666-6666-4666-8666-666666666602', 'Client Of Bravo', 'trust_loan_sme',
   'Las Piñas', 14.4410, 120.9910, '99999999-9999-4999-8999-999999999905');

-- pings exist for both agents (a's in the closed session, b's in the open one)
insert into public.location_pings
  (id, session_id, agent_id, captured_at_device, lat, lng, accuracy_m, is_mocked, source)
values
  ('44444444-4444-4444-8444-444444444401', '77777777-7777-4777-8777-777777777702',
   '99999999-9999-4999-8999-999999999904', now() - interval '1 day', 14.4513, 120.9823, 10, false, 'interval'),
  ('44444444-4444-4444-8444-444444444402', '77777777-7777-4777-8777-777777777703',
   '99999999-9999-4999-8999-999999999905', now(), 14.4514, 120.9824, 11, false, 'interval');

insert into public.integrity_flags (id, session_id, agent_id, flag_type, severity, detail) values
  ('55555555-5555-4555-8555-555555555501', '77777777-7777-4777-8777-777777777701',
   '99999999-9999-4999-8999-999999999904', 'ping_gap', 'warn', '{"gap_seconds": 1800}');

insert into public.audit_log (actor_role, action, entity_table, entity_id) values
  ('service_role', 'test_fixture', 'attendance_sessions', '77777777-7777-4777-8777-777777777701');

select plan(36);

-- =============================================================================
-- Meta: nothing slipped through
-- =============================================================================

select is_empty(
  $$ select c.relname from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname <> 'spatial_ref_sys' and not c.relrowsecurity $$,
  'every public table has RLS enabled');

select is_empty(
  $$ select t.tablename from pg_tables t
     where t.schemaname = 'public'
       and t.tablename not in ('audit_log', 'spatial_ref_sys')
       and not exists (select 1 from pg_policies p
                       where p.schemaname = 'public' and p.tablename = t.tablename) $$,
  'every table except audit_log has at least one policy');

-- =============================================================================
-- As agent_a (sales_agent)
-- =============================================================================

select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-00000000000a', false);
set local role authenticated;

select results_eq(
  $$ select count(*)::int from public.attendance_sessions $$,
  $$ values (2) $$,
  'control: agent A sees exactly their own two sessions');

-- SPEC 1
select is_empty(
  $$ select id from public.attendance_sessions
     where agent_id = '99999999-9999-4999-8999-999999999905' $$,
  'SPEC 1: agent A cannot SELECT agent B''s attendance_sessions');

select is_empty(
  $$ select id from public.agents where id = '99999999-9999-4999-8999-999999999905' $$,
  'agent A cannot SELECT agent B''s agents row');

-- SPEC 2
select throws_ok(
  $$ insert into public.visits
       (id, session_id, agent_id, client_id, arrived_at_device,
        arrive_lat, arrive_lng, arrive_accuracy_m, arrive_is_mocked)
     values
       ('33333333-3333-4333-8333-333333333301',
        '77777777-7777-4777-8777-777777777703',
        '99999999-9999-4999-8999-999999999905',
        '66666666-6666-4666-8666-666666666602',
        now(), 14.4410, 120.9910, 9, false) $$,
  '42501',
  'new row violates row-level security policy for table "visits"',
  'SPEC 2: agent A cannot INSERT a visit with agent_id = B');

select throws_ok(
  $$ insert into public.visits
       (id, session_id, agent_id, client_id, arrived_at_device,
        arrive_lat, arrive_lng, arrive_accuracy_m, arrive_is_mocked)
     values
       ('33333333-3333-4333-8333-333333333302',
        '77777777-7777-4777-8777-777777777703',
        '99999999-9999-4999-8999-999999999904',
        '66666666-6666-4666-8666-666666666601',
        now(), 14.4400, 120.9900, 9, false) $$,
  '42501',
  'new row violates row-level security policy for table "visits"',
  'agent A cannot INSERT a visit as themself into B''s session either');

-- SPEC 3
select throws_ok(
  $$ insert into public.location_pings
       (id, session_id, agent_id, captured_at_device, lat, lng, accuracy_m, is_mocked, source)
     values
       ('44444444-4444-4444-8444-444444444403',
        '77777777-7777-4777-8777-777777777702',
        '99999999-9999-4999-8999-999999999904',
        now(), 14.4513, 120.9823, 10, false, 'interval') $$,
  '42501',
  'new row violates row-level security policy for table "location_pings"',
  'SPEC 3: agent A cannot INSERT a ping into a closed session');

select lives_ok(
  $$ insert into public.location_pings
       (id, session_id, agent_id, captured_at_device, lat, lng, accuracy_m, is_mocked, source)
     values
       ('44444444-4444-4444-8444-444444444404',
        '77777777-7777-4777-8777-777777777701',
        '99999999-9999-4999-8999-999999999904',
        now(), 14.4513, 120.9823, 10, false, 'foreground') $$,
  'control: agent A CAN insert a ping into their own open session');

-- SPEC 4 — even though A owns pings (including the one just inserted)
select is_empty(
  $$ select id from public.location_pings $$,
  'SPEC 4: agent A cannot SELECT any location_pings at all — not even their own');

-- SPEC 5 — a closed session is not updatable: 0 rows match, nothing returns
select is_empty(
  $$ with u as (
       update public.attendance_sessions
       set close_photo_path = 'tampered.jpg'
       where id = '77777777-7777-4777-8777-777777777702'
       returning id)
     select * from u $$,
  'SPEC 5: agent A cannot UPDATE a session after status=''closed''');

-- SPEC 9
select is_empty(
  $$ select id from public.clients
     where id = '66666666-6666-4666-8666-666666666602' $$,
  'SPEC 9: agent A cannot SELECT clients assigned to agent B');

select results_eq(
  $$ select id from public.clients $$,
  $$ values ('66666666-6666-4666-8666-666666666601'::uuid) $$,
  'control: agent A sees exactly their own client book');

select is_empty(
  $$ select id from public.integrity_flags $$,
  'agent A cannot SELECT integrity_flags (including flags raised against them)');

select throws_ok(
  $$ delete from public.attendance_sessions $$,
  '42501',
  'permission denied for table attendance_sessions',
  'agent A cannot DELETE — privilege revoked, fails loudly');

select lives_ok(
  $$ update public.attendance_sessions
     set status = 'closed',
         closed_at_device = now(),
         close_lat = 14.4515, close_lng = 120.9820,
         close_accuracy_m = 9.0, close_is_mocked = false,
         close_photo_path = 'checkout/a.jpg', close_photo_sha256 = 'sha-a-close'
     where id = '77777777-7777-4777-8777-777777777701' $$,
  'control: agent A CAN close their own open session');

select is(
  (select status::text from public.attendance_sessions
   where id = '77777777-7777-4777-8777-777777777701'),
  'closed',
  'control: the session is now closed');

select is_empty(
  $$ with u as (
       update public.attendance_sessions
       set close_photo_path = 'second-thoughts.jpg'
       where id = '77777777-7777-4777-8777-777777777701'
       returning id)
     select * from u $$,
  'closing is terminal: the freshly closed session is no longer updatable');

-- =============================================================================
-- As top_sup — TWO levels above agent_a (top_sup -> mid_sup -> agent_a)
-- =============================================================================

reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-00000000000c', false);
set local role authenticated;

-- SPEC 6
select isnt_empty(
  $$ select id from public.attendance_sessions
     where agent_id = '99999999-9999-4999-8999-999999999904' $$,
  'SPEC 6: a supervisor two levels up CAN see the agent''s sessions');

select isnt_empty(
  $$ select id from public.location_pings
     where agent_id = '99999999-9999-4999-8999-999999999904' $$,
  'supervisor can see their tree''s location_pings');

select isnt_empty(
  $$ select id from public.integrity_flags
     where agent_id = '99999999-9999-4999-8999-999999999904' $$,
  'supervisor can see their tree''s integrity_flags');

select throws_ok(
  $$ insert into public.attendance_sessions
       (id, agent_id, device_id, opened_at_device, open_lat, open_lng,
        open_accuracy_m, open_is_mocked, open_photo_path, open_photo_sha256, open_branch_id)
     values
       ('77777777-7777-4777-8777-777777777704',
        '99999999-9999-4999-8999-999999999904',
        '88888888-8888-4888-8888-888888888801',
        now(), 14.4512, 120.9822, 8.0, false, 'checkin/fake.jpg', 'sha-fake',
        '11111111-1111-4111-8111-111111111101') $$,
  '42501',
  'new row violates row-level security policy for table "attendance_sessions"',
  'supervisor can NEVER insert attendance data on behalf of an agent');

select lives_ok(
  $$ update public.attendance_sessions
     set status = 'voided',
         void_reason = 'GPS trail inconsistent with visit photos',
         voided_by_agent_id = '99999999-9999-4999-8999-999999999901'
     where id = '77777777-7777-4777-8777-777777777702' $$,
  'supervisor CAN void a report''s session with a reason');

select is(
  (select status::text from public.attendance_sessions
   where id = '77777777-7777-4777-8777-777777777702'),
  'voided',
  'the voided session is voided');

select throws_ok(
  $$ update public.attendance_sessions
     set status = 'voided', void_reason = null,
         voided_by_agent_id = '99999999-9999-4999-8999-999999999901'
     where id = '77777777-7777-4777-8777-777777777703' $$,
  '42501',
  'new row violates row-level security policy for table "attendance_sessions"',
  'voiding without a void_reason is rejected');

select lives_ok(
  $$ update public.integrity_flags
     set resolved_at = now(),
         resolved_by_agent_id = '99999999-9999-4999-8999-999999999901',
         resolution_note = 'Reviewed: LTE dead zone, not tampering'
     where id = '55555555-5555-4555-8555-555555555501' $$,
  'supervisor CAN resolve an integrity flag');

select lives_ok(
  $$ update public.devices
     set is_current = false, revoked_at = now(), revoke_reason = 'phone reported lost'
     where id = '88888888-8888-4888-8888-888888888801' $$,
  'supervisor CAN revoke a report''s device binding');

-- =============================================================================
-- As mid_sup — direct supervisor
-- =============================================================================

reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-00000000000d', false);
set local role authenticated;

select isnt_empty(
  $$ select id from public.attendance_sessions
     where agent_id = '99999999-9999-4999-8999-999999999904' $$,
  'direct supervisor can see the agent''s sessions');

-- =============================================================================
-- As other_sup — a supervisor with NO reports, different branch
-- =============================================================================

reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-00000000000e', false);
set local role authenticated;

-- SPEC 7
select is_empty(
  $$ select id from public.attendance_sessions
     where agent_id = '99999999-9999-4999-8999-999999999904' $$,
  'SPEC 7: a supervisor in a different branch CANNOT see the agent''s sessions');

select is_empty(
  $$ select id from public.location_pings $$,
  'a supervisor outside the tree sees no pings at all');

-- =============================================================================
-- audit_log — locked for everyone
-- =============================================================================

reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-00000000000a', false);
set local role authenticated;

-- SPEC 8 (authenticated)
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501',
  'permission denied for table audit_log',
  'SPEC 8: authenticated cannot DELETE from audit_log');

select throws_ok(
  $$ select id from public.audit_log $$,
  '42501',
  'permission denied for table audit_log',
  'authenticated cannot even SELECT audit_log');

reset role;
set local role service_role;

-- SPEC 8 (service_role — BYPASSRLS does not bypass privilege revokes)
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501',
  'permission denied for table audit_log',
  'SPEC 8: even service_role cannot DELETE from audit_log');

select throws_ok(
  $$ insert into public.audit_log (action) values ('forged') $$,
  '42501',
  'permission denied for table audit_log',
  'service_role cannot INSERT into audit_log directly (triggers only)');

select throws_ok(
  $$ update public.audit_log set action = 'rewritten' $$,
  '42501',
  'permission denied for table audit_log',
  'service_role cannot UPDATE audit_log');

-- =============================================================================
-- anon — nothing
-- =============================================================================

reset role;
set local role anon;

select throws_ok(
  $$ select id from public.branches $$,
  '42501',
  'permission denied for table branches',
  'anon has no access to anything, not even branches');

reset role;
select * from finish();
rollback;
