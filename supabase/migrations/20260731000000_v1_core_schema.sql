-- =============================================================================
-- v1 core schema — field attendance and visit verification
-- Postgres 15 + PostGIS. No RLS in this migration (added separately later).
--
-- Conventions
--   * uuid primary keys via gen_random_uuid() (core since PG 13, no pgcrypto).
--   * timestamptz everywhere. Columns suffixed *_device are the DEVICE'S CLAIM
--     and are never trusted for decisions; *_server columns are stamped by the
--     server and are authoritative (CLAUDE.md rules 2 and 3).
--   * Every lat/lng pair has a STORED generated geography(Point,4326) sibling
--     so PostGIS operates on indexed geography, never on raw floats.
--   * is_mocked is the domain term for the `simulated` boolean reported by
--     @capacitor-community/background-geolocation. The sync boundary maps
--     simulated -> is_mocked verbatim; the DB name stays is_mocked.
--   * Distance is computed ONLY in SQL via distance_m() below — never in
--     JS or TS.
-- =============================================================================

create extension if not exists postgis;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.agent_role as enum ('sales_agent', 'collector', 'field_supervisor');

create type public.employment_status as enum ('active', 'suspended', 'separated');

create type public.session_status as enum ('open', 'closed', 'auto_closed', 'voided');

create type public.client_account_type as enum ('coco_martin_group', 'trust_loan_sme');

create type public.geocode_confidence as enum ('exact', 'approximate', 'unverified');

create type public.visit_outcome as enum (
  'contacted_paid',      -- outcome only; the amount lives in Odoo (CLAUDE.md rule 7)
  'contacted_promised',
  'contacted_refused',
  'not_home',
  'wrong_address',
  'closed_business',
  'client_relocated',
  'other'
);

create type public.ping_source as enum ('foreground', 'interval', 'visit_stamp');

create type public.integrity_flag_type as enum (
  'mock_location',
  'mock_attempt_blocked',
  'accuracy_degraded',
  'impossible_velocity',
  'teleport',
  'clock_skew',
  'uptime_regression',
  'device_mismatch',
  'duplicate_photo_hash',
  'ping_gap',
  'offline_backfill_bulk',
  'geofence_miss',
  'permission_revoked',
  'session_never_closed',
  'static_session',
  'zero_jitter',
  'null_sensor_fields',
  'motion_contradiction'
);

create type public.flag_severity as enum ('info', 'warn', 'critical');

-- -----------------------------------------------------------------------------
-- distance_m — THE distance primitive.
-- ST_Distance on geography = geodesic metres on the WGS84 spheroid.
-- Every distance stored or compared anywhere in this system comes from this
-- function (or an equivalent server-side ST_Distance call). Never compute
-- distance in JS or TS. Not once.
-- -----------------------------------------------------------------------------

create or replace function public.distance_m(
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
) returns double precision
language sql
immutable
parallel safe
returns null on null input
as $$
  select st_distance(
    st_setsrid(st_makepoint(lng1, lat1), 4326)::geography,
    st_setsrid(st_makepoint(lng2, lat2), 4326)::geography
  );
$$;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- branches
-- -----------------------------------------------------------------------------

create table public.branches (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  code               text not null,
  address            text,
  lat                double precision not null,
  lng                double precision not null,
  geofence_radius_m  integer not null default 150,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  geog               geography(Point, 4326)
                       generated always as
                       (st_setsrid(st_makepoint(lng, lat), 4326)::geography) stored
);

-- Branch codes appear on reports and in support conversations; they must be
-- unambiguous. Unique btree also serves point lookups by code.
create unique index branches_code_key on public.branches (code);

-- No spatial index on branches: a lending company has tens of branches at
-- most, so any geodesic comparison is a trivial sequential scan. An index
-- would only add write and maintenance cost.

-- -----------------------------------------------------------------------------
-- agents
-- -----------------------------------------------------------------------------

create table public.agents (
  id                   uuid primary key default gen_random_uuid(),
  auth_user_id         uuid references auth.users (id),
  employee_no          text not null,
  full_name            text not null,
  mobile_no            text,
  role                 public.agent_role not null,
  branch_id            uuid not null references public.branches (id),
  supervisor_agent_id  uuid references public.agents (id),
  employment_status    public.employment_status not null default 'active',
  hired_at             timestamptz,
  separated_at         timestamptz,
  created_at           timestamptz not null default now()
);

