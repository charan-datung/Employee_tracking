-- =============================================================================
-- Console access control + notification plumbing.
--
-- CONSOLE ACCESS IS ENFORCED IN THREE PLACES, and the UI is the least
-- important of them:
--   1. middleware.ts        — bounces the request before a page renders
--   2. has_console_access() — SECURITY DEFINER, the database's own answer
--   3. RLS                  — the console reads AS THE SUPERVISOR, so the
--      existing *_select_reports policies are what actually scope the data
--
-- An agent's credentials therefore grant nothing useful even if they reach a
-- console URL: middleware rejects them, has_console_access() returns false,
-- and their JWT can only ever see their own rows, which the console does not
-- render. Removing any one layer still leaves two.
-- =============================================================================

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
      and a.role = 'field_supervisor'
      and a.employment_status = 'active'
  );
$$;

revoke all on function public.has_console_access(uuid) from public, anon;
grant execute on function public.has_console_access(uuid) to authenticated, service_role;

-- The caller asking about themselves — what middleware calls. Takes no
-- argument, so a logged-in agent cannot probe other people's access.
create or replace function public.my_console_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_console_access((select auth.uid()));
$$;

revoke all on function public.my_console_access() from public, anon;
grant execute on function public.my_console_access() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Notification delivery log.
--
-- Exists to enforce the rate limit, which is a product requirement, not a
-- technical one: a supervisor who gets forty pushes in a morning turns
-- notifications off, and then the whole alerting system is decorative. One
-- push per agent per 30 minutes; everything suppressed rolls into the next
-- digest instead of being dropped.
-- -----------------------------------------------------------------------------

create type public.notification_kind as enum (
  'critical_flag',
  'not_checked_in_digest',
  'open_sessions_digest'
);

create table public.notification_log (
  id                uuid primary key default gen_random_uuid(),
  recipient_agent_id uuid not null references public.agents (id),
  -- The agent the notification is ABOUT (null for digests, which span many).
  subject_agent_id  uuid references public.agents (id),
  kind              public.notification_kind not null,
  title             text not null,
  body              text not null,
  payload           jsonb,
  sent_at           timestamptz not null default now(),
  -- Set when the push was suppressed by the rate limit rather than sent, so
  -- the digest can pick it up and nothing is silently lost.
  suppressed        boolean not null default false
);

-- The rate-limit lookup: "has this recipient been pushed about this agent
-- recently?" Ordered descending so the check reads one row.
create index notification_log_rate_limit_idx
  on public.notification_log (recipient_agent_id, subject_agent_id, sent_at desc)
  where not suppressed;

-- Digest assembly reads the suppressed backlog.
create index notification_log_suppressed_idx
  on public.notification_log (recipient_agent_id, sent_at)
  where suppressed;

alter table public.notification_log enable row level security;

-- Supervisors may read their own notification history; nobody writes from a
-- client. The dispatcher runs as service_role.
grant select on public.notification_log to authenticated;

create policy notification_log_select_own on public.notification_log
  for select to authenticated
  using (recipient_agent_id = (select (public.current_agent()).id));

-- Rate limit: 30 minutes per (recipient, subject).
create or replace function public.notification_rate_limit_minutes()
returns integer language sql immutable as $$ select 30 $$;

create or replace function public.may_push_now(
  p_recipient_agent_id uuid,
  p_subject_agent_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.notification_log n
    where n.recipient_agent_id = p_recipient_agent_id
      and n.subject_agent_id is not distinct from p_subject_agent_id
      and not n.suppressed
      and n.sent_at > now()
        - (public.notification_rate_limit_minutes() || ' minutes')::interval
  );
$$;

revoke all on function public.may_push_now(uuid, uuid) from public, anon, authenticated;
grant execute on function public.may_push_now(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- FCM token storage. devices.push_token already exists; this is the write
-- path and, more importantly, the INVALIDATION path.
--
-- A rebind means the agent is on different hardware. Leaving the old token
-- live would keep pushing an agent's alerts to a phone they no longer carry —
-- possibly someone else's, if the handset was sold or handed over. Tokens die
-- with the binding.
-- -----------------------------------------------------------------------------

create or replace function public.set_push_token(
  p_auth_user_id uuid,
  p_device_id uuid,
  p_token text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_agent public.agents;
begin
  select * into v_agent from public.agents where auth_user_id = p_auth_user_id;
  if v_agent.id is null then return false; end if;

  update public.devices
  set push_token = p_token
  where id = p_device_id
    and agent_id = v_agent.id
    and is_current;

  return found;
end;
$$;

revoke all on function public.set_push_token(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_push_token(uuid, uuid, text) to service_role;

-- Any device that stops being current loses its token immediately — covers
-- supervisor-approved rebinds, revocations, and anything else that flips the
-- flag.
create or replace function public.devices_clear_token_on_unbind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_current and not new.is_current then
    new.push_token := null;
  end if;
  return new;
end;
$$;

create trigger devices_clear_token_on_unbind_trg
  before update on public.devices
  for each row execute function public.devices_clear_token_on_unbind();

-- -----------------------------------------------------------------------------
-- Board query: one row per agent in a supervisor's tree, with everything the
-- morning board needs. A function rather than a view so the reporting tree is
-- resolved server-side from the CALLER, never from a parameter the browser
-- could change.
-- -----------------------------------------------------------------------------

create or replace function public.supervisor_board()
returns table (
  agent_id uuid,
  employee_no text,
  full_name text,
  role public.agent_role,
  branch_name text,
  session_id uuid,
  session_status public.session_status,
  opened_at_server timestamptz,
  closed_at_server timestamptz,
  integrity_score integer,
  visit_count bigint,
  last_ping_at timestamptz,
  open_critical_flags bigint,
  open_warn_flags bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with tree as (
    select a.id from public.agents a
    where public.is_supervisor_of(a.id)
  ),
  today_session as (
    select distinct on (s.agent_id)
      s.agent_id, s.id, s.status, s.opened_at_server, s.closed_at_server,
      s.integrity_score
    from public.attendance_sessions s
    join tree on tree.id = s.agent_id
    -- "Today" in Philippine time: the board is read at 9am in Las Piñas.
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
  join tree on tree.id = a.id
  left join public.branches b on b.id = a.branch_id
  left join today_session ts on ts.agent_id = a.id
  where a.employment_status = 'active';
$$;

revoke all on function public.supervisor_board() from public, anon;
grant execute on function public.supervisor_board() to authenticated, service_role;

-- Realtime needs the tables in the publication. RLS still applies to realtime
-- subscriptions, so a supervisor only receives changes they could have read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance_sessions;
    alter publication supabase_realtime add table public.integrity_flags;
  else
    raise notice 'supabase_realtime publication not present (local dev) — skipped';
  end if;
end $$;
