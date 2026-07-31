import { useSyncStatus } from './useSyncStatus.ts';

// Red once the oldest unsynced record is older than this — the agent must
// notice a stuck outbox before the day's evidence is at risk.
export const STALE_PENDING_MINUTES = 4 * 60;

// Persistent header pill. Never hidden while the agent is logged in.
export function SyncStatusPill() {
  const { pending, isOnline, oldestPendingAgeMinutes, storagePressure } =
    useSyncStatus();

  const stale =
    storagePressure ||
    (oldestPendingAgeMinutes !== null &&
      oldestPendingAgeMinutes > STALE_PENDING_MINUTES);

  let text: string;
  if (pending === 0) {
    text = isOnline ? 'Naka-sync ✓' : 'Offline · walang naka-pending';
  } else {
    const hours =
      oldestPendingAgeMinutes !== null && oldestPendingAgeMinutes >= 60
        ? ` · ${Math.floor(oldestPendingAgeMinutes / 60)}h`
        : '';
    text = `${pending} hindi pa na-sync${hours}${isOnline ? '' : ' · offline'}`;
  }

  const tone = stale
    ? 'bg-red-600 text-white'
    : pending > 0
      ? 'bg-amber-100 text-amber-900'
      : 'bg-emerald-100 text-emerald-800';

  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${tone}`}
    >
      {text}
    </span>
  );
}
