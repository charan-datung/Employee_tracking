import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureVerifiedFix,
  type CapturePurpose,
  type VerifiedFix,
} from '../../services/location/index.ts';
import { reportIntegrityFlag, type SavedPhoto } from '../../services/sync/index.ts';
import { SelfieCaptureView } from '../camera/SelfieCaptureView.tsx';
import { rejectionPolicy, type RejectionPolicy } from './rejectionPolicy.ts';

// The check-in / check-out capture sequence. Both use the same three steps:
//   1. verified location fix   2. selfie   3. local save
//
// SPEED (target: under 25s end-to-end on good signal). Everything that can be
// removed from the critical path has been: the location capture starts on
// mount with no confirmation tap, the selfie view mounts the instant the fix
// lands, and the save step is SQLite + filesystem only — never the network.
// The remaining budget is GPS acquisition (~5-12s for 5 samples), the
// agent's shutter tap, and one confirm tap. Do not add screens here.
//
// Every step is NAMED ON SCREEN while it runs: on 2-bar LTE in Bacoor a
// silent spinner is indistinguishable from a hang, and an agent who thinks
// the app froze will force-quit mid-capture.

export type CaptureStepKind = 'locating' | 'rejected' | 'selfie' | 'saving';

const STEP_LABELS: { key: CaptureStepKind; label: string }[] = [
  { key: 'locating', label: 'Kinukuha ang lokasyon…' },
  { key: 'selfie', label: 'Kunan ng selfie' },
  { key: 'saving', label: 'Sine-save…' },
];

type FlowState =
  | { kind: 'locating' }
  | { kind: 'rejected'; policy: RejectionPolicy; requestPermission: boolean }
  | { kind: 'selfie'; fix: VerifiedFix }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string };

export interface AttendanceCaptureFlowProps {
  purpose: Extract<CapturePurpose, 'check_in' | 'check_out'>;
  title: string;
  agentId: string;
  /** Present for check-out; flags raised during check-in have no session. */
  sessionId: string | null;
  onComplete(fix: VerifiedFix, photo: SavedPhoto): Promise<void>;
  onCancel(): void;
}

export function AttendanceCaptureFlow(props: AttendanceCaptureFlowProps) {
  const [state, setState] = useState<FlowState>({ kind: 'locating' });
  // Consecutive no-fix failures within this attempt sequence. Reset by a
  // successful fix or by leaving the screen — three in a row is the signal.
  const failuresRef = useRef(0);
  const startedRef = useRef(false);

  const locate = useCallback(
    async (requestPermission: boolean) => {
      setState({ kind: 'locating' });
      const result = await captureVerifiedFix({
        purpose: props.purpose,
        ...(requestPermission ? { requestPermission: true } : {}),
      });

      if (result.ok) {
        failuresRef.current = 0;
        setState({ kind: 'selfie', fix: result });
        return;
      }

      failuresRef.current += 1;
      const policy = rejectionPolicy(
        result,
        failuresRef.current,
        props.sessionId,
      );
      // Raised BEFORE the agent can retry: a blocked mock attempt must reach
      // the supervisor even if the agent immediately gives up and walks away.
      if (policy.flag !== null) void reportIntegrityFlag(policy.flag);
      setState({
        kind: 'rejected',
        policy,
        requestPermission: policy.retryWithPermissionRequest,
      });
    },
    [props.purpose, props.sessionId],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void locate(false);
  }, [locate]);

  const onCaptured = useCallback(
    async (photo: SavedPhoto) => {
      if (state.kind !== 'selfie') return;
      const fix = state.fix;
      setState({ kind: 'saving' });
      try {
        await props.onComplete(fix, photo);
      } catch {
        setState({
          kind: 'failed',
          message:
            'Hindi na-save ang record sa phone. Pakisubukan ulit — kung ' +
            'paulit-ulit ito, tawagan ang supervisor mo.',
        });
      }
    },
    [state, props],
  );

  if (state.kind === 'selfie') {
    return (
      <SelfieCaptureView
        title={props.title}
        agentId={props.agentId}
        kind={props.purpose === 'check_in' ? 'check_in' : 'check_out'}
        onCaptured={onCaptured}
        onCancel={props.onCancel}
      />
    );
  }

  const activeStep: CaptureStepKind =
    state.kind === 'saving' ? 'saving' : state.kind === 'locating' ? 'locating' : 'rejected';

  return (
    <main className="fixed inset-0 z-40 flex flex-col bg-white px-6 pb-8 pt-12">
      <header className="flex items-start justify-between">
        <h1 className="text-xl font-bold text-gray-900">{props.title}</h1>
        {state.kind !== 'saving' && (
          <button
            type="button"
            onClick={props.onCancel}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-xl text-gray-600"
            aria-label="Kanselahin"
          >
            ✕
          </button>
        )}
      </header>

      {/* Visible step indicator — poor signal must never look like a hang. */}
      <ol className="mt-8 space-y-3" aria-live="polite">
        {STEP_LABELS.map((step, index) => {
          const activeIndex = STEP_LABELS.findIndex((s) => s.key === activeStep);
          const done = index < activeIndex;
          const current = step.key === activeStep;
          return (
            <li key={step.key} className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  done
                    ? 'bg-emerald-600 text-white'
                    : current
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-gray-100 text-gray-400'
                }`}
              >
                {done ? '✓' : index + 1}
              </span>
              <span
                className={`text-base ${
                  current
                    ? 'font-semibold text-gray-900'
                    : done
                      ? 'text-gray-500'
                      : 'text-gray-400'
                }`}
              >
                {step.label}
              </span>
              {current && state.kind !== 'rejected' && (
                <span className="ml-auto h-4 w-4 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex-1" />

      {state.kind === 'rejected' && (
        <div className="mx-auto w-full max-w-sm">
          <div className="rounded-2xl bg-red-50 p-5">
            <h2 className="text-lg font-bold text-red-800">
              {state.policy.title}
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-red-900">
              {state.policy.body}
            </p>
          </div>
          {/* No "continue anyway" exists here or anywhere else. */}
          {state.policy.retryLabel !== null && (
            <button
              type="button"
              onClick={() => void locate(state.requestPermission)}
              className="mt-4 h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white active:bg-emerald-700"
            >
              {state.policy.retryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={props.onCancel}
            className="mt-3 h-12 w-full rounded-xl text-base font-medium text-gray-500"
          >
            Bumalik
          </button>
        </div>
      )}

      {state.kind === 'failed' && (
        <div className="mx-auto w-full max-w-sm">
          <p className="rounded-2xl bg-red-50 p-5 text-[15px] text-red-900">
            {state.message}
          </p>
          <button
            type="button"
            onClick={props.onCancel}
            className="mt-4 h-14 w-full rounded-xl bg-gray-900 text-lg font-semibold text-white"
          >
            Bumalik
          </button>
        </div>
      )}
    </main>
  );
}
