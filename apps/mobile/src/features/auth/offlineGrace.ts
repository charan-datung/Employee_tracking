import { OFFLINE_GRACE_HOURS } from '@datung/shared';

// Offline grace: how long the app keeps working on the cached profile after
// token refresh last succeeded online. Measured against the device clock —
// an agent CAN rewind the clock to stretch this, which is why it is a UX
// guard only: the server never accepts an expired token, so nothing synced
// under a stretched grace period is trusted anyway. A rewound clock (negative
// elapsed) is treated as within grace; clock_skew detection flags it
// server-side on next contact.
export function isWithinOfflineGrace(
  lastOnlineAuthAtMs: number,
  nowMs: number,
): boolean {
  const elapsedMs = nowMs - lastOnlineAuthAtMs;
  return elapsedMs <= OFFLINE_GRACE_HOURS * 60 * 60 * 1000;
}
