// Formatting shared across console screens. Times render in Philippine time
// because that is the only timezone anyone reading this board is in.
const MANILA = 'Asia/Manila';

export function timePH(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: MANILA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function dateTimePH(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: MANILA,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function datePH(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: MANILA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function ageMinutes(iso: string | null, nowMs = Date.now()): number | null {
  if (iso === null) return null;
  return Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60000));
}

export function ageLabel(iso: string | null, nowMs = Date.now()): string {
  const minutes = ageMinutes(iso, nowMs);
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

// The device/server delta, rendered with an explicit sign. This is the tell:
// a device clock running minutes fast or slow is the first thing a reviewer
// should see, so it is never rounded away to "a few seconds".
export function signedMs(ms: number | null): string {
  if (ms === null) return '—';
  const sign = ms >= 0 ? '+' : '−';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs} ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)} s`;
  if (abs < 3_600_000) return `${sign}${(abs / 60_000).toFixed(1)} min`;
  return `${sign}${(abs / 3_600_000).toFixed(1)} h`;
}

export const OUTCOME_LABELS: Record<string, string> = {
  contacted_paid: 'Nagbayad',
  contacted_promised: 'Nangako',
  contacted_refused: 'Ayaw magbayad',
  not_home: 'Wala sa bahay',
  wrong_address: 'Maling address',
  closed_business: 'Sarado',
  client_relocated: 'Lumipat',
  other: 'Iba pa',
};

export const OUTCOME_COLORS: Record<string, string> = {
  contacted_paid: '#059669',
  contacted_promised: '#0891b2',
  contacted_refused: '#dc2626',
  not_home: '#f59e0b',
  wrong_address: '#7c3aed',
  closed_business: '#be123c',
  client_relocated: '#9333ea',
  other: '#6b7280',
};

export const FLAG_LABELS: Record<string, string> = {
  mock_location: 'Fake GPS detected',
  mock_attempt_blocked: 'Fake GPS blocked at capture',
  accuracy_degraded: 'Mahinang GPS accuracy',
  impossible_velocity: 'Imposibleng bilis',
  teleport: 'Teleport (biglang lipat)',
  clock_skew: 'Maling oras ng device',
  uptime_regression: 'Binaligtad ang orasan',
  device_mismatch: 'Ibang device',
  duplicate_photo_hash: 'Ulit na litrato',
  ping_gap: 'May putol sa tracking',
  offline_backfill_bulk: 'Malaking offline batch',
  geofence_miss: 'Malayo sa client',
  permission_revoked: 'Na-off ang location permission',
  session_never_closed: 'Hindi nag-check out',
  static_session: 'Hindi gumalaw ang device',
  zero_jitter: 'Walang GPS jitter (spoof signal)',
  null_sensor_fields: 'Walang sensor data',
  motion_contradiction: 'Salungat ang motion sensor',
  sync_anomaly: 'Problema sa sync',
};
