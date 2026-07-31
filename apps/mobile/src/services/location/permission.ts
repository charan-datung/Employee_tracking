import type { GeolocationPort, PermissionState } from './types.ts';

// The plugin has no permission-check API, so we probe: open a watcher with
// requestPermissions FALSE (never prompts) and stale TRUE (a cached location
// arrives instantly when permission is granted).
//
//   * error NOT_AUTHORIZED  -> 'denied'   (plugin errors immediately)
//   * any location arrives  -> 'granted'
//   * silence until timeout -> 'unknown'  (permission granted but no cached
//                                          fix yet — safe to proceed, the
//                                          real watcher settles it)
//
// The probe watcher is removed in a finally block on every path — a leaked
// watcher is a background service that never stops (CLAUDE.md rule 4).
export function createProbePermissionCheck(
  geolocation: GeolocationPort,
  sleep: (ms: number) => Promise<void>,
  probeTimeoutMs = 1500,
): () => Promise<PermissionState> {
  return async () => {
    let watcherId: string | null = null;
    let settle!: (state: PermissionState) => void;
    const settled = new Promise<PermissionState>((resolve) => {
      settle = resolve;
    });
    try {
      watcherId = await geolocation.addWatcher(
        { requestPermissions: false, stale: true },
        (location, error) => {
          if (error !== undefined) {
            settle(error.code === 'NOT_AUTHORIZED' ? 'denied' : 'unknown');
          } else if (location !== undefined) {
            settle('granted');
          }
        },
      );
      return await Promise.race([
        settled,
        sleep(probeTimeoutMs).then((): PermissionState => 'unknown'),
      ]);
    } catch {
      return 'unknown';
    } finally {
      if (watcherId !== null) {
        await geolocation.removeWatcher({ id: watcherId }).catch(() => undefined);
      }
    }
  };
}
