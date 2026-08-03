'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { BASEMAP_STYLE } from '../../lib/tiles';
import { importClientsAction, type ImportReport } from './actions';

export interface ClientRow {
  id: string;
  externalRef: string | null;
  displayName: string;
  accountType: string;
  addressText: string | null;
  barangay: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  geofenceRadiusM: number;
  geocodeConfidence: string;
  pinTask: { id: string; agents: number } | null;
}

const CONFIDENCE_STYLE: Record<string, string> = {
  exact: 'bg-emerald-100 text-emerald-800',
  approximate: 'bg-amber-100 text-amber-800',
  unverified: 'bg-gray-200 text-gray-700',
};

// Minimal CSV parser: handles quoted fields and embedded commas, which is all
// a spreadsheet export produces. No dependency for something this small.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

const TEMPLATE_HEADERS = [
  'external_ref', 'display_name', 'account_type', 'address_text',
  'barangay', 'city', 'lat', 'lng', 'assigned_employee_no',
];

export function ClientsView({
  rows,
  geocoderAvailable,
}: {
  rows: ClientRow[];
  geocoderAvailable: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        (r.externalRef ?? '').toLowerCase().includes(q) ||
        (r.barangay ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  useEffect(() => {
    if (containerRef.current === null || mapRef.current !== null) return;
    let disposed = false;
    void (async () => {
      const { Map, Marker, Popup, NavigationControl, LngLatBounds } =
        await import('maplibre-gl');
      if (disposed || containerRef.current === null) return;
      const pinned = rows.filter((r) => r.lat !== null && r.lng !== null);
      const map = new Map({
        container: containerRef.current,
        style: BASEMAP_STYLE,
        center: pinned[0] ? [pinned[0].lng as number, pinned[0].lat as number] : [120.98, 14.45],
        zoom: 11,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl(), 'top-right');
      for (const client of pinned) {
        const el = document.createElement('div');
        const color =
          client.pinTask !== null
            ? '#dc2626'
            : client.geocodeConfidence === 'exact'
              ? '#059669'
              : '#f59e0b';
        el.style.cssText = `width:11px;height:11px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.3)`;
        new Marker({ element: el })
          .setLngLat([client.lng as number, client.lat as number])
          .setPopup(
            new Popup().setHTML(
              `<strong>${client.displayName}</strong><br/>${client.barangay ?? ''}${
                client.pinTask !== null ? '<br/><em>Pin likely wrong</em>' : ''
              }`,
            ),
          )
          .addTo(map);
      }
      if (pinned.length > 1) {
        const first: [number, number] = [pinned[0]!.lng as number, pinned[0]!.lat as number];
        const bounds = pinned.reduce(
          (acc, c) => acc.extend([c.lng as number, c.lat as number]),
          new LngLatBounds(first, first),
        );
        map.fitBounds(bounds, { padding: 50, maxZoom: 14 });
      }
    })();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [rows]);

  const onFile = async (file: File) => {
    setImporting(true);
    setReport(null);
    const table = parseCsv(await file.text());
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const idx = (name: string): number => header.indexOf(name);
    const num = (v: string | undefined): number | null => {
      const n = Number((v ?? '').trim());
      return (v ?? '').trim().length > 0 && Number.isFinite(n) ? n : null;
    };
    const str = (v: string | undefined): string | null => {
      const s = (v ?? '').trim();
      return s.length > 0 ? s : null;
    };
    const parsedRows = table.slice(1).map((cols) => ({
      external_ref: str(cols[idx('external_ref')]),
      display_name: (cols[idx('display_name')] ?? '').trim(),
      account_type: (cols[idx('account_type')] ?? '').trim(),
      address_text: str(cols[idx('address_text')]),
      barangay: str(cols[idx('barangay')]),
      city: str(cols[idx('city')]),
      lat: num(cols[idx('lat')]),
      lng: num(cols[idx('lng')]),
      assigned_employee_no: str(cols[idx('assigned_employee_no')]),
    }));
    setReport(await importClientsAction({ rows: parsedRows }));
    setImporting(false);
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="font-semibold text-gray-900">CSV bulk import</h2>
        <p className="mt-1 text-sm text-gray-500">
          Mga column: <code className="text-xs">{TEMPLATE_HEADERS.join(', ')}</code>.
          Kung walang lat/lng,{' '}
          {geocoderAvailable ? (
            <>ge-geocode ito gamit ang self-hosted Nominatim.</>
          ) : (
            <span className="font-semibold text-amber-700">
              hindi naka-configure ang geocoder (NOMINATIM_URL) — mapupunta ang
              rows sa pin review bilang &lsquo;unverified&rsquo;.
            </span>
          )}
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={importing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void onFile(file);
          }}
          className="mt-3 block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
        />
        {importing && (
          <p className="mt-2 text-sm text-gray-600">
            Ini-import at gine-geocode… mabagal ito nang sadya (1 address kada
            segundo) para hindi masobrahan ang geocoder.
          </p>
        )}
        {report !== null && (
          <div
            className={`mt-3 rounded-xl p-3 text-sm ${
              report.status === 'ok'
                ? 'bg-emerald-50 text-emerald-900'
                : 'bg-red-50 text-red-800'
            }`}
          >
            {report.status === 'ok' ? (
              <p>
                Na-import: <strong>{report.inserted}</strong> · na-geocode:{' '}
                {report.geocoded} · unverified: {report.unverified}
              </p>
            ) : (
              <p>{report.message}</p>
            )}
            {report.failedRows.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {report.failedRows.slice(0, 10).map((f) => (
                  <li key={f.row}>
                    Row {f.row}: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <div ref={containerRef} className="h-[360px] w-full rounded-2xl border border-gray-200" />

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Hanapin sa pangalan, ref, o barangay"
        className="h-11 w-full rounded-xl border border-gray-300 px-4 text-sm"
      />

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Ref</th>
              <th className="px-4 py-3">Lugar</th>
              <th className="px-4 py-3">Geocode</th>
              <th className="px-4 py-3">Pin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((c) => (
              <tr key={c.id} className={c.pinTask !== null ? 'bg-red-50' : undefined}>
                <td className="px-4 py-3 font-medium text-gray-900">{c.displayName}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">
                  {c.externalRef ?? '—'}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {[c.barangay, c.city].filter(Boolean).join(', ') || '—'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      CONFIDENCE_STYLE[c.geocodeConfidence] ?? 'bg-gray-200'
                    }`}
                  >
                    {c.geocodeConfidence}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {c.pinTask !== null ? (
                    <Link
                      href={`/pins/${c.pinTask.id}`}
                      className="text-xs font-semibold text-red-700 underline"
                    >
                      Pin likely wrong ({c.pinTask.agents} ahente) — ayusin
                    </Link>
                  ) : c.lat === null ? (
                    <span className="text-xs text-gray-400">Walang pin</span>
                  ) : (
                    <span className="text-xs text-gray-400">OK</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
