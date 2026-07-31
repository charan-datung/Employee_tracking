// Public entry point of the location service. UI code imports ONLY from here.

import { createProbePermissionCheck } from './permission.ts';
import { createLocationService } from './service.ts';
import { getOpenSessionLocal } from './openSession.ts';
import { batteryPort, geolocationPort, sleep, uptimeMs } from './plugins.ts';
import { reportIntegrityFlag, syncApi } from '../sync/index.ts';
import { setLastPosition } from '../../features/clients/lastPosition.ts';

export type {
  CaptureOptions,
  CapturePurpose,
  IntegrityEvent,
  LocalPing,
  LocationRejection,
  PermissionState,
  RejectionReason,
  VerifiedFix,
} from './types.ts';
export {
  NoOpenSessionError,
  TRACKING_NOTIFICATION_MESSAGE,
  TRACKING_NOTIFICATION_TITLE,
} from './service.ts';
export {
  clearOpenSessionLocal,
  getOpenSessionLocal,
  setOpenSessionLocal,
} from './openSession.ts';

export const checkLocationPermission = createProbePermissionCheck(
  geolocationPort,
  sleep,
);

export const locationService = createLocationService({
  geolocation: geolocationPort,
  battery: batteryPort,
  checkPermission: checkLocationPermission,
  getOpenSession: getOpenSessionLocal,
  // Pings go straight into the SQLite outbox (mirror row + outbox row in one
  // transaction); the sync worker drains them per its throttles and ordering.
  persistPing: async (ping) => {
    await syncApi.enqueuePing(ping);
    // Feeds client-list ordering and the offline visit gate. Only ever
    // written from inside an open session (rule 4).
    await setLastPosition(ping.lat, ping.lng, ping.captured_at_device);
  },
  now: () => Date.now(),
  uptimeMs,
  sleep,
  randomUUID: () => crypto.randomUUID(),
  onIntegrityEvent: (event) => {
    // A simulated sample during tracking is never persisted as a ping — but
    // the ATTEMPT is a signal the supervisor needs, so it travels as a flag.
    if (event.type === 'mock_sample_blocked') {
      void reportIntegrityFlag({
        flag_type: 'mock_attempt_blocked',
        severity: 'critical',
        session_id: null,
        detail: { kind: 'mock_sample_during_tracking', at_device: event.at },
      });
    }
    // 'low_accuracy_sample_dropped' and 'tracking_error' are intentionally not
    // flagged per-event: they are normal in a jeepney or a concrete building
    // and would drown the triage queue. The server infers them from the gaps
    // in the trail instead (P9).
  },
});

export const {
  captureVerifiedFix,
  startIntervalTracking,
  stopIntervalTracking,
  rearmTrackingIfSessionOpen,
} = locationService;
