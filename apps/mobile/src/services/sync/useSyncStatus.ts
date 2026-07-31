import { useSyncExternalStore } from 'react';
import { syncStatusStore } from './statusStore.ts';
import type { SyncStatus } from './types.ts';

// Agents must always be able to SEE that they are not syncing — this hook
// feeds the persistent header pill.
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(syncStatusStore.subscribe, syncStatusStore.get);
}
