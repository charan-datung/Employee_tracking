import {
  haversineMeters,
  maxPairwiseDistanceM,
  populationVariance,
  round,
} from './geo.ts';
import type {
  BatteryPort,
  CaptureOptions,
  GeoSample,
  GeolocationPort,
  IntegrityEvent,
  LocalPing,
  LocationRejection,
  OpenSessionRef,
  PermissionState,
  VerifiedFix,
} from './types.ts';

export const DEFAULT_MAX_ACCURACY_M = 50;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_SAMPLE_COUNT = 5;

// Interval tracking. The watcher fires far more often than we persist; these
// throttles keep SQLite from flooding: persist when >=5 minutes have passed
// OR the device moved >=50m since the last persisted ping.
export const PING_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const PING_MIN_DISTANCE_M = 50;
// CLAUDE.md rule 5: readings worse than 100m accuracy are rejected at
// capture. Interval samples beyond this are dropped, never persisted.
export const INTERVAL_MAX_ACCURACY_M = 100;
// Plugin-side filter — cheap noise reduction below the JS throttle.
export const WATCHER_DISTANCE_FILTER_M = 10;

// The foreground-service notification. The text must be HONEST: it says
// plainly that the agent is checked in and location is being tracked. A vague
// or absent notification is both an RA 10173 transparency problem and an
// Android 14 foreground-service policy problem. Do not "soften" this copy.
export const TRACKING_NOTIFICATION_TITLE = 'Datung Field';
export const TRACKING_NOTIFICATION_MESSAGE =
  'Naka-check in ka. Sinusubaybayan ang lokasyon.';

// MODULE INVARIANT (CLAUDE.md rule 4): interval tracking cannot start unless
// an open attendance session exists in local state. This error is that rule's
// technical implementation — treat any sighting of it in production as a bug
// in the caller, never as something to route around.
export class NoOpenSessionError extends Error {
  constructor() {
    super(
      'startIntervalTracking called with no open attendance session. ' +
        'Location is NEVER sampled outside an open session (CLAUDE.md rule 4).',
    );
    this.name = 'NoOpenSessionError';
  }
}

export interface LocationServiceDeps {
  geolocation: GeolocationPort;
  battery: BatteryPort;
  checkPermission(): Promise<PermissionState>;
  getOpenSession(): Promise<OpenSessionRef | null>;
  persistPing(ping: LocalPing): Promise<void>;
  now(): number;
  uptimeMs(): number | null;
  sleep(ms: number): Promise<void>;
  randomUUID(): string;
  onIntegrityEvent?(event: IntegrityEvent): void;
}

export interface LocationService {
  captureVerifiedFix(
    opts: CaptureOptions,
  ): Promise<VerifiedFix | LocationRejection>;
  startIntervalTracking(sessionId: string): Promise<void>;
  stopIntervalTracking(): Promise<void>;
  rearmTrackingIfSessionOpen(): Promise<boolean>;
  isTracking(): boolean;
  /** Awaits all in-flight ping persistence. Used by tests and shutdown. */
  settle(): Promise<void>;
}

