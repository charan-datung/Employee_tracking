// Test doubles for the location service. Not a .test file — imported by the
// suites, never picked up by the runner.
import type { LocationServiceDeps } from './service.ts';
import type {
  GeoSample,
  GeolocationPort,
  IntegrityEvent,
  LocalPing,
  WatcherError,
  WatcherOptions,
} from './types.ts';

export type WatcherCallback = (
  location?: GeoSample,
  error?: WatcherError,
) => void;

export class FakeGeolocation implements GeolocationPort {
  addWatcherOptions: WatcherOptions[] = [];
  removedIds: string[] = [];
  active = new Map<string, WatcherCallback>();
  onAddWatcher:
    | ((options: WatcherOptions, cb: WatcherCallback, id: string) => void)
    | null = null;
  failNextAddWatcher = false;
  private nextId = 0;

  async addWatcher(
    options: WatcherOptions,
    callback: WatcherCallback,
  ): Promise<string> {
    if (this.failNextAddWatcher) {
      this.failNextAddWatcher = false;
      throw new Error('native watcher failure');
    }
    this.addWatcherOptions.push(options);
    this.nextId += 1;
    const id = `w${this.nextId}`;
    this.active.set(id, callback);
    this.onAddWatcher?.(options, callback, id);
    return id;
  }

  async removeWatcher({ id }: { id: string }): Promise<void> {
    this.removedIds.push(id);
    this.active.delete(id);
  }

  lastCallback(): WatcherCallback {
    const callbacks = [...this.active.values()];
    const cb = callbacks[callbacks.length - 1];
    if (cb === undefined) throw new Error('no active watcher');
    return cb;
  }
}

export function sample(overrides: Partial<GeoSample> = {}): GeoSample {
  return {
    latitude: 14.45,
    longitude: 120.98,
    accuracy: 8,
    altitude: 30.5,
    altitudeAccuracy: 4,
    bearing: 90,
    speed: 0.4,
    time: 1_722_400_000_000,
    simulated: false,
    ...overrides,
  };
}

export interface TestHarness {
  deps: LocationServiceDeps;
  pings: LocalPing[];
  events: IntegrityEvent[];
  clock: { value: number };
}

export function makeHarness(
  geo: FakeGeolocation,
  overrides: Partial<LocationServiceDeps> = {},
): TestHarness {
  const pings: LocalPing[] = [];
  const events: IntegrityEvent[] = [];
  const clock = { value: 1_722_400_000_000 };
  let uuid = 0;
  const deps: LocationServiceDeps = {
    geolocation: geo,
    battery: {
      getBatteryInfo: async () => ({ batteryLevel: 0.8, isCharging: false }),
    },
    checkPermission: async () => 'granted',
    getOpenSession: async () => null,
    persistPing: async (ping) => {
      pings.push(ping);
    },
    now: () => clock.value,
    uptimeMs: () => 123_456,
    // Default: the timeout never fires — captures end via sampleCount.
    sleep: () => new Promise<void>(() => undefined),
    randomUUID: () => {
      uuid += 1;
      return `uuid-${uuid}`;
    },
    onIntegrityEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { deps, pings, events, clock };
}

// A sleep that resolves immediately: the capture hits its timeout branch.
export const instantTimeout = async (): Promise<void> => undefined;
