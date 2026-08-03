import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  adminClient,
  requireConsoleUser,
  userClient,
} from '../../../../../lib/supabase';
import {
  dateTimePH,
  signedMs,
  timePH,
  OUTCOME_LABELS,
} from '../../../../../lib/format';
import { SessionMap, type MapVisit } from './SessionMap';
import { FlagPanel, type FlagRow } from './FlagPanel';

export const dynamic = 'force-dynamic';

const PHOTO_BUCKET = 'field-photos';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ agentId: string; sessionId: string }>;
}) {
  await requireConsoleUser();
  const { agentId, sessionId } = await params;

  // Every read below runs as the supervisor. If the session's agent is not in
  // their tree, RLS returns nothing and this 404s — no explicit tree check to
  // forget.
  const supabase = await userClient();

  const { data: session } = await supabase
    .from('attendance_sessions')
    .select('*, agents(full_name, employee_no), branches:open_branch_id(name, lat, lng)')
    .eq('id', sessionId)
    .eq('agent_id', agentId)
    .maybeSingle();
  if (session === null) notFound();

  const [{ data: pings }, { data: visits }, { data: flags }] = await Promise.all([
    supabase
      .from('location_pings')
      .select('lat, lng, captured_at_device, received_at_server, device_clock_offset_ms, accuracy_m, battery_pct')
      .eq('session_id', sessionId)
      .order('captured_at_device'),
    supabase
      .from('visits')
      .select(
        'id, arrive_lat, arrive_lng, arrived_at_device, arrived_at_server, ' +
          'device_clock_offset_ms, outcome, is_within_geofence, ' +
          'arrive_distance_from_client_m, dwell_seconds_server, ' +
          'departure_was_inferred, arrive_jitter_m, arrive_sample_count, ' +
          'clients(display_name, lat, lng, geofence_radius_m)',
      )
      .eq('session_id', sessionId)
      .order('arrived_at_server'),
    supabase
      .from('integrity_flags')
      .select('id, flag_type, severity, detail, raised_at, resolved_at, resolution_note')
      .eq('session_id', sessionId)
      .order('raised_at', { ascending: false }),
  ]);

  // Signed photo URLs need the service key: Storage objects are not
  // world-readable and the supervisor's JWT has no Storage grant. This is one
  // of the few legitimate admin-client uses — the AUTHORISATION already
  // happened above, when RLS let us read the session at all.
  const admin = adminClient();
  const photoPaths = [
    session.open_photo_path as string | null,
    session.close_photo_path as string | null,
  ].filter((p): p is string => typeof p === 'string');
  const signed =
    photoPaths.length > 0
      ? (await admin.storage.from(PHOTO_BUCKET).createSignedUrls(photoPaths, 600))
          .data ?? []
      : [];
  const urlFor = (path: string | null): string | null =>
    path === null ? null : signed.find((s) => s.path === path)?.signedUrl ?? null;

  const visitRows = (visits ?? []) as unknown as {
    id: string;
    arrive_lat: number;
    arrive_lng: number;
    arrived_at_device: string;
    arrived_at_server: string;
    device_clock_offset_ms: number | null;
    outcome: string | null;
    is_within_geofence: boolean | null;
    arrive_distance_from_client_m: number | null;
    dwell_seconds_server: number | null;
    departure_was_inferred: boolean;
    clients: { display_name: string; lat: number | null; lng: number | null; geofence_radius_m: number } | null;
  }[];

  const mapVisits: MapVisit[] = visitRows.map((v) => ({
    lat: v.arrive_lat,
    lng: v.arrive_lng,
    outcome: v.outcome,
    clientName: v.clients?.display_name ?? 'Client',
    clientLat: v.clients?.lat ?? null,
    clientLng: v.clients?.lng ?? null,
    geofenceRadiusM: v.clients?.geofence_radius_m ?? 120,
    withinGeofence: v.is_within_geofence,
    distanceM: v.arrive_distance_from_client_m,
  }));

  // The timeline. Device time, server time, and the DELTA on every row — the
  // delta is the tell, so it gets its own column rather than being buried in
  // a tooltip or averaged into one session-level number.
  const timeline = [
    {
      label: 'Check-in',
      device: session.opened_at_device as string,
      server: session.opened_at_server as string,
      offset: session.device_clock_offset_ms as number | null,
    },
    ...visitRows.map((v) => ({
      label: `Visit · ${v.clients?.display_name ?? 'Client'}`,
      device: v.arrived_at_device,
      server: v.arrived_at_server,
      offset: v.device_clock_offset_ms,
    })),
    ...(session.closed_at_device !== null
      ? [
          {
            label: 'Check-out',
            device: session.closed_at_device as string,
            server: session.closed_at_server as string,
            offset: session.device_clock_offset_ms as number | null,
          },
        ]
      : []),
  ];

  const score = session.integrity_score as number | null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <Link href="/" className="text-sm text-gray-500 hover:text-gray-900">
        ← Balik sa board
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {(session.agents as { full_name: string } | null)?.full_name ?? 'Agent'}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {(session.agents as { employee_no: string } | null)?.employee_no} ·{' '}
            {dateTimePH(session.opened_at_server as string)} ·{' '}
            <span className="font-medium">{String(session.status)}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Integrity score
          </p>
          <p
            className={`text-4xl font-extrabold ${
              score === null
                ? 'text-gray-300'
                : score < 50
                  ? 'text-red-700'
                  : score < 85
                    ? 'text-amber-600'
                    : 'text-emerald-700'
            }`}
          >
            {score ?? '—'}
          </p>
          {/* Restating the rule where a supervisor will actually read it. */}
          <p className="mt-1 max-w-[16rem] text-[11px] leading-tight text-gray-400">
            Pang-triage lang ang score na ito. Hindi ito basehan ng disiplina o
            sahod.
          </p>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <SessionMap
            open={{
              lat: session.open_lat as number,
              lng: session.open_lng as number,
            }}
            close={
              session.close_lat === null
                ? null
                : {
                    lat: session.close_lat as number,
                    lng: session.close_lng as number,
                  }
            }
            pings={(pings ?? []).map((p) => ({
              lat: p.lat as number,
              lng: p.lng as number,
              at: p.captured_at_device as string,
            }))}
            visits={mapVisits}
          />

          <section>
            <h2 className="text-lg font-bold text-gray-900">Timeline</h2>
            <p className="mt-1 text-sm text-gray-500">
              Device time vs server time. Ang <strong>delta</strong> ang tell —
              malaking delta ay senyales ng binagong orasan.
            </p>
            <div className="mt-3 overflow-x-auto rounded-2xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Event</th>
                    <th className="px-4 py-2.5">Device time</th>
                    <th className="px-4 py-2.5">Server time</th>
                    <th className="px-4 py-2.5 text-right">Delta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {timeline.map((row, i) => {
                    const big =
                      row.offset !== null && Math.abs(row.offset) > 300_000;
                    return (
                      <tr key={i} className={big ? 'bg-red-50' : undefined}>
                        <td className="px-4 py-2.5 font-medium text-gray-900">
                          {row.label}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600">
                          {dateTimePH(row.device)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600">
                          {dateTimePH(row.server)}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono text-xs font-semibold ${
                            big ? 'text-red-700' : 'text-gray-700'
                          }`}
                        >
                          {signedMs(row.offset)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-bold text-gray-900">
              Mga visit ({visitRows.length})
            </h2>
            <div className="mt-3 overflow-x-auto rounded-2xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Client</th>
                    <th className="px-4 py-2.5">Dating</th>
                    <th className="px-4 py-2.5">Outcome</th>
                    <th className="px-4 py-2.5 text-right">Layo</th>
                    <th className="px-4 py-2.5 text-right">Dwell</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visitRows.map((v) => (
                    <tr key={v.id}>
                      <td className="px-4 py-2.5 text-gray-900">
                        {v.clients?.display_name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {timePH(v.arrived_at_server)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">
                        {OUTCOME_LABELS[v.outcome ?? ''] ?? '—'}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right ${
                          v.is_within_geofence === false
                            ? 'font-semibold text-red-700'
                            : 'text-gray-600'
                        }`}
                      >
                        {v.arrive_distance_from_client_m === null
                          ? '—'
                          : `${Math.round(v.arrive_distance_from_client_m)}m`}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-600">
                        {v.dwell_seconds_server === null
                          ? '—'
                          : `${Math.round(v.dwell_seconds_server / 60)}m`}
                        {v.departure_was_inferred && (
                          <span
                            className="ml-1 text-xs text-amber-600"
                            title="Hindi nag-tap ng AALIS NA AKO — hinuha ng server"
                          >
                            ~
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <h2 className="text-lg font-bold text-gray-900">Mga selfie</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {[
                {
                  label: 'Check-in',
                  url: urlFor(session.open_photo_path as string | null),
                  accuracy: session.open_accuracy_m as number | null,
                  jitter: session.open_jitter_m as number | null,
                  samples: session.open_sample_count as number | null,
                  mocked: session.open_is_mocked as boolean | null,
                },
                {
                  label: 'Check-out',
                  url: urlFor(session.close_photo_path as string | null),
                  accuracy: session.close_accuracy_m as number | null,
                  jitter: session.close_jitter_m as number | null,
                  samples: session.close_sample_count as number | null,
                  mocked: session.close_is_mocked as boolean | null,
                },
              ].map((photo) => (
                <figure
                  key={photo.label}
                  className="overflow-hidden rounded-2xl border border-gray-200 bg-white"
                >
                  {photo.url === null ? (
                    <div className="flex aspect-[3/4] items-center justify-center bg-gray-100 text-xs text-gray-400">
                      Walang litrato
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photo.url}
                      alt={`${photo.label} selfie`}
                      className="aspect-[3/4] w-full object-cover"
                    />
                  )}
                  <figcaption className="p-3">
                    <p className="text-sm font-semibold text-gray-900">
                      {photo.label}
                    </p>
                    <dl className="mt-1 space-y-0.5 text-xs text-gray-600">
                      <div className="flex justify-between">
                        <dt>Accuracy</dt>
                        <dd>
                          {photo.accuracy === null
                            ? '—'
                            : `±${photo.accuracy.toFixed(1)}m`}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>Jitter</dt>
                        <dd
                          className={
                            photo.jitter === 0 ? 'font-bold text-red-700' : ''
                          }
                        >
                          {photo.jitter === null ? '—' : `${photo.jitter}m`}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>Samples</dt>
                        <dd>{photo.samples ?? '—'}</dd>
                      </div>
                      {photo.mocked === true && (
                        <div className="mt-1 rounded bg-red-600 px-1.5 py-0.5 text-center font-bold text-white">
                          MOCKED
                        </div>
                      )}
                    </dl>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          <FlagPanel
            flags={(flags ?? []) as unknown as FlagRow[]}
            sessionId={sessionId}
            sessionStatus={String(session.status)}
          />
        </div>
      </div>
    </main>
  );
}