-- One app login maps to at most one agent row; auth.uid() -> agent resolution
-- happens on every authenticated request, so this must be a unique index, not
-- just a constraint check. Nullable: agents can be provisioned (e.g. synced
-- from HR) before their Supabase account exists.
create unique index agents_auth_user_id_key on public.agents (auth_user_id);

-- Employee numbers come from HR and are the human-facing identifier on every
-- report; uniqueness is a data-quality invariant and the index serves lookups.
create unique index agents_employee_no_key on public.agents (employee_no);

-- Rosters are always viewed per branch ("who works out of Zapote?"); this is
-- the standard FK index for that access path.
create index agents_branch_id_idx on public.agents (branch_id);

-- No index on supervisor_agent_id: the agents table stays small (hundreds of
-- rows), and supervisor drill-downs are rare console queries — a scan is fine.

-- -----------------------------------------------------------------------------
-- devices
-- -----------------------------------------------------------------------------

create table public.devices (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references public.agents (id),
  android_id         text not null,
  device_model       text,
  manufacturer       text,
  os_version         text,
  webview_version    text,
  app_version        text,
  is_current         boolean not null default false,
  bound_at           timestamptz not null default now(),
  bound_by_agent_id  uuid references public.agents (id),
  revoked_at         timestamptz,
  revoke_reason      text,
  push_token         text
);

comment on column public.devices.android_id is
  'ANDROID_ID hex string from @capacitor/device getId(). Resets on factory '
  'reset and differs per signing key — a binding hint, not a hardware truth.';

comment on column public.devices.webview_version is
  'Android System WebView version at bind time. WebView fragmentation WILL '
  'cause bugs on 2GB Android 10-13 devices; this is what you correlate '
  'crash/behaviour reports against.';

-- Enforces the device-binding rule: an agent has exactly one active device.
-- Partial unique index instead of a plain unique so the full binding history
-- (old rows with is_current = false) is preserved for fraud review.
create unique index devices_one_current_per_agent
  on public.devices (agent_id)
  where is_current;

-- Device history per agent ("what has this agent bound before?") — the
-- partial index above only covers the current row, so history walks need
-- their own FK index.
create index devices_agent_id_idx on public.devices (agent_id);

-- device_mismatch detection asks "which agents have used this ANDROID_ID?"
-- (one physical phone shared across accounts is a fraud signature). Plain
-- btree — the value is a hex string, equality lookups only.
create index devices_android_id_idx on public.devices (android_id);

-- -----------------------------------------------------------------------------
-- attendance_sessions
-- -----------------------------------------------------------------------------

create table public.attendance_sessions (
  id                            uuid primary key default gen_random_uuid(),
  agent_id                      uuid not null references public.agents (id),
  device_id                     uuid not null references public.devices (id),

  -- check-in observation (device claim + server stamp, CLAUDE.md rule 3)
  opened_at_device              timestamptz not null,
  opened_at_server              timestamptz not null default now(),
  open_lat                      double precision not null,
  open_lng                      double precision not null,
  open_accuracy_m               double precision not null,
  open_is_mocked                boolean not null,
  open_photo_path               text not null,
  open_photo_sha256             text not null,
  open_branch_id                uuid not null references public.branches (id),
  open_distance_from_branch_m   double precision,

  -- check-out observation; all nullable, absent while open / auto_closed
  closed_at_device              timestamptz,
  closed_at_server              timestamptz,
  close_lat                     double precision,
  close_lng                     double precision,
  close_accuracy_m              double precision,
  close_is_mocked               boolean,
  close_photo_path              text,
  close_photo_sha256            text,
  close_distance_from_branch_m  double precision,

  status                        public.session_status not null default 'open',
  void_reason                   text,
  voided_by_agent_id            uuid references public.agents (id),
  integrity_score               integer,

  -- Populated by the retention job when this session's raw location_pings are
  -- purged; the session keeps an aggregate movement fingerprint for audits
  -- after the granular trail is gone.
  summary_total_displacement_m  double precision,
  summary_max_speed_mps         double precision,
  summary_ping_count            integer,
  summary_gap_count             integer,
  summary_bbox                  geography(Polygon, 4326),

  created_at                    timestamptz not null default now(),

  open_geog                     geography(Point, 4326)
                                  generated always as
                                  (st_setsrid(st_makepoint(open_lng, open_lat), 4326)::geography) stored,
  close_geog                    geography(Point, 4326)
                                  generated always as
                                  (st_setsrid(st_makepoint(close_lng, close_lat), 4326)::geography) stored
);

