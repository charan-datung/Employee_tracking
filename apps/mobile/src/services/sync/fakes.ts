// Test doubles for the sync engine. The in-memory outbox mirrors the SQL
// store's semantics (including backoff filtering) so the worker's behavior is
// exercised for real.
import { backoffDelayMs } from './worker.ts';
import type {
  EntityType,
  FlagReport,
  OutboxRow,
  OutboxStore,
  PhotoUploaderPort,
  PushOutcome,
  ServerPort,
  SyncStatus,
  SyncWorkerDeps,
} from './types.ts';

export class InMemoryOutbox implements OutboxStore {
  rows: OutboxRow[] = [];
  private seq = 0;

  add(partial: {
    entityType: EntityType;
    entityLocalId: string;
    sessionId?: string | null;
    dependsPhotoId?: string | null;
    payload?: Record<string, unknown>;
    createdAtDevice: number;
    status?: OutboxRow['status'];
    attemptCount?: number;
    lastAttemptAt?: number | null;
  }): OutboxRow {
    this.seq += 1;
    const row: OutboxRow = {
      id: `ob-${this.seq}`,
      entity_type: partial.entityType,
      entity_local_id: partial.entityLocalId,
      session_id: partial.sessionId ?? null,
      depends_photo_id: partial.dependsPhotoId ?? null,
      payload: partial.payload ?? { id: partial.entityLocalId },
      created_at_device: partial.createdAtDevice,
      attempt_count: partial.attemptCount ?? 0,
      last_attempt_at: partial.lastAttemptAt ?? null,
      last_error: null,
      status: partial.status ?? 'queued',
    };
    this.rows.push(row);
    return row;
  }

  byLocalId(entityLocalId: string): OutboxRow | undefined {
    return this.rows.find((r) => r.entity_local_id === entityLocalId);
  }

  async listDue(nowMs: number, limit: number): Promise<OutboxRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.status === 'queued' &&
          (r.last_attempt_at === null ||
            r.last_attempt_at + backoffDelayMs(r.attempt_count) <= nowMs),
      )
      .sort((a, b) => a.created_at_device - b.created_at_device)
      .slice(0, limit)
      .map((r) => ({ ...r, payload: { ...r.payload } }));
  }

  async hasUnresolved(entityType: EntityType, entityLocalId: string): Promise<boolean> {
    return this.rows.some(
      (r) =>
        r.entity_type === entityType &&
        r.entity_local_id === entityLocalId &&
        (r.status === 'queued' ||
          r.status === 'in_flight' ||
          r.status === 'failed_permanent'),
    );
  }

  async hasPendingForSession(sessionId: string, types: EntityType[]): Promise<boolean> {
    return this.rows.some(
      (r) =>
        r.session_id === sessionId &&
        types.includes(r.entity_type) &&
        (r.status === 'queued' || r.status === 'in_flight'),
    );
  }

  async markInFlight(ids: string[]): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id)) row.status = 'in_flight';
    }
  }

  async markAcked(ids: string[], atMs: number): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id)) {
        row.status = 'acked';
        row.last_attempt_at = atMs;
        row.last_error = null;
      }
    }
  }

  async markFailed(
    id: string,
    error: string,
    opts: { permanent: boolean; atMs: number },
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return;
    row.status = opts.permanent ? 'failed_permanent' : 'queued';
    row.attempt_count += 1;
    row.last_attempt_at = opts.atMs;
    row.last_error = error;
  }

  async resetInFlight(): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (row.status === 'in_flight') {
        row.status = 'queued';
        n += 1;
      }
    }
    return n;
  }

  async stats() {
    const queued = this.rows.filter((r) => r.status === 'queued');
    return {
      queued: queued.length,
      inFlight: this.rows.filter((r) => r.status === 'in_flight').length,
      failedPermanent: this.rows.filter((r) => r.status === 'failed_permanent')
        .length,
      oldestQueuedCreatedAt:
        queued.length === 0
          ? null
          : Math.min(...queued.map((r) => r.created_at_device)),
    };
  }
}