export function createLocationService(deps: LocationServiceDeps): LocationService {
  let trackingWatcherId: string | null = null;
  let trackingSessionId: string | null = null;
  let lastPersisted: { atMs: number; lat: number; lng: number } | null = null;
  // Serializes ping handling so throttle decisions never race.
  let trackingQueue: Promise<void> = Promise.resolve();

  async function readBattery(): Promise<{
    battery_pct: number | null;
    is_charging: boolean | null;
  }> {
    try {
      const info = await deps.battery.getBatteryInfo();
      return {
        battery_pct:
          typeof info.batteryLevel === 'number'
            ? Math.min(100, Math.max(0, Math.round(info.batteryLevel * 100)))
            : null,
        is_charging: typeof info.isCharging === 'boolean' ? info.isCharging : null,
      };
    } catch {
      return { battery_pct: null, is_charging: null };
    }
  }

  // -------------------------------------------------------------------------
  // One-shot verified capture.
  //
  // The plugin is a stream — there is no getCurrentPosition — so a one-shot
  // is: open a watcher, collect samples, remove the watcher. Removal happens
  // in a finally block on EVERY path (success, every rejection, thrown
  // exception): a leaked watcher is a background service that never stops
  // (CLAUDE.md rule 4).
  // -------------------------------------------------------------------------
  async function captureVerifiedFix(
    opts: CaptureOptions,
  ): Promise<VerifiedFix | LocationRejection> {
    const purpose = opts.purpose;
    const maxAccuracyM = opts.maxAccuracyM ?? DEFAULT_MAX_ACCURACY_M;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sampleCount = opts.sampleCount ?? DEFAULT_SAMPLE_COUNT;

    const reject = (
      reason: LocationRejection['reason'],
      sampleTotal: number,
      measuredAccuracyM?: number,
    ): LocationRejection => ({
      ok: false,
      purpose,
      reason,
      sample_count: sampleTotal,
      ...(measuredAccuracyM !== undefined
        ? { measured_accuracy_m: measuredAccuracyM }
        : {}),
    });

    // 1. Permission pre-check. If not granted, return the rejection WITHOUT
    // prompting — the UI must explain first, then retry with
    // requestPermission: true.
    if (opts.requestPermission !== true) {
      const permission = await deps.checkPermission();
      if (permission === 'denied') {
        return reject('permission_denied', 0);
      }
    }

    const samples: GeoSample[] = [];
    // Object wrapper: the value is mutated from inside the watcher callback,
    // which TS control-flow analysis cannot see through a plain let.
    const outcome: { failure: 'denied' | 'unavailable' | null } = {
      failure: null,
    };
    let watcherId: string | null = null;
    let settleCollection!: () => void;
    const collectionDone = new Promise<void>((resolve) => {
      settleCollection = resolve;
    });

    try {
      // 2. Foreground one-shot: NO backgroundMessage (that option is what
      // creates the foreground service — see startIntervalTracking).
      watcherId = await deps.geolocation.addWatcher(
        { requestPermissions: true, stale: false },
        (location, error) => {
          if (error !== undefined) {
            outcome.failure = error.code === 'NOT_AUTHORIZED' ? 'denied' : 'unavailable';
            settleCollection();
            return;
          }
          if (location !== undefined) {
            samples.push(location);
            if (samples.length >= sampleCount) settleCollection();
          }
        },
      );
      // 3. Collect up to sampleCount readings or until timeout.
      await Promise.race([collectionDone, deps.sleep(timeoutMs)]);
    } catch {
      outcome.failure = 'unavailable';
    } finally {
      if (watcherId !== null) {
        await deps.geolocation.removeWatcher({ id: watcherId }).catch(() => undefined);
      }
    }

    if (outcome.failure === 'denied') return reject('permission_denied', samples.length);

    // 4. HARD REJECT on ANY simulated sample. No averaging around it, no
    // "best non-simulated sample" — one simulated sample poisons the whole
    // capture. Checked before every other evaluation.
    if (samples.some((s) => s.simulated)) {
      return reject('mocked', samples.length);
    }

    if (outcome.failure === 'unavailable') return reject('unavailable', samples.length);

    // 6. Fewer than 2 samples gives no jitter signal.
    if (samples.length < 2) {
      return reject('insufficient_samples', samples.length);
    }

    // 5. Judge accuracy on the BEST sample; reject with the measured value so
    // the UI can render "Mahina ang GPS (±Xm). Lumabas ka muna ng gusali."
    const best = samples.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
    if (best.accuracy > maxAccuracyM) {
      return reject('accuracy_degraded', samples.length, round(best.accuracy, 1));
    }

    // 7. Derived integrity signals. Observed here, judged by the server.
    const jitterM = round(maxPairwiseDistanceM(samples), 2);
    const accuracyVariance = round(
      populationVariance(samples.map((s) => s.accuracy)),
      3,
    );
    // A sensor counts as null only when NO sample populated it — that is the
    // spoofer signature (most return null for all three, in every sample).
    const nullSensorCount = (['altitude', 'speed', 'bearing'] as const).filter(
      (field) => samples.every((s) => s[field] === null),
    ).length;

    const battery = await readBattery();

    return {
      ok: true,
      purpose,
      lat: best.latitude,
      lng: best.longitude,
      accuracy_m: round(best.accuracy, 2),
      altitude_m: best.altitude,
      altitude_accuracy_m: best.altitudeAccuracy,
      speed_mps: best.speed,
      bearing: best.bearing,
      is_mocked: false,
      sample_count: samples.length,
      jitter_m: jitterM,
      accuracy_variance: accuracyVariance,
      null_sensor_count: nullSensorCount,
      captured_at_device: deps.now(),
      device_uptime_ms: deps.uptimeMs(),
      ...battery,
    };
  }

  // -------------------------------------------------------------------------
  // Interval tracking (the Android foreground service)
  // -------------------------------------------------------------------------

  async function handleTrackingSample(
    sessionId: string,
    agentId: string,
    sample: GeoSample,
  ): Promise<void> {
    if (trackingSessionId !== sessionId) return; // stopped or superseded

    // Rule 5: simulated readings are rejected at capture — never persisted as
    // pings. The event lets the sync engine raise 'mock_attempt_blocked'.
    if (sample.simulated) {
      deps.onIntegrityEvent?.({ type: 'mock_sample_blocked', at: deps.now() });
      return;
    }
    if (sample.accuracy > INTERVAL_MAX_ACCURACY_M) {
      deps.onIntegrityEvent?.({
        type: 'low_accuracy_sample_dropped',
        at: deps.now(),
        accuracy_m: round(sample.accuracy, 1),
      });
      return;
    }

    const nowMs = deps.now();
    if (lastPersisted !== null) {
      const elapsed = nowMs - lastPersisted.atMs;
      const movedM = haversineMeters(
        lastPersisted.lat,
        lastPersisted.lng,
        sample.latitude,
        sample.longitude,
      );
      if (elapsed < PING_MIN_INTERVAL_MS && movedM < PING_MIN_DISTANCE_M) {
        return; // throttled
      }
    }
    lastPersisted = { atMs: nowMs, lat: sample.latitude, lng: sample.longitude };

    const battery = await readBattery();
    await deps.persistPing({
      id: deps.randomUUID(),
      session_id: sessionId,
      agent_id: agentId,
      captured_at_device: sample.time ?? nowMs,
      device_uptime_ms: deps.uptimeMs(),
      lat: sample.latitude,
      lng: sample.longitude,
      accuracy_m: round(sample.accuracy, 2),
      altitude_m: sample.altitude,
      altitude_accuracy_m: sample.altitudeAccuracy,
      speed_mps: sample.speed,
      bearing: sample.bearing,
      is_mocked: false,
      battery_pct: battery.battery_pct,
      is_charging: battery.is_charging,
      source: 'interval',
    });
  }

  async function startIntervalTracking(sessionId: string): Promise<void> {
    // MODULE INVARIANT — CLAUDE.md rule 4. No open session, no watcher.
    const open = await deps.getOpenSession();
    if (open === null || open.id !== sessionId) {
      throw new NoOpenSessionError();
    }

    if (trackingWatcherId !== null) {
      if (trackingSessionId === sessionId) return; // already armed — no-op
      await stopIntervalTracking();
    }

    lastPersisted = null;
    trackingSessionId = sessionId;
    const agentId = open.agentId;

    trackingWatcherId = await deps.geolocation.addWatcher(
      {
        // backgroundMessage is what creates the Android foreground service
        // and its (honest, effectively non-dismissible) notification.
        backgroundTitle: TRACKING_NOTIFICATION_TITLE,
        backgroundMessage: TRACKING_NOTIFICATION_MESSAGE,
        requestPermissions: true,
        stale: false,
        distanceFilter: WATCHER_DISTANCE_FILTER_M,
      },
      (location, error) => {
        if (error !== undefined) {
          deps.onIntegrityEvent?.({
            type: 'tracking_error',
            at: deps.now(),
            message: error.message,
          });
          return;
        }
        if (location !== undefined) {
          trackingQueue = trackingQueue
            .then(() => handleTrackingSample(sessionId, agentId, location))
            .catch(() => undefined);
        }
      },
    );
  }

  // Called on check-out, on logout, and safe to call when not tracking.
  async function stopIntervalTracking(): Promise<void> {
    const id = trackingWatcherId;
    trackingWatcherId = null;
    trackingSessionId = null;
    lastPersisted = null;
    if (id !== null) {
      await deps.geolocation.removeWatcher({ id }).catch(() => undefined);
    }
  }

  // App-launch hook: if an open session survived a restart, resume the
  // foreground service; otherwise stay silent (rule 4).
  async function rearmTrackingIfSessionOpen(): Promise<boolean> {
    const open = await deps.getOpenSession();
    if (open === null) return false;
    await startIntervalTracking(open.id);
    return true;
  }

  return {
    captureVerifiedFix,
    startIntervalTracking,
    stopIntervalTracking,
    rearmTrackingIfSessionOpen,
    isTracking: () => trackingWatcherId !== null,
    settle: async () => {
      await trackingQueue;
    },
  };
}
