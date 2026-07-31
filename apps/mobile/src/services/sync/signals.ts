import type { VerifiedFix } from '../location/types.ts';
import type { CaptureSignals } from './api.ts';

// Maps a VerifiedFix's derived integrity signals onto the sync payload shape.
// One function so no call site can quietly drop a signal or transpose two of
// them — the server's zero_jitter and null_sensor_fields detectors are only
// as good as what actually arrives.
export function signalsFromFix(fix: VerifiedFix): CaptureSignals {
  return {
    jitterM: fix.jitter_m,
    accuracyVariance: fix.accuracy_variance,
    nullSensorCount: fix.null_sensor_count,
    sampleCount: fix.sample_count,
  };
}