export class FakeServer implements ServerPort {
  pushes: { entityType: EntityType; payloads: Record<string, unknown>[] }[] = [];
  /** Records inserted server-side, deduped by id — models ON CONFLICT DO NOTHING. */
  storedIds = new Set<string>();
  scriptedBatch: PushOutcome[] = [];
  scriptedOne: PushOutcome[] = [];
  refreshResults: boolean[] = [];
  refreshCalls = 0;
  serverOffsetMs = 0;
  reachable = true;
  deviceClock: { value: number };

  constructor(deviceClock: { value: number }) {
    this.deviceClock = deviceClock;
  }

  async serverNowMs(): Promise<number | null> {
    return this.reachable ? this.deviceClock.value + this.serverOffsetMs : null;
  }

  private record(entityType: EntityType, payloads: Record<string, unknown>[]): void {
    this.pushes.push({ entityType, payloads });
    for (const p of payloads) {
      const id = p['id'];
      if (typeof id === 'string') this.storedIds.add(`${entityType}:${id}`);
    }
  }

  async pushBatch(
    entityType: EntityType,
    payloads: Record<string, unknown>[],
  ): Promise<PushOutcome> {
    const scripted = this.scriptedBatch.shift();
    if (scripted !== undefined && scripted.kind !== 'ok') {
      this.pushes.push({ entityType, payloads });
      return scripted;
    }
    this.record(entityType, payloads);
    return { kind: 'ok' };
  }

  async pushOne(
    entityType: EntityType,
    payload: Record<string, unknown>,
  ): Promise<PushOutcome> {
    const scripted = this.scriptedOne.shift();
    if (scripted !== undefined && scripted.kind !== 'ok') {
      this.pushes.push({ entityType, payloads: [payload] });
      return scripted;
    }
    this.record(entityType, [payload]);
    return { kind: 'ok' };
  }

  async refreshAuth(): Promise<boolean> {
    this.refreshCalls += 1;
    return this.refreshResults.shift() ?? true;
  }
}

export class FakePhotos implements PhotoUploaderPort {
  uploads: string[] = [];
  scripted: PushOutcome[] = [];

  async upload(photoLocalId: string): Promise<PushOutcome> {
    const scripted = this.scripted.shift();
    if (scripted !== undefined && scripted.kind !== 'ok') return scripted;
    this.uploads.push(photoLocalId);
    return { kind: 'ok' };
  }
}

export interface SyncHarness {
  deps: SyncWorkerDeps;
  outbox: InMemoryOutbox;
  server: FakeServer;
  photos: FakePhotos;
  clock: { value: number };
  online: { value: boolean };
  flags: FlagReport[];
  statuses: SyncStatus[];
  meta: Map<string, string>;
  dbBytes: { value: number };
  agentLoggedIn: { value: boolean };
}

export function makeSyncHarness(): SyncHarness {
  const outbox = new InMemoryOutbox();
  const clock = { value: 1_722_400_000_000 };
  const server = new FakeServer(clock);
  const photos = new FakePhotos();
  const online = { value: true };
  const flags: FlagReport[] = [];
  const statuses: SyncStatus[] = [];
  const meta = new Map<string, string>();
  const dbBytes = { value: 1_000_000 };
  const agentLoggedIn = { value: true };
  const deps: SyncWorkerDeps = {
    outbox,
    server,
    photos,
    clock: { nowMs: () => clock.value },
    isOnline: () => online.value,
    reportFlag: async (report) => {
      if (!agentLoggedIn.value) return false;
      flags.push(report);
      // Mirror the real wiring: the flag itself becomes an outbox row.
      outbox.add({
        entityType: 'flag',
        entityLocalId: `flag-${flags.length}`,
        sessionId: report.session_id,
        createdAtDevice: clock.value,
        payload: { id: `flag-${flags.length}`, ...report },
      });
      return true;
    },
    dbSizeBytes: async () => dbBytes.value,
    publishStatus: (status) => statuses.push(status),
    getMeta: async (key) => meta.get(key) ?? null,
    setMeta: async (key, value) => {
      meta.set(key, value);
    },
  };
  return { deps, outbox, server, photos, clock, online, flags, statuses, meta, dbBytes, agentLoggedIn };
}

export function lastStatus(h: SyncHarness): SyncStatus {
  const status = h.statuses[h.statuses.length - 1];
  if (status === undefined) throw new Error('no status published');
  return status;
}
