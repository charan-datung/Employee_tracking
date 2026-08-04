-- =============================================================================
-- Admin capability: provisioning, roster CRUD, password resets.
--
-- BOOTSTRAPPING THE FIRST ADMIN (chicken-and-egg — read this before deploying)
--
-- Auth users cannot be created from SQL: Supabase hashes passwords and writes
-- auth.identities through the Auth Admin API, and forging those rows by hand
-- produces an account that cannot log in. So the FIRST admin is made by hand,
-- once, and every account after that is created through the console:
--
--   1. Supabase Dashboard -> Authentication -> Add user
--        email:    admin@datung.internal      (any employee_no works)
--        password: <something you change immediately>
--        [x] Auto Confirm User
--   2. Copy the new user's UUID, then run:
--
--        insert into public.agents
--          (auth_user_id, employee_no, full_name, role, branch_id,
--           employment_status, hired_at)
--        values
--          ('<uuid-from-step-1>', 'DTG-0000', 'System Administrator',
--           'admin', (select id from public.branches order by code limit 1),
--           'active', now());
--
--   3. Log into the console and create everyone else from /admin/agents.
--
-- Do not script step 1 into a migration. A migration that creates a login is
-- a migration that ships a default credential.
-- =============================================================================

create or replace function public.is_admin(p_auth_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.agents a
    where a.auth_user_id = p_auth_user_id
      and a.role = 'admin'
      and a.employment_status = 'active'
  );
$$;

create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin((select auth.uid()));
$$;

revoke all on function public.is_admin(uuid) from public, anon;
revoke all on function public.am_i_admin() from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;
grant execute on function public.am_i_admin() to authenticated, service_role;

-- Console access now means supervisor OR admin. Agents still get nothing.
create or replace function public.has_console_access(p_auth_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.agents a
    where a.auth_user_id = p_auth_user_id
      and a.role in ('field_supervisor', 'admin')
      and a.employment_status = 'active'
  );
$$;

-- -----------------------------------------------------------------------------
-- Admin read access. Supervisors see their tree; an admin sees the whole
-- roster, because they are the one who has to fix it when the tree is wrong.
-- -----------------------------------------------------------------------------

create policy agents_select_admin on public.agents
  for select to authenticated
  using (public.am_i_admin());

create policy branches_select_admin on public.branches
  for select to authenticated
  using (public.am_i_admin());

create policy clients_select_admin on public.clients
  for select to authenticated
  using (public.am_i_admin());

create policy devices_select_admin on public.devices
  for select to authenticated
  using (public.am_i_admin());

create policy sessions_select_admin on public.attendance_sessions
  for select to authenticated
  using (public.am_i_admin());

create policy flags_select_admin on public.integrity_flags
  for select to authenticated
  using (public.am_i_admin());

create policy visits_select_admin on public.visits
  for select to authenticated
  using (public.am_i_admin());

-- -----------------------------------------------------------------------------
-- Roster writes.
--
-- These are SECURITY DEFINER functions rather than RLS write policies on
-- purpose: creating an agent has to happen in the same breath as creating
-- their auth user (which only the Auth Admin API can do), so the console
-- server action orchestrates both and calls these for the database half.
-- Every one re-derives the actor from their auth id and refuses non-admins.
-- -----------------------------------------------------------------------------

