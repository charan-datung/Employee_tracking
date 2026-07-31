-- =============================================================================
-- v1 device binding + consent write path
--
-- The mobile client cannot write devices, integrity_flags, or audit_log (RLS
-- migration). Binding decisions are FACTS, and facts are decided server-side
-- (CLAUDE.md rule 2): the register_device / approve_device_rebind edge
-- functions authenticate the caller and then call the SECURITY DEFINER
-- transaction functions below. Owned by postgres, they are also the sanctioned
-- audit_log write path — audit_log INSERT is revoked from every role, and
-- only postgres-owned definer code (these functions, and later triggers) can
-- append to it. EXECUTE is granted to service_role only; a stolen agent JWT
-- cannot reach them through PostgREST.
-- =============================================================================

-- Request codes: 6 chars, no 0/O/1/I/L (read out over bad phone lines).
-- random() is not a CSPRNG, which is acceptable here: a code is only useful
-- to an attacker if a supervisor approves it out loud, it is single-use, it
-- expires in 24h, and guessing runs through the rate-limitable edge function.
create or replace function public.generate_request_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(
    substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', (floor(random() * 31) + 1)::int, 1),
    ''
  )
  from generate_series(1, 6);
$$;

revoke all on function public.generate_request_code() from public, anon, authenticated;
grant execute on function public.generate_request_code() to service_role;

-- -----------------------------------------------------------------------------
-- register_device_tx — one call per login, decides bind / ok / blocked.
-- -----------------------------------------------------------------------------

