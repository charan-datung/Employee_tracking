import { useCallback, useEffect, useState } from 'react';
import { captureVerifiedFix } from '../../services/location/index.ts';
import { syncApi } from '../../services/sync/index.ts';
import { setLastPosition } from '../clients/lastPosition.ts';
import { getOpenVisit, type OpenVisit } from '../attendance/queries.ts';

// "AALIS NA AKO". Departure is OPTIONAL by design: if the agent walks away
// without tapping it, the server infers the departure at the next arrival or
// at check-out and marks departure_was_inferred = true. So a failed fix here
// is not an error state — the agent can just leave, and the record still
// closes honestly.
export function OpenVisitCard({
  sessionId,
  onDeparted,
}: {
  sessionId: string;
  onDeparted(): void;
}) {
  const [visit, setVisit] = useState<OpenVisit | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void getOpenVisit(sessionId).then(setVisit);
  }, [sessionId]);

  const depart = useCallback(async () => {
    if (visit === null) return;
    setBusy(true);
    setFailed(false);
    const fix = await captureVerifiedFix({ purpose: 'visit_depart' });
    if (!fix.ok) {
      // No coordinates, no departure row — the server's inference covers it.
      setFailed(true);
      setBusy(false);
      return;
    }
    await setLastPosition(fix.lat, fix.lng, fix.captured_at_device);
    await syncApi.enqueueVisitDeparture({
      visitId: visit.id,
      sessionId,
      departedAtDeviceMs: fix.captured_at_device,
      lat: fix.lat,
      lng: fix.lng,
    });
    setVisit(null);
    setBusy(false);
    onDeparted();
  }, [visit, sessionId, onDeparted]);

  if (visit === null) return null;

  return (
    <section className="mt-4 rounded-2xl border-2 border-emerald-500 bg-white p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">
        Nasa bahay ka pa ni
      </p>
      <p className="mt-1 text-base font-semibold text-gray-900">
        {visit.display_name ?? 'Client'}
      </p>
      {failed && (
        <p className="mt-2 text-sm text-amber-800">
          Hindi makuha ang lokasyon. Puwede ka nang umalis — awtomatikong
          isasara ito sa susunod mong visit o sa check-out.
        </p>
      )}
      <button
        type="button"
        onClick={() => void depart()}
        disabled={busy}
        className="mt-3 h-14 w-full rounded-xl bg-emerald-600 text-lg font-bold text-white active:bg-emerald-700 disabled:bg-gray-300"
      >
        {busy ? 'Kinukuha ang lokasyon…' : 'AALIS NA AKO'}
      </button>
    </section>
  );
}
