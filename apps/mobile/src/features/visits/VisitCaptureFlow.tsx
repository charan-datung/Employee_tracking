import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  captureVerifiedFix,
  type VerifiedFix,
} from '../../services/location/index.ts';
import {
  reportIntegrityFlag,
  syncApi,
  type SavedPhoto,
} from '../../services/sync/index.ts';
import { setLastPosition } from '../clients/lastPosition.ts';
import { getClientWithDistance, type ClientForGate } from '../clients/repo.ts';
import { getLastPosition } from '../clients/lastPosition.ts';
import { rejectionPolicy, type RejectionPolicy } from '../attendance/rejectionPolicy.ts';
import { useAttendance } from '../attendance/AttendanceProvider.tsx';
import { useAuth } from '../auth/AuthProvider';
import { SelfieCaptureView } from '../camera/SelfieCaptureView.tsx';
import {
  GEOFENCE_MISS_REASONS,
  MIN_NOTES_LENGTH,
  canSaveVisit,
  evaluateGate,
  notesRequired,
  photoRequired,
  visitBlockers,
  type GateDecision,
  type GeofenceMissReason,
} from './gate.ts';
import { OUTCOME_OPTIONS, type VisitOutcome } from './outcomes.ts';

type Step =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'rejected'; policy: RejectionPolicy; requestPermission: boolean }
  | { kind: 'blocked'; label: string }
  | { kind: 'form'; fix: VerifiedFix; gate: GateDecision }
  | { kind: 'photo'; fix: VerifiedFix; gate: GateDecision }
  | { kind: 'saving' };

const BLOCKER_COPY: Record<string, string> = {
  reason_missing: 'Pumili ng dahilan kung bakit malayo ka sa address.',
  outcome_missing: 'Pumili ng resulta ng visit.',
  notes_too_short: `Kailangan ng paliwanag (hindi bababa sa ${MIN_NOTES_LENGTH} letra).`,
  photo_missing: 'Kailangan ng litrato para sa resultang ito.',
};

