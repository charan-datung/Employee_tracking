-- =============================================================================
-- Sync-engine support: clock-tamper observation columns + the agent
-- self-report path for integrity flags.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Clock-tamper observations (CLAUDE.md rule 3 extended to every record).
-- device_clock_offset_ms = server_now - device_now, measured by the client on
-- a sync round-trip and stamped on every record of that batch. *_uptime_ms is
-- the device's monotonic clock at capture. Both are CLIENT CLAIMS — the
-- server independently derives the real offset from *_server timestamps; a
-- mismatch, or wall-clock moving backwards relative to uptime, feeds the
-- clock_skew / uptime_regression detectors.
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  add column open_device_uptime_ms bigint,
  add column close_device_uptime_ms bigint,
  add column device_clock_offset_ms bigint;

alter table public.visits
  add column arrive_device_uptime_ms bigint,
  add column device_clock_offset_ms bigint;

comment on column public.location_pings.device_clock_offset_ms is
  'server_now - device_now in ms, measured by the CLIENT on a sync round-trip '
  'and stamped on each batch. A claim, not a fact: the server cross-checks it '
  'against received_at_server for clock_skew detection.';

-- Widen the column grants to cover the new observation columns.
grant insert (open_device_uptime_ms, device_clock_offset_ms)
  on public.attendance_sessions to authenticated;
grant update (close_device_uptime_ms, device_clock_offset_ms)
  on public.attendance_sessions to authenticated;
grant insert (arrive_device_uptime_ms, device_clock_offset_ms)
  on public.visits to authenticated;
grant insert (device_clock_offset_ms)
  on public.location_pings to authenticated;

-- ---------------------------------------------------------------------------
-- Agent self-reported integrity flags.
--
-- The sync engine and location service observe things the server cannot see
-- directly: blocked mock-location samples, permanent sync failures, storage
-- pressure. Agents may raise flags ONLY against themselves and ONLY of the
-- self-incriminating kinds below — never detector verdicts like 'teleport'.
-- Flags remain invisible to the agents they concern (no select-own policy),
-- so this cannot be used to probe the fraud pipeline.
-- ---------------------------------------------------------------------------

create policy flags_insert_self_report on public.integrity_flags
  for insert to authenticated
  with check (
    agent_id = (select (public.current_agent()).id)
    and flag_type in ('mock_attempt_blocked', 'sync_anomaly', 'permission_revoked')
  );

grant insert (id, session_id, visit_id, agent_id, flag_type, severity, detail)
  on public.integrity_flags to authenticated;
