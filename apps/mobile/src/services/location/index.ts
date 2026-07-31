// Public entry point of the location service. UI code imports ONLY from here.

import { createProbePermissionCheck } from './permission.ts';
import { createLocationService } from './service.ts';
import { getOpenSessionLocal } from './openSession.ts';
import { persistPingToBuffer } from './pingBuffer.ts';
import { batteryPort, geolocationPort, sleep, uptimeMs } from './plugins.ts';

export type {
  CaptureOptions,
  CapturePurpose,
  IntegrityEvent,
  LocalPing,
  LocationRejection,
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
export { drainPingBuffer, peekPingBuffer } from './pingBuffer.ts';

export const locationService = createLocationService({
  geolocation: geolocationPort,
  battery: batteryPort,
  checkPermission: createProbePermissionCheck(geolocationPort, sleep),
  getOpenSession: getOpenSessionLocal,
  persistPing: persistPingToBuffer,
  now: () => Date.now(),
  uptimeMs,
  sleep,
  randomUUID: () => crypto.randomUUID(),
});

export const {
  captureVerifiedFix,
  startIntervalTracking,
  stopIntervalTracking,
  rearmTrackingIfSessionOpen,
} = locationService;
