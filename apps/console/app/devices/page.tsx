import { requireConsoleUser, userClient } from '../../lib/supabase';
import { dateTimePH, FLAG_LABELS } from '../../lib/format';
import { RebindQueue, type RebindRequest } from './RebindQueue';

export const dynamic = 'force-dynamic';

// Pending device rebind requests. Each one is an agent standing somewhere
// with a phone that will not let them check in, so this page is time
// sensitive — and it shows the agent's flag history, because "my phone broke"
// reads differently next to three mock_location flags.
export default async function DevicesPage() {
  await requireConsoleUser();
  const supabase = await userClient();

  const { data: flags } = await supabase
    .from('integrity_flags')
    .select('id, agent_id, detail, raised_at, agents(full_name, employee_no)')
    .eq('flag_type', 'device_mismatch')
    .is('resolved_at', null)
    .order('raised_at', { ascending: true });

  const pending = (flags ?? []) as unknown as {
    id: string;
    agent_id: string;
    detail: Record<string, unknown> | null;
    raised_at: string;
    agents: { full_name: string; employee_no: string } | null;
  }[];

  const deviceIds = pending.flatMap((f) => [
    String(f.detail?.['new_device_id'] ?? ''),
    String(f.detail?.['current_device_id'] ?? ''),
  ]).filter((id) => id.length > 0 && id !== 'undefined' && id !== 'null');

  const devices =
    deviceIds.length === 0
      ? []
      : (
          await supabase
            .from('devices')
            .select(
              'id, android_id, device_model, manufacturer, os_version, app_version, bound_at',
            )
            .in('id', deviceIds)
        ).data ?? [];

  const deviceMap = new Map(
    devices.map((d) => [d.id as string, d as Record<string, unknown>]),
  );

  // Flag history per agent — the context that turns a yes/no into a judgement.
  const agentIds = [...new Set(pending.map((p) => p.agent_id))];
  const history =
    agentIds.length === 0
      ? []
      : (
          await supabase
            .from('integrity_flags')
            .select('agent_id, flag_type, severity, raised_at')
            .in('agent_id', agentIds)
            .order('raised_at', { ascending: false })
            .limit(200)
        ).data ?? [];

  const requests: RebindRequest[] = pending.map((flag) => ({
    flagId: flag.id,
    agentId: flag.agent_id,
    agentName: flag.agents?.full_name ?? 'Agent',
    employeeNo: flag.agents?.employee_no ?? '',
    requestCode: String(flag.detail?.['request_code'] ?? ''),
    raisedAt: dateTimePH(flag.raised_at),
    newDevice: deviceMap.get(String(flag.detail?.['new_device_id'] ?? '')) ?? null,
    oldDevice: deviceMap.get(String(flag.detail?.['current_device_id'] ?? '')) ?? null,
    history: history
      .filter((h) => h.agent_id === flag.agent_id)
      .slice(0, 10)
      .map((h) => ({
        label: FLAG_LABELS[h.flag_type as string] ?? String(h.flag_type),
        severity: String(h.severity),
        at: dateTimePH(h.raised_at as string),
      })),
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Device rebind requests</h1>
        <p className="mt-1 text-sm text-gray-500">
          {requests.length} naghihintay. Tawagan ang ahente at hingin ang 6-char
          code bago mag-approve.
        </p>
      </header>
      <div className="mt-6">
        <RebindQueue requests={requests} />
      </div>
    </main>
  );
}
