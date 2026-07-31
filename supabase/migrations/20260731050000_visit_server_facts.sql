-- =============================================================================
-- Visit server-side facts + the pin quality loop.
--
-- The device sends OBSERVATIONS (where it was, when it says it was there).
-- This migration is where those become FACTS: distance to the client,
-- geofence membership, dwell, and inferred departures are all computed here
-- from server timestamps and PostGIS, never accepted from the client. The
-- column grants already make that structural — arrive_distance_from_client_m,
-- is_within_geofence, dwell_seconds_server and departure_was_inferred are not
-- grantable to `authenticated`, so a client cannot write them even if it
-- tries (CLAUDE.md rule 2).
--
-- The mobile app computes a PROVISIONAL distance offline to decide which
-- screen to show (proceed / reason picker / block). That number never leaves
-- the device. Everything below recomputes it independently and wins.
-- =============================================================================

-- Beyond this, a "visit" is not a visit. The app blocks it; a row arriving
-- here anyway means the block was bypassed, so it is flagged critical.
create or replace function public.geofence_hard_limit_m()
returns double precision language sql immutable parallel safe
as $$ select 500.0::double precision $$;

-- -----------------------------------------------------------------------------
-- 1. Arrival facts: distance + geofence membership, stamped before the row
--    lands so no visit ever exists without them.
-- -----------------------------------------------------------------------------

create or replace function public.visits_stamp_arrival_facts()
returns trigger
language plpgsql
security definer
-- NOTE: search_path is public+extensions, not '', because this function
-- resolves the PostGIS `geography` type through distance_m(). Supabase
-- installs PostGIS into `extensions`; a bare local install puts it in
-- `public`. Listing both is portable, and a nonexistent schema in the list is
-- ignored. Still pinned (never caller-controlled), so the definer hardening
-- holds. Functions here that do NOT touch PostGIS keep search_path = ''.
set search_path = public, extensions
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients c where c.id = new.client_id;
  if v_client.id is null then
    raise exception 'unknown client %', new.client_id;
  end if;

  -- A client with no geocode cannot be geofenced: distance stays NULL and
  -- is_within_geofence stays NULL (unknown), NOT false. Never invent a miss
  -- for an address nobody has pinned yet.
  if v_client.lat is null or v_client.lng is null then
    new.arrive_distance_from_client_m := null;
    new.is_within_geofence := null;
    return new;
  end if;

  new.arrive_distance_from_client_m := public.distance_m(
    new.arrive_lat, new.arrive_lng, v_client.lat, v_client.lng
  );
  new.is_within_geofence :=
    new.arrive_distance_from_client_m <= v_client.geofence_radius_m;
  return new;
end;
$$;

create trigger visits_stamp_arrival_facts_trg
  before insert on public.visits
  for each row execute function public.visits_stamp_arrival_facts();

-- -----------------------------------------------------------------------------
-- 2. Departure facts. The client may write departed_at_device / depart_lat /
--    depart_lng exactly once (policy below); the server stamps its own
--    timestamp and computes dwell from SERVER timestamps only.
-- -----------------------------------------------------------------------------

create or replace function public.visits_stamp_departure_facts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.departed_at_device is not null and old.departed_at_server is null then
    new.departed_at_server := now();
    -- SERVER timestamps only. The device's claims are never subtracted from
    -- one another to produce a stored value.
    new.dwell_seconds_server :=
      greatest(0, extract(epoch from (new.departed_at_server - new.arrived_at_server)))::integer;
  end if;
  return new;
end;
$$;

create trigger visits_stamp_departure_facts_trg
  before update on public.visits
  for each row execute function public.visits_stamp_departure_facts();

-- -----------------------------------------------------------------------------
-- 3. Inferred departure. An agent who never taps "AALIS NA AKO" gets their
--    visit closed by the next arrival, or by check-out. Marked
--    departure_was_inferred so nobody mistakes it for an observation, and
--    with NO departure coordinates — the device never reported any.
-- -----------------------------------------------------------------------------

