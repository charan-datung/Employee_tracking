-- =============================================================================
-- v1 row-level security — deny by default, least privilege
--
-- Role model (Supabase):
--   * authenticated — every field user (sales_agent, collector,
--     field_supervisor). Which of the role-specific policies apply is decided
--     per-row by the agents.role of the caller, resolved via current_agent().
--   * anon — nothing. All privileges revoked.
--   * service_role — back office + edge functions. service_role has BYPASSRLS,
--     so RLS policies cannot constrain it; what DOES constrain it is table
--     privileges, which BYPASSRLS does not skip. That is how audit_log is
--     locked down below. "Back office is read-only, writes go through edge
--     functions" is an application-layer discipline (both use the service
--     key); it cannot be expressed in SQL beyond the audit_log revokes.
--
-- Enforcement layers used here, outermost first:
--   1. Table privileges  — what a role may attempt at all (e.g. agents have
--      no DELETE anywhere, no INSERT/UPDATE except the three write paths).
--   2. Column privileges — INSERT/UPDATE are granted per column, so a client
--      can never write server-computed fields (opened_at_server,
--      dwell_seconds_server, distances, summaries, integrity_score) and an
--      agent closing a session cannot retroactively rewrite its check-in
--      observation.
--   3. RLS policies      — which rows those statements may touch.
--
-- NOTE for future migrations: Supabase's default privileges grant ALL on new
-- tables to anon/authenticated/service_role. Every new table must repeat the
-- revoke/grant discipline below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper functions
-- All SECURITY DEFINER (owner: postgres, who bypasses RLS as table owner) so
-- policies can consult agents/attendance_sessions without recursing into the
-- policies of those tables. search_path pinned; every reference qualified.
-- -----------------------------------------------------------------------------

-- The caller's agents row, resolved from auth.uid(). NULL row if the JWT does
-- not map to an agent.
create or replace function public.current_agent()
returns public.agents
language sql
stable
security definer
set search_path = ''
as $$
  select a
  from public.agents a
  where a.auth_user_id = (select auth.uid())
  limit 1;
$$;

-- True iff the caller is a field_supervisor and target_agent_id is a STRICT
-- descendant in the reporting tree (recursive walk down supervisor_agent_id).
-- Excludes the caller: a supervisor is not their own report, so e.g. they do
-- not gain SELECT on their own location_pings through this.
-- UNION (not UNION ALL) so a bad supervisor_agent_id cycle terminates instead
-- of looping forever.
create or replace function public.is_supervisor_of(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive me as (
    select a.id
    from public.agents a
    where a.auth_user_id = (select auth.uid())
      and a.role = 'field_supervisor'
  ),
  tree as (
    select a.id from public.agents a join me on a.supervisor_agent_id = me.id
    union
    select a.id from public.agents a join tree t on a.supervisor_agent_id = t.id
  )
  select exists (select 1 from tree where tree.id = target_agent_id);
$$;

-- True iff p_session_id is an OPEN session owned by the caller. The gate for
-- writing visits and location_pings: nothing attaches to a closed, voided,
-- auto-closed, or foreign session.
create or replace function public.is_own_open_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.attendance_sessions s
    join public.agents a on a.id = s.agent_id
    where s.id = p_session_id
      and a.auth_user_id = (select auth.uid())
      and s.status = 'open'
  );
$$;

