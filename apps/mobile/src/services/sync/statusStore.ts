import type { SyncStatus } from './types.ts';

// Tiny external store for sync status — consumed by useSyncStatus via
// useSyncExternalStore. Plugin-free so worker tests can drive it directly.

const INITIAL: SyncStatus = {
  pending: 0,
  lastSyncedAt: null,
  isOnline: true,
  oldestPendingAgeMinutes: null,
  failedPermanent: 0,
  storagePressure: false,
};

let current: SyncStatus = INITIAL;
const listeners = new Set<() => void>();

export const syncStatusStore = {
  get(): SyncStatus {
    return current;
  },
  set(status: SyncStatus): void {
    current = status;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