create or replace function public.infer_open_visit_departures(
  p_session_id uuid,
  p_at timestamptz,
  p_except_visit_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with closed as (
    update public.visits v
    set departed_at_server = p_at,
        departure_was_inferred = true,
        dwell_seconds_server =
          greatest(0, extract(epoch from (p_at - v.arrived_at_server)))::integer
    where v.session_id = p_session_id
      and v.departed_at_server is null
      and (p_except_visit_id is null or v.id <> p_except_visit_id)
    returning v.id
  )
  select count(*) into v_count from closed;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. After a visit lands: close the previous one, flag a geofence miss, and
--    feed the pin quality loop.
-- -----------------------------------------------------------------------------

create or replace function public.visits_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_severity public.flag_severity;
begin
  perform public.infer_open_visit_departures(
    new.session_id, new.arrived_at_server, new.id
  );

  if new.is_within_geofence is false then
    -- Outside the client's radius but inside the hard limit is expected in
    -- Cavite subdivisions (bad pins) and the agent supplied a reason: warn.
    -- Beyond the hard limit the app blocks, so a row here means the block was
    -- bypassed.
    v_severity := case
      when new.arrive_distance_from_client_m > public.geofence_hard_limit_m()
      then 'critical'::public.flag_severity
      else 'warn'::public.flag_severity
    end;

    insert into public.integrity_flags
      (session_id, visit_id, agent_id, flag_type, severity, detail)
    values
      (new.session_id, new.id, new.agent_id, 'geofence_miss', v_severity,
       jsonb_build_object(
         'client_id', new.client_id,
         'distance_m', round(new.arrive_distance_from_client_m::numeric, 1),
         'reported_reason', new.geofence_miss_reason,
         'beyond_hard_limit',
           new.arrive_distance_from_client_m > public.geofence_hard_limit_m()));

    perform public.evaluate_pin_quality(new.client_id);
  end if;

  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. PIN QUALITY LOOP
--
-- Cavite subdivision addressing is the single largest source of false fraud
-- signals in this system. When several agents independently stand in the same
-- wrong place for the same client, the pin is wrong — not the agents. Three
-- distinct agents, whose reported arrival points sit within
-- PIN_CLUSTER_TOLERANCE_M of each other, auto-raise a review task carrying
-- the centroid of what they actually observed.
-- -----------------------------------------------------------------------------

create type public.pin_task_status as enum ('open', 'resolved', 'dismissed');

create table public.pin_review_tasks (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id),
  status               public.pin_task_status not null default 'open',
  evidence_agent_count integer not null,
  evidence_visit_count integer not null,
  -- Centroid of the agents' reported arrival points: what the pin probably
  -- should be. A SUGGESTION for a human to confirm, never auto-applied.
  suggested_lat        double precision not null,
  suggested_lng        double precision not null,
  -- How tightly the reports cluster. Small = confident.
  spread_m             double precision not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  resolved_by_agent_id uuid references public.agents (id),
  resolution_note      text,
  suggested_geog       geography(Point, 4326)
                         generated always as
                         (st_setsrid(st_makepoint(suggested_lng, suggested_lat), 4326)::geography) stored
);

-- One open task per client: repeat evidence updates the existing task rather
-- than spawning duplicates in the console queue.
create unique index pin_review_tasks_one_open_per_client
  on public.pin_review_tasks (client_id) where status = 'open';

-- Queue view: oldest-first within open tasks.
create index pin_review_tasks_open_queue_idx
  on public.pin_review_tasks (created_at) where status = 'open';

create trigger pin_review_tasks_set_updated_at
  before update on public.pin_review_tasks
  for each row execute function public.set_updated_at();

create or replace function public.evaluate_pin_quality(p_client_id uuid)
returns uuid
language plpgsql
security definer
-- NOTE: search_path is public+extensions, not '', because this function
-- resolves the PostGIS `geography` type through distance_m(). Supabase
-- installs PostGIS into `extensions`; a bare local install puts it in
-- `public`. Listing both is portable, and a nonexistent schema in the list is
-- ignored. Still pinned (never caller-controlled), so the definer hardening
-- holds. Functions here that do NOT touch PostGIS keep search_path = ''.
set search_path = public, extensions
as $$
declare
  -- Reports must agree to this tolerance before we believe them.
  c_cluster_tolerance_m constant double precision := 200.0;
  c_min_agents constant integer := 3;
  v_agents integer;
  v_visits integer;
  v_spread double precision;
  v_lat double precision;
  v_lng double precision;
  v_task_id uuid;
begin
  -- Evidence = every unresolved geofence_miss for this client, one arrival
  -- point each. Resolved misses are excluded: once a pin is fixed, its old
  -- misses stop counting toward a new task.
  with evidence as (
    select v.agent_id, v.arrive_lat as lat, v.arrive_lng as lng
    from public.integrity_flags f
    join public.visits v on v.id = f.visit_id
    where f.flag_type = 'geofence_miss'
      and f.resolved_at is null
      and v.client_id = p_client_id
  ),
  agg as (
    select count(distinct e.agent_id)::integer as agents,
           count(*)::integer as visits,
           avg(e.lat) as lat,
           avg(e.lng) as lng
    from evidence e
  ),
  -- Consistency: the widest gap between any two reported points.
  spread as (
    select coalesce(max(public.distance_m(a.lat, a.lng, b.lat, b.lng)), 0) as spread_m
    from evidence a, evidence b
  )
  select agg.agents, agg.visits, agg.lat, agg.lng, spread.spread_m
  into v_agents, v_visits, v_lat, v_lng, v_spread
  from agg, spread;

  if coalesce(v_agents, 0) < c_min_agents then
    return null;
  end if;

  if v_spread > c_cluster_tolerance_m then
    -- Agents disagree about where the client actually is; that is not pin
    -- evidence, it is something else. Leave it to the flag queue.
    return null;
  end if;

  insert into public.pin_review_tasks
    (client_id, evidence_agent_count, evidence_visit_count,
     suggested_lat, suggested_lng, spread_m)
  values
    (p_client_id, v_agents, v_visits, v_lat, v_lng, v_spread)
  on conflict (client_id) where status = 'open'
  do update set
    evidence_agent_count = excluded.evidence_agent_count,
    evidence_visit_count = excluded.evidence_visit_count,
    suggested_lat = excluded.suggested_lat,
    suggested_lng = excluded.suggested_lng,
    spread_m = excluded.spread_m
  returning id into v_task_id;

  return v_task_id;