revoke all on function public.current_agent() from public, anon;
revoke all on function public.is_supervisor_of(uuid) from public, anon;
revoke all on function public.is_own_open_session(uuid) from public, anon;
grant execute on function public.current_agent() to authenticated, service_role;
grant execute on function public.is_supervisor_of(uuid) to authenticated, service_role;
grant execute on function public.is_own_open_session(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enable RLS on every table. A table with RLS enabled and no matching policy
-- denies everything (for roles without BYPASSRLS) — that is the default.
-- -----------------------------------------------------------------------------

alter table public.branches            enable row level security;
alter table public.agents              enable row level security;
alter table public.devices             enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.clients             enable row level security;
alter table public.visits              enable row level security;
alter table public.location_pings     enable row level security;
alter table public.integrity_flags     enable row level security;
alter table public.audit_log           enable row level security;
alter table public.consent_records     enable row level security;

-- -----------------------------------------------------------------------------
-- Privileges: wipe, then grant back exactly what the policies below arbitrate.
-- -----------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- DELETE: nothing, ever, for field users — revoked explicitly (and not
-- re-granted). With no DELETE privilege the attempt fails loudly with
-- "permission denied" instead of silently deleting zero RLS-hidden rows.
revoke delete on all tables in schema public from anon, authenticated;

-- audit_log: append-only via SECURITY DEFINER triggers owned by postgres
-- (added with the trigger migrations). No direct INSERT/UPDATE/DELETE for
-- ANYONE — including service_role, whose BYPASSRLS does not bypass privilege
-- checks. service_role keeps SELECT for back-office reads.
revoke all on public.audit_log from anon, authenticated;
revoke insert, update, delete on public.audit_log from service_role;

-- SELECT surface for field users; every table here has SELECT policies below
-- deciding which rows. location_pings SELECT is granted at the privilege
-- layer ONLY because supervisors read their tree's pings — non-supervisor
-- agents match no SELECT policy and always get zero rows.
grant select on
  public.branches,
  public.agents,
  public.devices,
  public.attendance_sessions,
  public.clients,
  public.visits,
  public.location_pings,
  public.integrity_flags,
  public.consent_records
to authenticated;

-- Write surface, per column. id is granted on the three insert paths because
-- the offline-first client generates UUIDs on device — the PK doubles as the
-- sync idempotency key (a retried upload hits the PK conflict instead of
-- duplicating the row).

-- Check-in: observation fields only. status (defaults 'open'), *_server
-- timestamps, distances, integrity_score and summaries are server-owned.
grant insert (
  id, agent_id, device_id, opened_at_device,
  open_lat, open_lng, open_accuracy_m, open_is_mocked,
  open_photo_path, open_photo_sha256, open_branch_id
) on public.attendance_sessions to authenticated;

-- Check-out + supervisor void. Deliberately excludes every open_* column:
-- an agent closing their session cannot rewrite where they checked in.
-- closed_at_server is server-stamped, not client-writable.
grant update (
  closed_at_device, close_lat, close_lng, close_accuracy_m, close_is_mocked,
  close_photo_path, close_photo_sha256,
  status, void_reason, voided_by_agent_id
) on public.attendance_sessions to authenticated;

-- Visit observation. arrived_at_server (default), arrive/depart *_server,
-- arrive_distance_from_client_m, dwell_seconds_server, is_within_geofence and
-- departure_was_inferred are server-owned and not granted.
grant insert (
  id, session_id, agent_id, client_id,
  arrived_at_device, arrive_lat, arrive_lng, arrive_accuracy_m,
  arrive_is_mocked, departed_at_device, depart_lat, depart_lng,
  outcome, outcome_notes, geofence_miss_reason, photo_path, photo_sha256
) on public.visits to authenticated;

-- Ping observation. received_at_server (default) and device_clock_offset_ms
-- (server-measured at sync) are not granted.
grant insert (
  id, session_id, agent_id, captured_at_device, device_uptime_ms,
  lat, lng, accuracy_m, altitude_m, altitude_accuracy_m, speed_mps, bearing,
  is_mocked, battery_pct, is_charging, source
) on public.location_pings to authenticated;

-- Supervisor device-rebind approval: bind state only, never the identity
-- columns (android_id, model, agent_id).
grant update (is_current, revoked_at, revoke_reason)
  on public.devices to authenticated;

-- Supervisor flag resolution: resolution fields only.
grant update (resolved_at, resolved_by_agent_id, resolution_note)
  on public.integrity_flags to authenticated;

-- PostGIS bookkeeping: the geometry->geography machinery may consult
-- spatial_ref_sys at run time; the blanket revoke above stripped it. Locate
-- it wherever the extension put it and restore read access.
do $$
declare srs regclass;
begin
  select c.oid::regclass into srs
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relname = 'spatial_ref_sys' and c.relkind = 'r'
  limit 1;
  if srs is not null then
    execute format('grant select on table %s to anon, authenticated, service_role', srs);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- branches
-- Not in the per-role spec, but check-in cannot work if the agent's app
-- cannot read branch coordinates/geofence; active branches are readable by
-- any authenticated field user. No writes (branch admin is back office).
-- -----------------------------------------------------------------------------

create policy branches_select_active on public.branches
  for select to authenticated
  using (is_active);

-- -----------------------------------------------------------------------------
-- agents
-- -----------------------------------------------------------------------------

-- Own row, matched directly on auth_user_id (cheaper than current_agent()
-- here, and agents is the one table current_agent() itself reads).
create policy agents_select_self on public.agents
  for select to authenticated
  using (auth_user_id = (select auth.uid()));

create policy agents_select_reports on public.agents
  for select to authenticated
  using (public.is_supervisor_of(id));

-- No INSERT/UPDATE/DELETE: the roster is owned by back office / HR sync.

-- -----------------------------------------------------------------------------
-- devices
-- -----------------------------------------------------------------------------

create policy devices_select_own on public.devices
  for select to authenticated
  using (agent_id = (select (public.current_agent()).id));

create policy devices_select_reports on public.devices
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- Rebind approval: supervisors may flip bind state on their reports' devices
-- (column grant restricts to is_current / revoked_at / revoke_reason).
-- Binding NEW devices is an edge-function (service key) operation.
create policy devices_update_reports on public.devices
  for update to authenticated
  using (public.is_supervisor_of(agent_id))
  with check (public.is_supervisor_of(agent_id));

-- -----------------------------------------------------------------------------
-- attendance_sessions
-- -----------------------------------------------------------------------------

create policy sessions_select_own on public.attendance_sessions
  for select to authenticated
  using (agent_id = (select (public.current_agent()).id));

create policy sessions_select_reports on public.attendance_sessions
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- Check-in: only as yourself, only an open session (column grants prevent
-- smuggling close_*/summary fields; status must be its default 'open').
-- Nobody — supervisors included — can insert attendance for someone else.
create policy sessions_insert_own_open on public.attendance_sessions
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and status = 'open'
  );

