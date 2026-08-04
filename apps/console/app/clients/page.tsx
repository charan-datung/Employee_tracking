import Link from 'next/link';
import { requireConsoleUser, userClient } from '../../lib/supabase';
import { nominatimGeocoder } from '../../lib/geocoder';
import { ClientsView, type ClientRow } from './ClientsView';

export const dynamic = 'force-dynamic';

// Clients: table + map + CSV import. RLS (clients_select_reports) scopes this
// to clients assigned to the supervisor's reporting tree.
export default async function ClientsPage() {
  const user = await requireConsoleUser();
  const supabase = await userClient();

  const { data } = await supabase
    .from('clients')
    .select(
      'id, external_ref, display_name, account_type, address_text, barangay, ' +
        'city, lat, lng, geofence_radius_m, geocode_confidence, is_active',
    )
    .eq('is_active', true)
    .order('display_name');

  // Open "pin likely wrong" tasks, surfaced inline so a bad pin is visible
  // where someone is already looking at the client list.
  const { data: tasks } = await supabase
    .from('pin_review_tasks')
    .select('id, client_id, evidence_agent_count, spread_m')
    .eq('status', 'open');

  // supabase-js cannot infer these shapes without generated Database types.
  const taskRows = (tasks ?? []) as unknown as {
    id: string;
    client_id: string;
    evidence_agent_count: number;
    spread_m: number;
  }[];
  const taskByClient = new Map(
    taskRows.map((t) => [t.client_id, { id: t.id, agents: t.evidence_agent_count }]),
  );

  const clientRows = (data ?? []) as unknown as Record<string, unknown>[];
  const rows: ClientRow[] = clientRows.map((c) => ({
    id: String(c['id']),
    externalRef: (c['external_ref'] as string | null) ?? null,
    displayName: String(c['display_name']),
    accountType: String(c['account_type']),
    addressText: (c['address_text'] as string | null) ?? null,
    barangay: (c['barangay'] as string | null) ?? null,
    city: (c['city'] as string | null) ?? null,
    lat: c['lat'] as number | null,
    lng: c['lng'] as number | null,
    geofenceRadiusM: Number(c['geofence_radius_m']),
    geocodeConfidence: String(c['geocode_confidence']),
    pinTask: taskByClient.get(String(c['id'])) ?? null,
  }));

  // Reassignment is admin-only, so the agent list is only fetched for them.
  const { data: agentData } = user.isAdmin
    ? await supabase
        .from('agents')
        .select('id, full_name, employee_no')
        .eq('employment_status', 'active')
        .order('full_name')
    : { data: [] };
  const assignableAgents = ((agentData ?? []) as unknown as Record<string, unknown>[]).map(
    (a) => ({
      id: String(a['id']),
      name: `${String(a['full_name'])} (${String(a['employee_no'])})`,
    }),
  );

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="mt-1 text-sm text-gray-500">
            {rows.length} aktibong client ·{' '}
            {rows.filter((r) => r.pinTask !== null).length} may &ldquo;pin likely
            wrong&rdquo; na task
          </p>
        </div>
        <Link href="/pins" className="text-sm font-medium text-emerald-700 underline">
          Pin review queue →
        </Link>
      </header>
      <div className="mt-6">
        <ClientsView
          rows={rows}
          geocoderAvailable={nominatimGeocoder.available}
          isAdmin={user.isAdmin}
          assignableAgents={assignableAgents}
        />
      </div>
    </main>
  );
}