end;
$$;

create trigger visits_after_insert_trg
  after insert on public.visits
  for each row execute function public.visits_after_insert();

-- -----------------------------------------------------------------------------
-- 6. Check-out / auto-close closes any still-open visit of that session.
-- -----------------------------------------------------------------------------

create or replace function public.sessions_infer_departures()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('closed', 'auto_closed', 'voided')
     and old.status = 'open' then
    perform public.infer_open_visit_departures(
      new.id, coalesce(new.closed_at_server, now())
    );
  end if;
  return null;
end;
$$;

create trigger sessions_infer_departures_trg
  after update on public.attendance_sessions
  for each row execute function public.sessions_infer_departures();

-- -----------------------------------------------------------------------------
-- 7. Departure write path for the agent: write-once, own visit, open session.
-- -----------------------------------------------------------------------------

create policy visits_update_departure_own on public.visits
  for update to authenticated
  using (
    agent_id = (select (public.current_agent()).id)
    and departed_at_device is null
    and public.is_own_open_session(session_id)
  )
  with check (
    agent_id = (select (public.current_agent()).id)
    and departed_at_device is not null
  );

grant update (departed_at_device, depart_lat, depart_lng)
  on public.visits to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Console: read the queue, fix the pin.
-- -----------------------------------------------------------------------------

alter table public.pin_review_tasks enable row level security;

grant select on public.pin_review_tasks to authenticated;

create policy pin_tasks_select_reports on public.pin_review_tasks
  for select to authenticated
  using (
    exists (
      select 1 from public.clients c
      where c.id = pin_review_tasks.client_id
        and public.is_supervisor_of(c.assigned_agent_id)
    )
  );

-- Moving a client's pin is a back-office/supervisor act, never a field one:
-- the mobile app has no write path to clients at all. SECURITY DEFINER,
-- service_role only — the console calls it from the server side.
create or replace function public.fix_client_pin(
  p_actor_auth_user_id uuid,
  p_client_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_note text default null,
  p_caller_ip inet default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.agents;
  v_before public.clients;
begin
  -- Validate the coordinates BEFORE anything else. A null or out-of-range
  -- pair would otherwise blank out a client's location and mark it 'exact' —
  -- the pin loop exists to improve pin quality, never to destroy it.
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90
     or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object('status', 'invalid_coordinates');
  end if;

  select * into v_before from public.clients where id = p_client_id;
  if v_before.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A named actor must be an active supervisor. A null actor means a trusted
  -- back-office caller (only service_role can execute this function at all).
  if p_actor_auth_user_id is not null then
    select * into v_actor from public.agents
    where auth_user_id = p_actor_auth_user_id
      and role = 'field_supervisor'
      and employment_status = 'active';
    if v_actor.id is null then
      return jsonb_build_object('status', 'forbidden');
    end if;
  end if;

  update public.clients
  set lat = p_lat,
      lng = p_lng,
      -- A human looked at a map and placed this deliberately.
      geocode_confidence = 'exact'
  where id = p_client_id;

  update public.pin_review_tasks
  set status = 'resolved',
      resolved_at = now(),
      resolved_by_agent_id = v_actor.id,
      resolution_note = coalesce(p_note, 'Pin corrected from console')
  where client_id = p_client_id and status = 'open';

  -- The old geofence misses were caused by the bad pin; resolving them stops
  -- them counting as evidence against a future pin and clears the queue.
  update public.integrity_flags f
  set resolved_at = now(),
      resolved_by_agent_id = v_actor.id,
      resolution_note = 'Client pin corrected'
  where f.flag_type = 'geofence_miss'
    and f.resolved_at is null
    and f.visit_id in (select v.id from public.visits v where v.client_id = p_client_id);

  insert into public.audit_log
    (actor_auth_user_id, actor_role, action, entity_table, entity_id,
     before, after, ip)
  values
    (p_actor_auth_user_id,
     coalesce(v_actor.role::text, 'back_office'),
     'fix_client_pin', 'clients', p_client_id,
     jsonb_build_object('lat', v_before.lat, 'lng', v_before.lng,
                        'geocode_confidence', v_before.geocode_confidence),
     jsonb_build_object('lat', p_lat, 'lng', p_lng,
                        'geocode_confidence', 'exact'),
     p_caller_ip);

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.fix_client_pin(uuid, uuid, double precision, double precision, text, inet)
  from public, anon, authenticated;
grant execute on function public.fix_client_pin(uuid, uuid, double precision, double precision, text, inet)
  to service_role;

revoke all on function public.evaluate_pin_quality(uuid) from public, anon, authenticated;
revoke all on function public.infer_open_visit_departures(uuid, timestamptz, uuid)
  from public, anon, authenticated;