-- Check-out: an agent may transition their OWN OPEN session to 'closed',
-- once. USING hides non-open rows, so a closed/voided/auto_closed session is
-- not updatable by its agent at all; WITH CHECK pins the result to a plain
-- close (no self-void — void fields must stay empty).
create policy sessions_update_close_own on public.attendance_sessions
  for update to authenticated
  using (
    agent_id = (select (public.current_agent()).id)
    and status = 'open'
  )
  with check (
    agent_id = (select (public.current_agent()).id)
    and status = 'closed'
    and void_reason is null
    and voided_by_agent_id is null
  );

-- Supervisor void: any state -> 'voided', reason required, stamped with the
-- voiding supervisor's id. WITH CHECK re-asserts the tree so the two UPDATE
-- policies cannot be mixed (a permissive WITH CHECK from one policy would
-- otherwise satisfy a row matched by the other's USING).
create policy sessions_update_void_reports on public.attendance_sessions
  for update to authenticated
  using (public.is_supervisor_of(agent_id))
  with check (
    public.is_supervisor_of(agent_id)
    and status = 'voided'
    and void_reason is not null
    and voided_by_agent_id = (select (public.current_agent()).id)
  );

-- -----------------------------------------------------------------------------
-- clients
-- -----------------------------------------------------------------------------

create policy clients_select_assigned on public.clients
  for select to authenticated
  using (assigned_agent_id = (select (public.current_agent()).id));

create policy clients_select_reports on public.clients
  for select to authenticated
  using (public.is_supervisor_of(assigned_agent_id));

-- No writes: the client book is owned by the Odoo sync (service key).

-- -----------------------------------------------------------------------------
-- visits
-- -----------------------------------------------------------------------------

create policy visits_select_own on public.visits
  for select to authenticated
  using (agent_id = (select (public.current_agent()).id));

create policy visits_select_reports on public.visits
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- Record a visit: only as yourself, only into your own OPEN session.
create policy visits_insert_own_open_session on public.visits
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and public.is_own_open_session(session_id)
  );

-- No UPDATE for field users: departure/outcome corrections are server-side.

-- -----------------------------------------------------------------------------
-- location_pings
-- INSERT-only for the ping's own agent. Deliberately NO select-own policy:
-- agents cannot read their own trail — being able to replay it would let them
-- probe geofence boundaries and detector behaviour. Supervisors read their
-- tree's pings; back office reads via service key.
-- -----------------------------------------------------------------------------

create policy pings_insert_own_open_session on public.location_pings
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and public.is_own_open_session(session_id)
  );

create policy pings_select_reports on public.location_pings
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- -----------------------------------------------------------------------------
-- integrity_flags — invisible to the agents they are raised against.
-- -----------------------------------------------------------------------------

create policy flags_select_reports on public.integrity_flags
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- Resolution only (column grant: resolved_at / resolved_by_agent_id /
-- resolution_note), stamped with the resolving supervisor.
create policy flags_update_resolve_reports on public.integrity_flags
  for update to authenticated
  using (public.is_supervisor_of(agent_id))
  with check (
    public.is_supervisor_of(agent_id)
    and resolved_at is not null
    and resolved_by_agent_id = (select (public.current_agent()).id)
  );

-- -----------------------------------------------------------------------------
-- consent_records — an agent can always see what they consented to.
-- Acceptance is written by the consent edge function (service key), so no
-- INSERT policy here.
-- -----------------------------------------------------------------------------

create policy consent_select_own on public.consent_records
  for select to authenticated
  using (agent_id = (select (public.current_agent()).id));

create policy consent_select_reports on public.consent_records
  for select to authenticated
  using (public.is_supervisor_of(agent_id));

-- -----------------------------------------------------------------------------
-- audit_log: RLS enabled, ZERO policies — deny-all for every non-BYPASSRLS
-- role, and the privilege revokes above close INSERT/UPDATE/DELETE for
-- service_role too. Rows enter only via SECURITY DEFINER triggers owned by
-- postgres.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Self-check: fail the migration if any table slipped through.
--   * every public table must have RLS enabled
--     (spatial_ref_sys is PostGIS-owned reference data, not ours — exempt);
--   * every table except audit_log must carry at least one policy, so a
--     "deny everything" table can only be deliberate.
-- -----------------------------------------------------------------------------

do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname <> 'spatial_ref_sys'
    and not c.relrowsecurity;
  if bad is not null then
    raise exception 'tables with row level security disabled: %', bad;
  end if;

  select string_agg(t.tablename, ', ') into bad
  from pg_tables t
  where t.schemaname = 'public'
    and t.tablename not in ('audit_log', 'spatial_ref_sys')
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.tablename
    );
  if bad is not null then
    raise exception 'tables without any RLS policy: %', bad;
  end if;
end $$;
