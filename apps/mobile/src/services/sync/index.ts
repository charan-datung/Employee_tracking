// Public entry point of the sync engine. UI and feature code import ONLY
// from here (and useSyncStatus/SyncStatusPill).

import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { z } from 'zod';
import { STORAGE_BUCKET_PHOTOS } from '@datung/shared';
import { env } from '../../lib/env';
import { kvStore } from '../../lib/kvStore';
import { sqlPort } from './db.ts';
import { createSqliteOutbox } from './store.ts';
import { createSyncWorker } from './worker.ts';
import { serverPort } from './server.ts';
import { createPhotoStore } from './photos.ts';
import { createTusUploader } from './tus.ts';
import { createSyncApi } from './api.ts';
import { syncStatusStore } from './statusStore.ts';
import { supabase } from '../../lib/supabaseClient';
import type { FlagReport } from './types.ts';

export { useSyncStatus } from './useSyncStatus.ts';
export { SyncStatusPill, STALE_PENDING_MINUTES } from './SyncStatusPill.tsx';
export type { SyncStatus } from './types.ts';
export type { SavedPhoto } from './photos.ts';
export type {
  SessionCloseInput,
  SessionOpenInput,
  VisitInput,
} from './api.ts';

const SYNC_INTERVAL_MS = 60_000;
const ACKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const now = (): number => Date.now();
const randomUUID = (): string => crypto.randomUUID();

const outboxBundle = createSqliteOutbox(sqlPort, randomUUID);
const photoStore = createPhotoStore(sqlPort, { randomUUID, now });
const tus = createTusUploader({
  fetchFn: (...args) => fetch(...args),
  getAccessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  storageUrl: `${env.VITE_SUPABASE_URL}/storage/v1`,
  bucket: STORAGE_BUCKET_PHOTOS,
});

let online = true;

// Self-reported flags need the agent id; read it from the auth cache written
// by AuthProvider (validated — storage is a boundary).
const cachedAgentSchema = z.object({ agent: z.object({ id: z.uuid() }) });
async function currentAgentId(): Promise<string | null> {
  const raw = await kvStore.get('datung.auth.profile');
  if (raw === null) return null;
  try {
    return cachedAgentSchema.parse(JSON.parse(raw)).agent.id;
  } catch {
    return null;
  }
}

async function reportFlag(report: FlagReport): Promise<boolean> {
  const agentId = await currentAgentId();
  if (agentId === null) return false;
  const flagId = randomUUID();
  await outboxBundle.enqueue({
    entityType: 'flag',
    entityLocalId: flagId,
    sessionId: report.session_id,
    dependsPhotoId: null,
    createdAtDevice: now(),
    payload: {
      id: flagId,
      agent_id: agentId,
      session_id: report.session_id,
      flag_type: report.flag_type,
      severity: report.severity,
      detail: report.detail,
    },
  });
  return true;
}

const worker = createSyncWorker({
  outbox: outboxBundle.store,
  server: serverPort,
  photos: photoStore.createUploader(tus),
  clock: { nowMs: now },
  isOnline: () => online,
  reportFlag,
  dbSizeBytes: () => sqlPort.dbSizeBytes(),
  publishStatus: (status) => syncStatusStore.set(status),
  getMeta: outboxBundle.getMeta,
  setMeta: outboxBundle.setMeta,
});

export const syncApi = createSyncApi({ enqueue: outboxBundle.enqueue, now });
export const { savePhotoLocal } = photoStore;
export const reportIntegrityFlag = reportFlag;

let started = false;

// Sync triggers (task rule 3): app resume, connectivity restore, and every
// 60s while online. Idempotent — AuthProvider calls it whenever the app
// reaches the ready phase.
export async function startSyncEngine(): Promise<void> {
  if (started) {
    void worker.runOnce();
    return;
  }
  started = true;

  await worker.init(); // crash recovery: in_flight -> queued
  void outboxBundle.pruneAcked(now() - ACKED_RETENTION_MS);

  online = (await Network.getStatus()).connected;
  void Network.addListener('networkStatusChange', (status) => {
    const wasOnline = online;
    online = status.connected;
    void worker.publish();
    if (!wasOnline && status.connected) void worker.runOnce();
  });

  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) void worker.runOnce();
  });

  setInterval(() => {
    if (online) void worker.runOnce();
  }, SYNC_INTERVAL_MS);

  void worker.runOnce();
}
