// Core types and ports for the location service. This module (and everything
// it imports) is plugin-free so the logic can be tested under plain Node with
// fake ports; the real Capacitor adapters live in plugins.ts / index.ts.

export type CapturePurpose =
  | 'check_in'
  | 'check_out'
  | 'visit_arrive'
  | 'visit_depart';

// Structurally identical to the plugin's Location object
// (@capacitor-community/background-geolocation). `simulated` is true when the
// reading came from software rather than GPS — it is the mock-location flag,
// and the reason this project is a Capacitor app rather than a PWA.
export interface GeoSample {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  bearing: number | null;
  speed: number | null;
  time: number | null;
  simulated: boolean;
}

export interface WatcherError {
  code?: string;
  message: string;
}

export interface WatcherOptions {
  backgroundMessage?: string;
  backgroundTitle?: string;
  requestPermissions?: boolean;
  stale?: boolean;
  distanceFilter?: number;
}

// The plugin exposes a STREAM (addWatcher/removeWatcher) — there is no
// one-shot getter. Every use in this service opens a watcher and MUST remove
// it in a finally block: a leaked watcher is a background service that never
// stops, which violates CLAUDE.md rule 4.
export interface GeolocationPort {
  addWatcher(
    options: WatcherOptions,
    callback: (location?: GeoSample, error?: WatcherError) => void,
  ): Promise<string>;
  removeWatcher(args: { id: string }): Promise<void>;
}

export interface BatteryPort {
  getBatteryInfo(): Promise<{ batteryLevel?: number; isCharging?: boolean }>;
}

export type PermissionState = 'granted' | 'denied' | 'unknown';

export interface OpenSessionRef {
  id: string;
  agentId: string;
}

// Shape matches the location_pings insert columns the client is allowed to
// write (see the RLS column grants).
export interface LocalPing {
  id: string;
  session_id: string;
  agent_id: string;
  captured_at_device: number;
  device_uptime_ms: number | null;
  lat: number;
  lng: number;
  accuracy_m: number;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  speed_mps: number | null;
  bearing: number | null;
  is_mocked: boolean;
  battery_pct: number | null;
  is_charging: boolean | null;
  source: 'foreground' | 'interval' | 'visit_stamp';
}

export type IntegrityEvent =
  // A simulated reading arrived during interval tracking. It is NEVER
  // persisted as a ping (CLAUDE.md rule 5); the sync engine should raise a
  // 'mock_attempt_blocked' integrity flag from this event.
  | { type: 'mock_sample_blocked'; at: number }
  | { type: 'low_accuracy_sample_dropped'; at: number; accuracy_m: number }
  | { type: 'tracking_error'; at: number; message: string };

export interface VerifiedFix {
  ok: true;
  purpose: CapturePurpose;
  lat: number;
  lng: number;
  accuracy_m: number;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  speed_mps: number | null;
  bearing: number | null;
  // Guaranteed false on success (any simulated sample hard-rejects the whole
  // capture) — still persisted with every record, per CLAUDE.md rule 5.
  is_mocked: false;
  sample_count: number;
  // Derived integrity signals — browser-grade heuristics that catch a spoofer
  // who has patched the native `simulated` flag. The client only OBSERVES;
  // rejection on these is the server's decision.
  jitter_m: number;
  accuracy_variance: number;
  null_sensor_count: number;
  captured_at_device: number;
  device_uptime_ms: number | null;
  battery_pct: number | null;
  is_charging: boolean | null;
}

export type RejectionReason =
  | 'permission_denied'
  | 'mocked'
  | 'accuracy_degraded'
  | 'insufficient_samples'
  | 'unavailable';

export interface LocationRejection {
  ok: false;
  purpose: CapturePurpose;
  reason: RejectionReason;
  sample_count: number;
  // Present on 'accuracy_degraded' so the UI can say
  // "Mahina ang GPS (±180m). Lumabas ka muna ng gusali."
  measured_accuracy_m?: number;
}

export interface CaptureOptions {
  purpose: CapturePurpose;
  maxAccuracyM?: number;
  timeoutMs?: number;
  sampleCount?: number;
  // When true, skips the silent pre-check and lets the watcher prompt for
  // permission. The UI sets this ONLY after it has shown its own explanation
  // following a 'permission_denied' rejection — never on a cold call.
  requestPermission?: boolean;
}