export function VisitCaptureFlow() {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const { agent } = useAuth();
  const { session, canLogVisit, refresh } = useAttendance();

  const [client, setClient] = useState<ClientForGate | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<VisitOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState<GeofenceMissReason | null>(null);
  const [photo, setPhoto] = useState<SavedPhoto | null>(null);
  const [showBlockers, setShowBlockers] = useState(false);
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    void (async () => {
      if (clientId === undefined) return;
      const pos = await getLastPosition();
      setClient(await getClientWithDistance(clientId, pos));
    })();
  }, [clientId]);

  const arrive = useCallback(
    async (requestPermission: boolean) => {
      if (clientId === undefined) return;
      setStep({ kind: 'locating' });
      const result = await captureVerifiedFix({
        purpose: 'visit_arrive',
        ...(requestPermission ? { requestPermission: true } : {}),
      });

      if (!result.ok) {
        const next = failures + 1;
        setFailures(next);
        const policy = rejectionPolicy(result, next, session?.id ?? null);
        if (policy.flag !== null) void reportIntegrityFlag(policy.flag);
        setStep({
          kind: 'rejected',
          policy,
          requestPermission: policy.retryWithPermissionRequest,
        });
        return;
      }

      setFailures(0);
      await setLastPosition(result.lat, result.lng, result.captured_at_device);
      // Re-read the client WITH the fresh position so the gate judges where
      // the agent is standing now, not where they were.
      const fresh = await getClientWithDistance(clientId, {
        lat: result.lat,
        lng: result.lng,
      });
      setClient(fresh);
      const gate = evaluateGate(
        fresh?.distance_m ?? null,
        fresh?.geofence_radius_m ?? 120,
      );
      if (gate.kind === 'blocked') {
        setStep({ kind: 'blocked', label: gate.distanceLabel });
        return;
      }
      setStep({ kind: 'form', fix: result, gate });
    },
    [clientId, failures, session],
  );

  const save = useCallback(async () => {
    if (step.kind !== 'form' || agent === null || session === null) return;
    const draft = {
      outcome,
      notes,
      hasPhoto: photo !== null,
      geofenceMissReason: reason,
    };
    if (!canSaveVisit(draft, step.gate)) {
      setShowBlockers(true);
      return;
    }
    setStep({ kind: 'saving' });
    try {
      await syncApi.enqueueVisit({
        visitId: crypto.randomUUID(),
        sessionId: session.id,
        agentId: agent.id,
        clientId: clientId ?? '',
        arrivedAtDeviceMs: step.fix.captured_at_device,
        lat: step.fix.lat,
        lng: step.fix.lng,
        accuracyM: step.fix.accuracy_m,
        isMocked: step.fix.is_mocked,
        deviceUptimeMs: step.fix.device_uptime_ms,
        outcome,
        outcomeNotes: notes.trim().length > 0 ? notes.trim() : null,
        // Only meaningful when the gate demanded one; the server raises
        // geofence_miss from its OWN distance, not from this field.
        geofenceMissReason: step.gate.kind === 'reason_required' ? reason : null,
        photo,
      });
      await refresh();
      navigate('/', { replace: true });
    } catch {
      setStep({ kind: 'form', fix: step.fix, gate: step.gate });
      setShowBlockers(true);
    }
  }, [step, agent, session, outcome, notes, photo, reason, clientId, refresh, navigate]);

  if (step.kind === 'photo') {
    return (
      <SelfieCaptureView
        title="Litrato ng visit"
        agentId={agent?.id ?? ''}
        kind="visit"
        onCaptured={(saved) => {
          setPhoto(saved);
          setStep({ kind: 'form', fix: step.fix, gate: step.gate });
        }}
        onCancel={() => setStep({ kind: 'form', fix: step.fix, gate: step.gate })}
      />
    );
  }

  const blockers = visitBlockers(
    { outcome, notes, hasPhoto: photo !== null, geofenceMissReason: reason },
    step.kind === 'form' ? step.gate : { kind: 'inside', distanceM: 0 },
  );

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-5 pb-8 pt-12">
      <header className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => navigate('/visit', { replace: true })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl text-gray-600"
          aria-label="Bumalik"
        >
          ←
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold text-gray-900">
            {client?.display_name ?? 'Client'}
          </h1>
          <p className="truncate text-sm text-gray-500">{client?.barangay ?? ''}</p>
        </div>
      </header>

      {!canLogVisit && (
        <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm font-medium text-red-900">
          Hindi ka makakapag-log ng visit habang naka-off ang location
          permission.
        </p>
      )}

      {step.kind === 'idle' && canLogVisit && (
        <div className="flex flex-1 items-center justify-center">
          <button
            type="button"
            onClick={() => void arrive(false)}
            className="h-24 w-full rounded-3xl bg-emerald-600 text-2xl font-extrabold text-white active:bg-emerald-700"
          >
            DUMATING NA AKO
          </button>
        </div>
      )}

      {step.kind === 'locating' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <span className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
          <p className="text-base font-medium text-gray-700">
            Kinukuha ang lokasyon…
          </p>
        </div>
      )}

      {step.kind === 'rejected' && (
        <div className="mt-6">
          <div className="rounded-2xl bg-red-50 p-5">
            <h2 className="text-lg font-bold text-red-800">{step.policy.title}</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-red-900">
              {step.policy.body}
            </p>
          </div>
          {step.policy.retryLabel !== null && (
            <button
              type="button"
              onClick={() => void arrive(step.requestPermission)}
              className="mt-4 h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white"
            >
              {step.policy.retryLabel}
            </button>
          )}
        </div>
      )}

      {/* Beyond the hard limit. No override exists on this screen or any
          other — a genuinely wrong pin is fixed in the console. */}
      {step.kind === 'blocked' && (
        <div className="mt-6">
          <div className="rounded-2xl border-2 border-red-500 bg-red-50 p-5">
            <h2 className="text-lg font-bold text-red-900">
              Masyado kang malayo sa address ng client ({step.label}).
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-red-900">
              Hindi puwedeng mag-log ng visit mula rito. Kung mali ang pin sa
              mapa, i-report ito sa supervisor mo — sila ang magtatama nito sa
              console.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/visit', { replace: true })}
            className="mt-4 h-14 w-full rounded-xl bg-gray-900 text-lg font-semibold text-white"
          >
            Bumalik sa listahan
          </button>
        </div>
      )}

      {step.kind === 'form' && (
        <div className="mt-5 space-y-5">
          {step.gate.kind === 'reason_required' && (
            <section className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4">
              <h2 className="text-sm font-bold text-amber-900">
                Nasa labas ka ng geofence. Bakit?
              </h2>
              <div className="mt-3 space-y-2">
                {GEOFENCE_MISS_REASONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setReason(option)}
                    className={`h-12 w-full rounded-xl border-2 px-4 text-left text-[15px] font-medium ${
                      reason === option
                        ? 'border-amber-600 bg-white text-amber-900'
                        : 'border-transparent bg-white/60 text-gray-700'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </section>
          )}

          {step.gate.kind === 'no_pin' && (
            <p className="rounded-2xl bg-gray-100 p-4 text-sm text-gray-600">
              Walang pin sa mapa ang client na ito, kaya hindi masusukat ang
              layo. Ituloy lang ang visit.
            </p>
          )}

          <section>
            <h2 className="text-sm font-bold text-gray-900">Resulta ng visit</h2>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {OUTCOME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setOutcome(option.value)}
                  className={`min-h-[76px] rounded-2xl border-2 p-3 text-left ${
                    outcome === option.value
                      ? 'border-emerald-600 bg-emerald-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <span className="block text-[15px] font-bold text-gray-900">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-500">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <label htmlFor="notes" className="text-sm font-bold text-gray-900">
              Paliwanag{' '}
              {outcome !== null && notesRequired(outcome) ? (
                <span className="text-red-600">(kailangan)</span>
              ) : (
                <span className="font-normal text-gray-400">(opsyonal)</span>
              )}
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-xl border border-gray-300 p-3 text-base focus:border-emerald-600 focus:outline-none"
            />
          </section>

          <section>
            <h2 className="text-sm font-bold text-gray-900">
              Litrato{' '}
              {outcome !== null && photoRequired(outcome) ? (
                <span className="text-red-600">(kailangan)</span>
              ) : (
                <span className="font-normal text-gray-400">(opsyonal)</span>
              )}
            </h2>
            <button
              type="button"
              onClick={() => setStep({ kind: 'photo', fix: step.fix, gate: step.gate })}
              className="mt-2 h-14 w-full rounded-xl border-2 border-gray-300 bg-white text-base font-semibold text-gray-700"
            >
              {photo === null ? 'Kumuha ng litrato' : 'May litrato ✓ — kunan ulit'}
            </button>
          </section>

          {showBlockers && blockers.length > 0 && (
            <ul className="space-y-1 rounded-2xl bg-red-50 p-4">
              {blockers.map((b) => (
                <li key={b} className="text-sm font-medium text-red-800">
                  • {BLOCKER_COPY[b] ?? b}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => void save()}
            className="h-16 w-full rounded-2xl bg-emerald-600 text-xl font-bold text-white active:bg-emerald-700"
          >
            I-SAVE ANG VISIT
          </button>
        </div>
      )}

      {step.kind === 'saving' && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-base font-medium text-gray-700">Sine-save…</p>
        </div>
      )}
    </main>
  );
}