comment on column public.attendance_sessions.open_is_mocked is
  'Maps 1:1 from the `simulated` boolean of '
  '@capacitor-community/background-geolocation at capture. is_mocked is the '
  'domain term; do not rename to match the plugin.';

comment on column public.attendance_sessions.close_is_mocked is
  'Same mapping as open_is_mocked: plugin `simulated` -> is_mocked.';

comment on column public.attendance_sessions.open_distance_from_branch_m is
  'Server-computed via distance_m() at receipt. Never client-supplied.';

comment on column public.attendance_sessions.close_distance_from_branch_m is
  'Server-computed via distance_m() at receipt. Never client-supplied.';

-- THE core business invariant: an agent cannot hold two open sessions.
-- Partial unique index makes the database enforce it no matter what the API
-- layer does; closed/voided history never collides with it.
create unique index attendance_sessions_one_open_per_agent
  on public.attendance_sessions (agent_id)
  where status = 'open';

-- Timeline access path: "this agent's sessions, newest first" powers the
-- agent history screen and the supervisor drill-down. Ordered on the server
-- timestamp — the device timestamp is a claim, not an ordering key.
create index attendance_sessions_agent_opened_idx
  on public.attendance_sessions (agent_id, opened_at_server desc);

-- Branch day-view ("everyone who checked in at Zapote today") for the
-- console; leading column matches the equality filter, trailing the range.
create index attendance_sessions_branch_opened_idx
  on public.attendance_sessions (open_branch_id, opened_at_server desc);

-- -----------------------------------------------------------------------------
-- clients
-- -----------------------------------------------------------------------------

create table public.clients (
  id                  uuid primary key default gen_random_uuid(),
  external_ref        text,
  display_name        text not null,
  account_type        public.client_account_type not null,
  address_text        text,
  barangay            text,
  city                text,
  lat                 double precision,
  lng                 double precision,
  geofence_radius_m   integer not null default 120,
  geocode_confidence  public.geocode_confidence not null default 'unverified',
  assigned_agent_id   uuid references public.agents (id),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  geog                geography(Point, 4326)
                        generated always as
                        (st_setsrid(st_makepoint(lng, lat), 4326)::geography) stored
);

comment on column public.clients.external_ref is
  'Odoo partner id. Odoo owns identity and money; this app stores contact '
  'outcomes only (CLAUDE.md rule 7).';

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- Odoo sync upserts ON CONFLICT (external_ref); must be unique for that to
-- work. Unique-with-nulls-allowed: manually created clients may have no Odoo
-- ref yet, and Postgres permits multiple NULLs in a unique index.
create unique index clients_external_ref_key on public.clients (external_ref);

-- Spatial index (required): geofence evaluation and "clients near this ping"
-- checks are ST_DWithin queries against client locations. GIST is the PostGIS
-- index type for geography.
create index clients_geog_gix on public.clients using gist (geog);

-- The agent's route list — "my active clients" — is the single hottest client
-- query from the mobile app. Partial on is_active keeps separated/archived
-- accounts out of the index entirely.
create index clients_assigned_agent_active_idx
  on public.clients (assigned_agent_id)
  where is_active;

-- -----------------------------------------------------------------------------
-- visits
-- -----------------------------------------------------------------------------

