import 'server-only';

// Geocoding for CSV bulk import.
//
// PROVIDER: self-hosted Nominatim (approved 2026-08-03). Chosen because the
// import is repeated bulk geocoding of Cavite subdivision addresses, and:
//   * the PUBLIC Nominatim instance forbids bulk use, so it must be our own;
//   * ODbL lets us STORE the resulting coordinates, which Google's terms do
//     not — and storing pins is the entire point of this system.
//
// Everything sits behind GeocoderPort so swapping providers is one file. Do
// not import a provider SDK anywhere else.
//
// NOMINATIM_URL must point at YOUR instance (e.g. http://nominatim:8080).
// Unset means geocoding is simply unavailable: imports still succeed, rows
// land as 'unverified', and the existing pin-review map handles them by hand.
// That degradation is deliberate — a missing geocoder must never block
// onboarding a client.

export interface GeocodeResult {
  lat: number;
  lng: number;
  confidence: 'exact' | 'approximate';
  displayName: string;
}

export interface GeocoderPort {
  available: boolean;
  geocode(address: string): Promise<GeocodeResult | null>;
}

const NOMINATIM_URL = process.env.NOMINATIM_URL;
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? 'DatungFieldConsole/1.0 (self-hosted)';

// Nominatim asks callers to stay under 1 request/second even self-hosted, and
// a bulk import should not saturate a box the geocoder shares with anything
// else. Requests are serialised with a small delay rather than fired in
// parallel.
const REQUEST_INTERVAL_MS = 1000;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// Nominatim reports how precise a match is; anything coarser than a building
// or street is 'approximate' so the pin-review loop can prioritise it.
function confidenceFrom(cls: string, type: string): 'exact' | 'approximate' {
  if (cls === 'building' || cls === 'place' || type === 'house') return 'exact';
  return 'approximate';
}

export const nominatimGeocoder: GeocoderPort = {
  available: typeof NOMINATIM_URL === 'string' && NOMINATIM_URL.length > 0,

  async geocode(address: string): Promise<GeocodeResult | null> {
    if (!this.available) return null;
    await throttle();
    try {
      const url = new URL('/search', NOMINATIM_URL);
      url.searchParams.set('q', address);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      // Philippines only — a Cavite barangay name matches places worldwide,
      // and an unconstrained result would drop a client pin in Spain.
      url.searchParams.set('countrycodes', 'ph');

      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as {
        lat?: string;
        lon?: string;
        category?: string;
        type?: string;
        display_name?: string;
      }[];
      const first = rows[0];
      if (first?.lat === undefined || first.lon === undefined) return null;

      const lat = Number(first.lat);
      const lng = Number(first.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      return {
        lat,
        lng,
        confidence: confidenceFrom(first.category ?? '', first.type ?? ''),
        displayName: first.display_name ?? address,
      };
    } catch {
      return null;
    }
  },
};