create or replace function public.register_device_tx(
  p_auth_user_id uuid,
  p_android_id text,
  p_device_model text default null,
  p_manufacturer text default null,
  p_os_version text default null,
  p_webview_version text default null,
  p_app_version text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents;
  v_current public.devices;
  v_pending_id uuid;
  v_code text;
  v_flag public.integrity_flags;
begin
  select * into v_agent from public.agents where auth_user_id = p_auth_user_id;
  if v_agent.id is null then
    return jsonb_build_object('status', 'no_agent');
  end if;
  if v_agent.employment_status <> 'active' then
    return jsonb_build_object('status', 'not_active');
  end if;

  select * into v_current
  from public.devices
  where agent_id = v_agent.id and is_current;

  -- Case 1: no current binding — first login binds this device.
  if v_current.id is null then
    begin
      insert into public.devices
        (agent_id, android_id, device_model, manufacturer, os_version,
         webview_version, app_version, is_current, bound_at, bound_by_agent_id)
      values
        (v_agent.id, p_android_id, p_device_model, p_manufacturer, p_os_version,
         p_webview_version, p_app_version, true, now(), v_agent.id)
      returning id into v_pending_id;
      return jsonb_build_object('status', 'bound', 'device_id', v_pending_id);
    exception when unique_violation then
      -- Two concurrent first logins raced on the one-current-per-agent index;
      -- re-read and fall through to the match/mismatch paths.
      select * into v_current
      from public.devices
      where agent_id = v_agent.id and is_current;
    end;
  end if;

  -- Case 2: same ANDROID_ID as the current binding — refresh the info columns
  -- (webview_version drift is exactly what we correlate bugs against).
  if v_current.android_id = p_android_id then
    update public.devices
    set device_model    = coalesce(p_device_model, device_model),
        manufacturer    = coalesce(p_manufacturer, manufacturer),
        os_version      = coalesce(p_os_version, os_version),
        webview_version = coalesce(p_webview_version, webview_version),
        app_version     = coalesce(p_app_version, app_version)
    where id = v_current.id;
    return jsonb_build_object('status', 'ok', 'device_id', v_current.id);
  end if;

  -- Case 3: mismatch — record the stranger device (is_current = false), raise
  -- a critical integrity flag, hand back a code for the supervisor call.
  -- No proceed path.
  select id into v_pending_id
  from public.devices
  where agent_id = v_agent.id and android_id = p_android_id
    and not is_current and revoked_at is null
  order by bound_at desc
  limit 1;

  if v_pending_id is null then
    insert into public.devices
      (agent_id, android_id, device_model, manufacturer, os_version,
       webview_version, app_version, is_current, bound_at, bound_by_agent_id)
    values
      (v_agent.id, p_android_id, p_device_model, p_manufacturer, p_os_version,
       p_webview_version, p_app_version, false, now(), null)
    returning id into v_pending_id;
  end if;

  -- Reuse the open flag for this exact pending device if one is still live —
  -- a retried login must read back the SAME code, not mint a fresh one.
  select * into v_flag
  from public.integrity_flags
  where agent_id = v_agent.id
    and flag_type = 'device_mismatch'
    and resolved_at is null
    and raised_at > now() - interval '24 hours'
    and detail ->> 'new_device_id' = v_pending_id::text
  order by raised_at desc
  limit 1;

  if v_flag.id is not null then
    return jsonb_build_object('status', 'blocked',
                              'request_code', v_flag.detail ->> 'request_code');
  end if;

  -- Mint a code unique among live codes.
  loop
    v_code := public.generate_request_code();
    exit when not exists (
      select 1 from public.integrity_flags
      where flag_type = 'device_mismatch'
        and resolved_at is null
        and raised_at > now() - interval '24 hours'
        and detail ->> 'request_code' = v_code
    );
  end loop;

  insert into public.integrity_flags
    (session_id, agent_id, flag_type, severity, detail)
  values
    (null, v_agent.id, 'device_mismatch', 'critical',
     jsonb_build_object(
       'request_code', v_code,
       'new_device_id', v_pending_id,
       'new_android_id', p_android_id,
       'current_device_id', v_current.id));

  return jsonb_build_object('status', 'blocked', 'request_code', v_code);
end;
$$;

-- device_mismatch happens at login, before any session exists, so the flag
-- cannot reference one. Relax the NOT NULL added in the core schema.
alter table public.integrity_flags alter column session_id drop not null;

revoke all on function public.register_device_tx(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_device_tx(uuid, text, text, text, text, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- approve_device_rebind_tx — supervisor phones in the code; one transaction:
-- revoke old binding, promote pending device, resolve the flag, audit it.
-- -----------------------------------------------------------------------------

create or replace function public.approve_device_rebind_tx(
  p_supervisor_auth_user_id uuid,
  p_request_code text,
  p_caller_ip inet default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sup public.agents;
  v_flag public.integrity_flags;
  v_agent public.agents;
  v_old public.devices;
  v_new public.devices;
  v_code text;
begin
  select * into v_sup
  from public.agents
  where auth_user_id = p_supervisor_auth_user_id
    and role = 'field_supervisor'
    and employment_status = 'active';
  if v_sup.id is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  v_code := upper(trim(p_request_code));

  -- Lock the flag row: two supervisors approving the same code concurrently
  -- must serialize, and the loser must see it already resolved.
  select * into v_flag
  from public.integrity_flags
  where flag_type = 'device_mismatch'
    and resolved_at is null
    and raised_at > now() - interval '24 hours'
    and detail ->> 'request_code' = v_code
  for update;

  -- One bucket for unknown, expired, AND out-of-tree codes: a supervisor
  -- probing random codes learns nothing about which codes exist.
  if v_flag.id is null then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  if not exists (
    with recursive tree as (
      select a.id from public.agents a where a.supervisor_agent_id = v_sup.id
      union
      select a.id from public.agents a join tree t on a.supervisor_agent_id = t.id
    )
    select 1 from tree where tree.id = v_flag.agent_id
  ) then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  select * into v_agent from public.agents where id = v_flag.agent_id;

  select * into v_new
  from public.devices
  where id = (v_flag.detail ->> 'new_device_id')::uuid;
  if v_new.id is null then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  -- Revoke whatever is currently bound (may already be gone — that is fine).
  update public.devices
  set is_current = false,
      revoked_at = now(),
      revoke_reason = 'rebind approved: replaced by device ' || v_new.id
  where agent_id = v_flag.agent_id and is_current
  returning * into v_old;

  update public.devices
  set is_current = true,
      bound_at = now(),
      bound_by_agent_id = v_sup.id,
      revoked_at = null,
      revoke_reason = null
  where id = v_new.id;

  update public.integrity_flags
  set resolved_at = now(),
      resolved_by_agent_id = v_sup.id,
      resolution_note = 'Device rebind approved by ' || v_sup.employee_no || ' via request code'
  where id = v_flag.id;

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id, before, after, ip)
  values
    (p_supervisor_auth_user_id, 'field_supervisor', 'approve_device_rebind',
     'devices', v_new.id,
     jsonb_build_object('old_device_id', v_old.id, 'old_android_id', v_old.android_id),
     jsonb_build_object('new_device_id', v_new.id, 'new_android_id', v_new.android_id,
                        'agent_id', v_flag.agent_id),
     p_caller_ip);

  return jsonb_build_object(
    'status', 'approved',
    'agent_employee_no', v_agent.employee_no,
    'agent_full_name', v_agent.full_name,
    'device_model', v_new.device_model);
end;
$$;

revoke all on function public.approve_device_rebind_tx(uuid, text, inet)
  from public, anon, authenticated;
grant execute on function public.approve_device_rebind_tx(uuid, text, inet)
  to service_role;

-- -----------------------------------------------------------------------------
-- Consent: the one client-side write outside attendance flows. accepted_at is
-- server-stamped by its DEFAULT; accepted_ip is not client-writable (a client
-- cannot know its own public IP truthfully) and stays null on this path.
-- -----------------------------------------------------------------------------

create policy consent_insert_own on public.consent_records
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and device_id is not null
  );

grant insert (id, agent_id, policy_version, device_id)
  on public.consent_records to authenticated;
