import { INSUFFICIENT_SAMPLES_FLAG_THRESHOLD } from '@datung/shared';
import type { LocationRejection, RejectionReason } from '../../services/location/index.ts';
import type { FlagReport } from '../../services/sync/types.ts';

// What the UI does with a rejected location capture. Pure: no React, no
// plugins — the copy, the retry affordance, and the flag decision are all
// decided here and unit-tested.
//
// THERE IS NO "CONTINUE ANYWAY". The type has no field for it and no branch
// produces one. A rejected fix ends the attempt, every time, for every
// reason (CLAUDE.md rule 5).
export interface RejectionPolicy {
  title: string;
  body: string;
  /** Label for the single available action; null when only cancel remains. */
  retryLabel: string | null;
  /** Pass requestPermission through to the next captureVerifiedFix call. */
  retryWithPermissionRequest: boolean;
  /** Raise this immediately, before the agent can try again. */
  flag: FlagReport | null;
}

export function rejectionPolicy(
  rejection: LocationRejection,
  consecutiveFailures: number,
  sessionId: string | null,
): RejectionPolicy {
  const reason: RejectionReason = rejection.reason;
  switch (reason) {
    case 'mocked':
      return {
        title: 'Naka-block ang check-in.',
        body:
          'May naka-install na fake GPS app. I-off mo muna sa Developer ' +
          'Options bago ka mag-check in. Naipaalam na ito sa supervisor mo.',
        retryLabel: 'Subukan Ulit',
        retryWithPermissionRequest: false,
        // Raised on the FIRST blocked attempt, not after a threshold. A
        // blocked attempt is a signal, not a non-event: it tells the
        // supervisor exactly who to talk to.
        flag: {
          flag_type: 'mock_attempt_blocked',
          severity: 'critical',
          session_id: sessionId,
          detail: {
            kind: 'mock_location_at_capture',
            sample_count: rejection.sample_count,
            purpose: rejection.purpose,
          },
        },
      };

    case 'accuracy_degraded': {
      const metres =
        rejection.measured_accuracy_m === undefined
          ? null
          : Math.round(rejection.measured_accuracy_m);
      return {
        title: 'Mahina ang GPS.',
        body:
          (metres === null
            ? 'Masyadong malabo ang lokasyon. '
            : `Mahina ang GPS (±${metres}m). `) +
          'Lumabas ka muna ng gusali o lumayo sa mataas na pader, tapos ' +
          'subukan ulit.',
        retryLabel: 'Subukan Ulit',
        retryWithPermissionRequest: false,
        flag: null,
      };
    }

    case 'permission_denied':
      return {
        title: 'Kailangan ng location permission.',
        body:
          'Hindi ka makaka-check in kung naka-off ang location. Pindutin ang ' +
          '"Payagan ang Location" at piliin ang Allow (While using the app).',
        retryLabel: 'Payagan ang Location',
        // The next attempt is allowed to prompt: the agent has now been told
        // why, which is the whole reason the first call never prompts.
        retryWithPermissionRequest: true,
        flag: null,
      };

    case 'insufficient_samples':
      return {
        title: 'Hindi maabot ang GPS signal.',
        body:
          'Kulang ang nakuhang signal. Lumabas ka sa bukas na lugar, hintayin ' +
          'ang ilang segundo, tapos subukan ulit.',
        retryLabel: 'Subukan Ulit',
        retryWithPermissionRequest: false,
        flag:
          consecutiveFailures >= INSUFFICIENT_SAMPLES_FLAG_THRESHOLD
            ? {
                flag_type: 'accuracy_degraded',
                severity: 'warn',
                session_id: sessionId,
                detail: {
                  kind: 'repeated_insufficient_samples',
                  consecutive_failures: consecutiveFailures,
                  purpose: rejection.purpose,
                },
              }
            : null,
      };

    case 'unavailable':
      return {
        title: 'Hindi mabuksan ang GPS.',
        body:
          'Siguraduhing naka-on ang Location sa settings ng phone mo, tapos ' +
          'subukan ulit.',
        retryLabel: 'Subukan Ulit',
        retryWithPermissionRequest: false,
        flag: null,
      };
  }
}
