import { sqlPort } from '../../services/sync/db.ts';

// Local reads for the attendance screens. Everything the UI shows comes from
// SQLite — the screens render correctly with zero connectivity from a cold
// start (CLAUDE.md rule 9).

export interface OpenSessionDetail {
  id: string;
  agentId: string;
  openedAtDeviceMs: number;
}

interface SessionSqlRow {
  id: string;
  agent_id: string;
  opened_at_device: number;
}

export async function getOpenSessionDetail(): Promise<OpenSessionDetail | null> {
  const rows = await sqlPort.query<SessionSqlRow>(
    `select id, agent_id, opened_at_device from attendance_sessions_local
     where status = 'open' order by opened_at_device desc limit 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    openedAtDeviceMs: row.opened_at_device,
  };
}

export interface VisitBreakdown {
  total: number;
  byOutcome: { outcome: string; count: number }[];
}

export async function getVisitBreakdown(
  sessionId: string,
): Promise<VisitBreakdown> {
  const rows = await sqlPort.query<{ outcome: string | null; n: number }>(
    `select coalesce(outcome, 'pending') as outcome, count(*) as n
     from visits_local where session_id = ? group by outcome order by n desc`,
    [sessionId],
  );
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    byOutcome: rows.map((r) => ({ outcome: r.outcome ?? 'pending', count: r.n })),
  };
}