create or replace function public.admin_create_agent(
  p_actor_auth_user_id uuid,
  p_new_auth_user_id uuid,
  p_employee_no text,
  p_full_name text,
  p_mobile_no text,
  p_role public.agent_role,
  p_branch_id uuid,
  p_supervisor_agent_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.agents;
  v_id uuid;
begin
  if not public.is_admin(p_actor_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_actor from public.agents where auth_user_id = p_actor_auth_user_id;

  if exists (select 1 from public.agents where employee_no = p_employee_no) then
    return jsonb_build_object('status', 'duplicate_employee_no');
  end if;

  -- Return a status rather than letting the FK raise. The console creates the
  -- auth user FIRST (only the Auth Admin API can), then calls this; if the
  -- agents row cannot be written it must delete that orphan user. A clean
  -- status makes that rollback deterministic — an exception would leave the
  -- caller guessing whether the insert happened.
  if not exists (select 1 from auth.users u where u.id = p_new_auth_user_id) then
    return jsonb_build_object('status', 'auth_user_missing');
  end if;

  insert into public.agents
    (auth_user_id, employee_no, full_name, mobile_no, role, branch_id,
     supervisor_agent_id, employment_status, hired_at)
  values
    (p_new_auth_user_id, p_employee_no, p_full_name, p_mobile_no, p_role,
     p_branch_id, p_supervisor_agent_id, 'active', now())
  returning id into v_id;

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id, after)
  values
    (p_actor_auth_user_id, 'admin', 'create_agent', 'agents', v_id,
     jsonb_build_object('employee_no', p_employee_no, 'role', p_role));

  return jsonb_build_object('status', 'ok', 'agent_id', v_id);
end;
$$;

create or replace function public.admin_update_agent(
  p_actor_auth_user_id uuid,
  p_agent_id uuid,
  p_full_name text,
  p_mobile_no text,
  p_role public.agent_role,
  p_branch_id uuid,
  p_supervisor_agent_id uuid,
  p_employment_status public.employment_status
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.agents;
begin
  if not public.is_admin(p_actor_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_before from public.agents where id = p_agent_id;
  if v_before.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- An agent cannot supervise themselves; that would make is_supervisor_of()
  -- walk a self-loop and hand someone their own oversight.
  if p_supervisor_agent_id = p_agent_id then
    return jsonb_build_object('status', 'self_supervision');
  end if;

  update public.agents
  set full_name = p_full_name,
      mobile_no = p_mobile_no,
      role = p_role,
      branch_id = p_branch_id,
      supervisor_agent_id = p_supervisor_agent_id,
      employment_status = p_employment_status,
      separated_at = case
        when p_employment_status = 'separated' and separated_at is null
        then now() else separated_at end
  where id = p_agent_id;

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id,
     before, after)
  values
    (p_actor_auth_user_id, 'admin', 'update_agent', 'agents', p_agent_id,
     jsonb_build_object('role', v_before.role, 'branch_id', v_before.branch_id,
                        'supervisor_agent_id', v_before.supervisor_agent_id,
                        'employment_status', v_before.employment_status),
     jsonb_build_object('role', p_role, 'branch_id', p_branch_id,
                        'supervisor_agent_id', p_supervisor_agent_id,
                        'employment_status', p_employment_status));

  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.admin_upsert_branch(
  p_actor_auth_user_id uuid,
  p_branch_id uuid,
  p_name text,
  p_code text,
  p_address text,
  p_lat double precision,
  p_lng double precision,
  p_geofence_radius_m integer,
  p_is_active boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.is_admin(p_actor_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object('status', 'invalid_coordinates');
  end if;

  if p_branch_id is null then
    insert into public.branches
      (name, code, address, lat, lng, geofence_radius_m, is_active)
    values
      (p_name, p_code, p_address, p_lat, p_lng,
       coalesce(p_geofence_radius_m, 150), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.branches
    set name = p_name, code = p_code, address = p_address,
        lat = p_lat, lng = p_lng,
        geofence_radius_m = coalesce(p_geofence_radius_m, geofence_radius_m),
        is_active = coalesce(p_is_active, is_active)
    where id = p_branch_id
    returning id into v_id;
  end if;

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id, after)
  values
    (p_actor_auth_user_id, 'admin',
     case when p_branch_id is null then 'create_branch' else 'update_branch' end,
     'branches', v_id, jsonb_build_object('name', p_name, 'code', p_code));

  return jsonb_build_object('status', 'ok', 'branch_id', v_id);
exception when unique_violation then
  return jsonb_build_object('status', 'duplicate_code');
end;
$$;

create or replace function public.admin_assign_clients(
  p_actor_auth_user_id uuid,
  p_client_ids uuid[],
  p_agent_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not public.is_admin(p_actor_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.clients
  set assigned_agent_id = p_agent_id
  where id = any(p_client_ids);
  get diagnostics v_count = row_count;

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id, after)
  values
    (p_actor_auth_user_id, 'admin', 'assign_clients', 'clients', null,
     jsonb_build_object('agent_id', p_agent_id, 'count', v_count));

  return jsonb_build_object('status', 'ok', 'count', v_count);
end;
$$;

-- Records that a password was reset. The reset ITSELF happens through the
-- Auth Admin API from the console; this is the audit half, so a reset always
-- leaves a trace even though no password ever touches this database.
create or replace function public.admin_log_password_reset(
  p_actor_auth_user_id uuid,
  p_agent_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_actor_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id, after)
  values
    (p_actor_auth_user_id, 'admin', 'reset_password', 'agents', p_agent_id,
     jsonb_build_object('note', 'temporary password issued by admin'));
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.admin_create_agent(uuid, uuid, text, text, text, public.agent_role, uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_update_agent(uuid, uuid, text, text, public.agent_role, uuid, uuid, public.employment_status) from public, anon, authenticated;
revoke all on function public.admin_upsert_branch(uuid, uuid, text, text, text, double precision, double precision, integer, boolean) from public, anon, authenticated;
revoke all on function public.admin_assign_clients(uuid, uuid[], uuid) from public, anon, authenticated;
revoke all on function public.admin_log_password_reset(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_create_agent(uuid, uuid, text, text, text, public.agent_role, uuid, uuid) to service_role;
grant execute on function public.admin_update_agent(uuid, uuid, text, text, public.agent_role, uuid, uuid, public.employment_status) to service_role;
grant execute on function public.admin_upsert_branch(uuid, uuid, text, text, text, double precision, double precision, integer, boolean) to service_role;
grant execute on function public.admin_assign_clients(uuid, uuid[], uuid) to service_role;
grant execute on function public.admin_log_password_reset(uuid, uuid) to service_role;

-- The board shows an admin everyone, not an empty tree.
create or replace function public.supervisor_board()
returns table (
  agent_id uuid, employee_no text, full_name text, role public.agent_role,
  branch_name text, session_id uuid, session_status public.session_status,
  opened_at_server timestamptz, closed_at_server timestamptz,
  integrity_score integer, visit_count bigint, last_ping_at timestamptz,
  open_critical_flags bigint, open_warn_flags bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with scope as (
    select a.id from public.agents a
    where public.is_supervisor_of(a.id)
       or (public.am_i_admin() and a.role <> 'admin')
  ),
  today_session as (
    select distinct on (s.agent_id)
      s.agent_id, s.id, s.status, s.opened_at_server, s.closed_at_server,
      s.integrity_score
    from public.attendance_sessions s
    join scope on scope.id = s.agent_id
    where s.opened_at_server >= (date_trunc('day', now() at time zone 'Asia/Manila')
                                 at time zone 'Asia/Manila')
    order by s.agent_id, s.opened_at_server desc
  )
  select
    a.id, a.employee_no, a.full_name, a.role, b.name,
    ts.id, ts.status, ts.opened_at_server, ts.closed_at_server, ts.integrity_score,
    (select count(*) from public.visits v where v.session_id = ts.id),
    (select max(p.received_at_server) from public.location_pings p
      where p.session_id = ts.id),
    (select count(*) from public.integrity_flags f
      where f.agent_id = a.id and f.resolved_at is null and f.severity = 'critical'),
    (select count(*) from public.integrity_flags f
      where f.agent_id = a.id and f.resolved_at is null and f.severity = 'warn')
  from public.agents a
  join scope on scope.id = a.id
  left join public.branches b on b.id = a.branch_id
  left join today_session ts on ts.agent_id = a.id
  where a.employment_status = 'active';
$$;

revoke all on function public.supervisor_board() from public, anon;
grant execute on function public.supervisor_board() to authenticated, service_role;
