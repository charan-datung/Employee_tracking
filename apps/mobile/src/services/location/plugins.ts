import { registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import type { BatteryPort, GeolocationPort } from './types.ts';

// Real-plugin adapters. Tests never import this module — they inject fakes
// into createLocationService instead.

// The plugin ships native code + type definitions only; registration happens
// here (per its documented usage).
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>(
  'BackgroundGeolocation',
);

export const geolocationPort: GeolocationPort = {
  addWatcher: (options, callback) =>
    BackgroundGeolocation.addWatcher(options, callback),
  removeWatcher: (args) => BackgroundGeolocation.removeWatcher(args),
};

export const batteryPort: BatteryPort = {
  getBatteryInfo: () => Device.getBatteryInfo(),
};

// Device uptime stand-in. The schema wants SystemClock.elapsedRealtime() for
// uptime_regression detection, but no installed plugin exposes it.
// performance.now() is the WebView process's monotonic clock: it survives
// wall-clock tampering (the point of the signal) but resets on app restart,
// so the server-side uptime_regression detector must treat restarts as
// expected resets. Replace with a native elapsedRealtime bridge if a tiny
// plugin is ever approved for it.
export function uptimeMs(): number | null {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
