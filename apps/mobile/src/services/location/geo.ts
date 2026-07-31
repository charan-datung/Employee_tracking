// Small geodesic helpers for CLIENT-SIDE OBSERVATIONS ONLY.
//
// CLAUDE.md forbids computing decision distances in JS/TS: every distance a
// decision rests on (distance from branch, distance from client, geofence
// membership) is computed server-side via distance_m() in SQL. The haversine
// below is not that. It exists for two observations that CANNOT be computed
// anywhere else, because the raw samples never leave the device:
//
//   * jitter_m — dispersion between the samples of a single capture
//     (an anti-spoofing signal, judged by the server, never by the client)
//   * ping throttling — "has the device moved ~50m since the last
//     persisted ping" (a sampling-rate decision, not an attendance decision)
//
// If you find yourself importing this to compare an agent's position to a
// branch or client location: stop — that belongs in SQL.

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Max pairwise distance between samples. Real stationary GPS wanders 3-10m;
// exactly 0 across 5 samples is a strong spoof signal (server judges).
export function maxPairwiseDistanceM(
  points: ReadonlyArray<{ latitude: number; longitude: number }>,
): number {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (a === undefined || b === undefined) continue;
      const d = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
      if (d > max) max = d;
    }
  }
  return max;
}

// Population variance. Real GPS accuracy values are noisy; a constant value
// (variance 0) or suspiciously round ones are spoof signals (server judges).
export function populationVariance(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