create table public.visits (
  id                             uuid primary key default gen_random_uuid(),
  session_id                     uuid not null references public.attendance_sessions (id),
  agent_id                       uuid not null references public.agents (id),
  client_id                      uuid not null references public.clients (id),

  arrived_at_device              timestamptz not null,
  arrived_at_server              timestamptz not null default now(),
  arrive_lat                     double precision not null,
  arrive_lng                     double precision not null,
  arrive_accuracy_m              double precision not null,
  arrive_is_mocked               boolean not null,
  arrive_distance_from_client_m  double precision,

  departed_at_device             timestamptz,
  departed_at_server             timestamptz,
  depart_lat                     double precision,
  depart_lng                     double precision,
  departure_was_inferred         boolean not null default false,

  dwell_seconds_server           integer,

  outcome                        public.visit_outcome,
  outcome_notes                  text,
  geofence_miss_reason           text,
  photo_path                     text,
  photo_sha256                   text,
  is_within_geofence             boolean,
  created_at                     timestamptz not null default now(),

  arrive_geog                    geography(Point, 4326)
                                   generated always as
                                   (st_setsrid(st_makepoint(arrive_lng, arrive_lat), 4326)::geography) stored,
  depart_geog                    geography(Point, 4326)
                                   generated always as
                                   (st_setsrid(st_makepoint(depart_lng, depart_lat), 4326)::geography) stored
);

comment on column public.visits.arrive_is_mocked is
  'Maps 1:1 from the plugin''s `simulated` boolean. is_mocked is the domain term.';

comment on column public.visits.arrive_distance_from_client_m is
  'Server-computed via distance_m() at receipt. Never client-supplied.';

comment on column public.visits.dwell_seconds_server is
  'Seconds between arrive and depart, computed by the server from *_server '
  'timestamps ONLY. Never client-supplied, never taken from *_device columns.';

-- Session detail view lists a session's visits; standard FK index.
create index visits_session_id_idx on public.visits (session_id);

-- Client history ("all visits to this borrower, newest first") drives both
-- the console client page and repeat-visit fraud checks.
create index visits_client_arrived_idx
  on public.visits (client_id, arrived_at_server desc);

-- Agent productivity views ("visits by this agent this week"); equality on
-- agent, range/order on server arrival time.
create index visits_agent_arrived_idx
  on public.visits (agent_id, arrived_at_server desc);

-- duplicate_photo_hash detection asks "has this exact photo been submitted
-- before?" — equality lookup on the hash across all visits.
create index visits_photo_sha256_idx on public.visits (photo_sha256);

-- -----------------------------------------------------------------------------
-- location_pings — highest-volume table in the system
-- -----------------------------------------------------------------------------

create table public.location_pings (
  id                      uuid primary key default gen_random_uuid(),
  session_id              uuid not null references public.attendance_sessions (id),
  agent_id                uuid not null references public.agents (id),

  captured_at_device      timestamptz not null,
  received_at_server      timestamptz not null default now(),
  device_clock_offset_ms  bigint,
  device_uptime_ms        bigint,

  lat                     double precision not null,
  lng                     double precision not null,
  accuracy_m              double precision not null,
  altitude_m              double precision,
  altitude_accuracy_m     double precision,
  speed_mps               double precision,
  bearing                 double precision,

  is_mocked               boolean not null,
  battery_pct             integer check (battery_pct between 0 and 100),
  is_charging             boolean,
  source                  public.ping_source not null,
  created_at              timestamptz not null default now(),

  geog                    geography(Point, 4326)
                            generated always as
                            (st_setsrid(st_makepoint(lng, lat), 4326)::geography) stored
);

comment on table public.location_pings is
  'Only ever written inside an OPEN attendance session (CLAUDE.md rule 4, '
  'RA 10173 proportionality). Raw rows are purged by the retention job after '
  'session summaries are written.';

comment on column public.location_pings.is_mocked is
  'Maps 1:1 from the `simulated` boolean of '
  '@capacitor-community/background-geolocation. Mocked fixes are rejected at '
  'capture; a mocked row here means the reject path failed — flag it.';

comment on column public.location_pings.device_clock_offset_ms is
  'device_clock - server_clock measured at sync (CLAUDE.md rule 3). Lets the '
  'server re-anchor captured_at_device claims and detect clock_skew.';

