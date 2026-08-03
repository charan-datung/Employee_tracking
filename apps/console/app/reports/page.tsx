import { requireConsoleUser, userClient } from '../../lib/supabase';
import { SHOW_DURATION } from '../../lib/reportFlags';
import { ReportTable, type ReportRow } from './ReportTable';

export const dynamic = 'force-dynamic';

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - 13 * 86_400_000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(now) };
}

// Per agent per day. Reads through RLS as the supervisor, so the report can
// only ever contain their tree.
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requireConsoleUser();
  const params = await searchParams;
  const range = {
    from: params.from ?? defaultRange().from,
    to: params.to ?? defaultRange().to,
  };

  // supabase-js cannot infer the shape of an embedded select without
  // generated Database types, so joined reads are cast explicitly. The cast
  // describes the SELECT above it; keep them in sync.
  interface SessionRow {
    id: string;
    agent_id: string;
    status: string;
    opened_at_server: string;
    closed_at_server: string | null;
    integrity_score: number | null;
    agents: { full_name: string; employee_no: string } | null;
  }

  const supabase = await userClient();
  const { data: sessionData } = await supabase
    .from('attendance_sessions')
    .select(
      'id, agent_id, status, opened_at_server, closed_at_server, integrity_score, ' +
        'agents(full_name, employee_no)',
    )
    .gte('opened_at_server', `${range.from}T00:00:00+08:00`)
    .lte('opened_at_server', `${range.to}T23:59:59+08:00`)
    .order('opened_at_server', { ascending: false });

  const sessions = (sessionData ?? []) as unknown as SessionRow[];
  const sessionIds = sessions.map((s) => s.id);
  const visits =
    sessionIds.length === 0
      ? []
      : (
          await supabase
            .from('visits')
            .select('session_id, outcome')
            .in('session_id', sessionIds)
        ).data ?? [];
  const flags =
    sessionIds.length === 0
      ? []
      : (
          await supabase
            .from('integrity_flags')
            .select('session_id, severity')
            .in('session_id', sessionIds)
        ).data ?? [];

  const rows: ReportRow[] = sessions.map((s) => {
    const sessionVisits = visits.filter((v) => v.session_id === s.id);
    const outcomeMix: Record<string, number> = {};
    for (const v of sessionVisits) {
      const key = (v.outcome as string | null) ?? 'pending';
      outcomeMix[key] = (outcomeMix[key] ?? 0) + 1;
    }
    const sessionFlags = flags.filter((f) => f.session_id === s.id);
    return {
      sessionId: s.id,
      agentId: s.agent_id,
      agentName: s.agents?.full_name ?? 'Agent',
      employeeNo: s.agents?.employee_no ?? '',
      status: s.status,
      openedAt: s.opened_at_server,
      closedAt: s.closed_at_server,
      visitCount: sessionVisits.length,
      outcomeMix,
      integrityScore: s.integrity_score,
      criticalFlags: sessionFlags.filter((f) => f.severity === 'critical').length,
      warnFlags: sessionFlags.filter((f) => f.severity === 'warn').length,
    };
  });

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Kada ahente kada araw. {rows.length} session mula {range.from} hanggang {range.to}.
        </p>
      </header>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-600">Mula</span>
          <input type="date" name="from" defaultValue={range.from}
            className="mt-1 h-10 rounded-xl border border-gray-300 px-3" />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600">Hanggang</span>
          <input type="date" name="to" defaultValue={range.to}
            className="mt-1 h-10 rounded-xl border border-gray-300 px-3" />
        </label>
        <button type="submit"
          className="h-10 rounded-xl bg-gray-900 px-5 text-sm font-semibold text-white">
          I-filter
        </button>
      </form>
      <div className="mt-6">
        <ReportTable rows={rows} showDuration={SHOW_DURATION} />
      </div>
    </main>
  );
}
