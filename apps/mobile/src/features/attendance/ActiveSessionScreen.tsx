import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SyncStatusPill } from '../../services/sync/index.ts';
import { useAttendance } from './AttendanceProvider.tsx';
import { elapsedLabelSince } from './elapsed.ts';

const OUTCOME_LABELS: Record<string, string> = {
  contacted_paid: 'Nagbayad',
  contacted_promised: 'Nangako',
  contacted_refused: 'Ayaw magbayad',
  not_home: 'Wala sa bahay',
  wrong_address: 'Maling address',
  closed_business: 'Sarado ang negosyo',
  client_relocated: 'Lumipat',
  other: 'Iba pa',
  pending: 'Hindi pa tapos',
};

// Home when a session is open.
export function ActiveSessionScreen() {
  const { session, visits, permissionRevoked, canLogVisit, banner, dismissBanner, recheckPermission } =
    useAttendance();
  const navigate = useNavigate();
  const [confirmingCheckOut, setConfirmingCheckOut] = useState(false);
  // Re-render for the elapsed label. DISPLAY ONLY — nothing here is stored.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (session === null) return null;
  const elapsed = elapsedLabelSince(session.openedAtDeviceMs, tick);

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-6 pb-8 pt-12">
      <header className="flex items-start justify-between">
        <div>
          <p className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
            <span className="h-2 w-2 rounded-full bg-emerald-600" />
            NAKA-CHECK IN
          </p>
          {/* Presentation-layer only (CLAUDE.md rule 8) — never persisted. */}
          {elapsed !== null && (
            <p className="mt-2 text-3xl font-bold text-gray-900">{elapsed}</p>
          )}
        </div>
        <SyncStatusPill />
      </header>

      {banner === 'resumed_after_restart' && (
        <div className="mt-4 rounded-2xl bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-900">
            Bumalik ang app — tuloy pa rin ang session mo.
          </p>
          <p className="mt-1 text-sm text-blue-900">
            Muling binuksan ang location tracking. Hindi mo kailangang
            mag-check in ulit.
          </p>
          <button
            type="button"
            onClick={dismissBanner}
            className="mt-2 text-sm font-semibold text-blue-900 underline"
          >
            Sige
          </button>
        </div>
      )}

      {permissionRevoked && (
        <div className="mt-4 rounded-2xl border-2 border-red-500 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-900">
            Na-off ang location permission.
          </p>
          <p className="mt-1 text-sm text-red-900">
            Hindi ka makakapag-log ng visit hangga't hindi ito naibabalik.
            Naitala na ito at makikita ng supervisor mo. Buksan ang Settings →
            Apps → Datung Field → Permissions → Location → Allow.
          </p>
          <button
            type="button"
            onClick={() => void recheckPermission()}
            className="mt-3 h-12 w-full rounded-xl bg-red-600 text-base font-semibold text-white"
          >
            Naibalik ko na — i-check ulit
          </button>
        </div>
      )}

      <section className="mt-6 rounded-2xl bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            Mga visit ngayong araw
          </h2>
          <span className="text-2xl font-bold text-gray-900">{visits.total}</span>
        </div>
        {visits.byOutcome.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">Wala pang naitalang visit.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {visits.byOutcome.map((row) => (
              <li key={row.outcome} className="flex justify-between text-sm">
                <span className="text-gray-600">
                  {OUTCOME_LABELS[row.outcome] ?? row.outcome}
                </span>
                <span className="font-semibold text-gray-900">{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex-1" />

      <div className="space-y-3">
        <button
          type="button"
          disabled={!canLogVisit}
          onClick={() => navigate('/visit')}
          className="h-16 w-full rounded-2xl bg-emerald-600 text-xl font-bold text-white active:bg-emerald-700 disabled:bg-gray-300"
        >
          MAGLOG NG VISIT
        </button>
        <button
          type="button"
          onClick={() => setConfirmingCheckOut(true)}
          className="h-14 w-full rounded-2xl border-2 border-red-300 bg-white text-lg font-semibold text-red-700 active:bg-red-50"
        >
          MAG-CHECK OUT
        </button>
      </div>

      {confirmingCheckOut && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-5">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6">
            <h2 className="text-xl font-bold text-gray-900">
              Sigurado ka bang mag-check out?
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Titigil ang location tracking at matatapos ang araw mo. Hindi mo
              na ito maibabalik — kailangan mong mag-check in ulit.
            </p>
            <button
              type="button"
              onClick={() => navigate('/check-out')}
              className="mt-5 h-14 w-full rounded-xl bg-red-600 text-lg font-semibold text-white active:bg-red-700"
            >
              Oo, mag-check out
            </button>
            <button
              type="button"
              onClick={() => setConfirmingCheckOut(false)}
              className="mt-3 h-14 w-full rounded-xl border border-gray-300 text-lg font-semibold text-gray-700"
            >
              Hindi pa
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