comment on column public.location_pings.device_uptime_ms is
  'Monotonic elapsed-realtime from the device. Unlike wall-clock it cannot be '
  'set by the user; a regression within a session means reboot or tampering '
  '(uptime_regression flag).';

-- BRIN on the capture timestamp: pings are inserted in near-chronological
-- order, so block ranges correlate tightly with time and BRIN gives
-- time-window scans at ~1000x smaller index size than btree — exactly what a
-- high-volume append-only table wants. Caveat: offline backfill inserts old
-- captured_at_device values out of order, loosening block ranges slightly;
-- acceptable because backfill batches are still recent and clustered.
create index location_pings_captured_brin
  on public.location_pings using brin (captured_at_device);

-- The trail query — "all pings for this session in time order" — powers
-- map playback, velocity/teleport analysis, and the retention summariser.
-- Btree because it needs exact ordered range scans per session.
create index location_pings_session_captured_idx
  on public.location_pings (session_id, captured_at_device);

-- Spatial index (required): geofence hit-tests and "pings near X" forensics
-- run ST_DWithin against the trail; GIST is the geography index type.
create index location_pings_geog_gix on public.location_pings using gist (geog);

-- No standalone agent_id index: every access path reaches pings through a
-- session (agent -> sessions -> pings), so the session index above covers it.

-- -----------------------------------------------------------------------------
-- integrity_flags
-- -----------------------------------------------------------------------------

create table public.integrity_flags (
  id                    uuid primary key default gen_random_uuid(),
  session_id            uuid not null references public.attendance_sessions (id),
  visit_id              uuid references public.visits (id),
  agent_id              uuid not null references public.agents (id),
  flag_type             public.integrity_flag_type not null,
  severity              public.flag_severity not null,
  detail                jsonb,
  raised_at             timestamptz not null default now(),
  resolved_at           timestamptz,
  resolved_by_agent_id  uuid references public.agents (id),
  resolution_note       text
);

-- Session review screen shows all flags for a session; standard FK index.
create index integrity_flags_session_id_idx on public.integrity_flags (session_id);

-- Agent risk profile ("this agent's flags over time") for supervisor and
-- audit views.
create index integrity_flags_agent_raised_idx
  on public.integrity_flags (agent_id, raised_at desc);

-- The triage queue: unresolved flags ordered worst-first. Partial index keeps
-- resolved history out — the queue stays small and hot even as total flag
-- volume grows unbounded.
create index integrity_flags_open_queue_idx
  on public.integrity_flags (severity, raised_at)
  where resolved_at is null;

-- -----------------------------------------------------------------------------
-- audit_log
-- -----------------------------------------------------------------------------

create table public.audit_log (
  id                  uuid primary key default gen_random_uuid(),
  actor_auth_user_id  uuid,
  actor_role          text,
  action              text not null,
  entity_table        text,
  entity_id           uuid,
  before              jsonb,
  after               jsonb,
  ip                  inet,
  occurred_at         timestamptz not null default now()
);

comment on column public.audit_log.actor_auth_user_id is
  'Deliberately NOT a foreign key: audit rows must survive deletion of the '
  'auth user they reference.';

-- "Show me everything that happened to this row" — the primary audit access
-- path; composite equality on the entity plus time ordering.
create index audit_log_entity_idx
  on public.audit_log (entity_table, entity_id, occurred_at desc);

-- Append-only, insert-ordered table: BRIN on occurred_at serves time-window
-- audits ("all admin actions last Tuesday") at negligible index size.
create index audit_log_occurred_brin
  on public.audit_log using brin (occurred_at);

-- -----------------------------------------------------------------------------
-- consent_records
-- -----------------------------------------------------------------------------

create table public.consent_records (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents (id),
  policy_version  text not null,
  accepted_at     timestamptz not null default now(),
  accepted_ip     inet,
  device_id       uuid references public.devices (id)
);

comment on table public.consent_records is
  'RA 10173 consent trail. Append-only: re-acceptance of a new policy_version '
  'inserts a new row; nothing here is ever updated or deleted.';

-- Compliance question is always "what has THIS agent accepted, latest
-- first?"; composite index answers it without a sort.
create index consent_records_agent_accepted_idx
  on public.consent_records (agent_id, accepted_at desc);
