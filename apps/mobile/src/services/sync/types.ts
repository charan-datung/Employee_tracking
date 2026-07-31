// Core types and ports for the sync engine. Plugin-free (like
// services/location): the worker is pure logic over these ports; the real
// SQLite / fetch / Capacitor adapters live in db.ts, server.ts, photos.ts
// and index.ts, which tests never import.

export type EntityType =
  | 'session_open'
  | 'session_close'
  | 'visit'
  // Departure is a PATCH of an already-inserted visit ("AALIS NA AKO"), so it
  // is its own outbox row that waits for the visit to land first.
  | 'visit_departure'
  | 'ping'
  | 'photo'
  | 'flag';

export type OutboxStatus = 'queued' | 'in_flight' | 'acked' | 'failed_permanent';

export interface OutboxRow {
  id: string;
  entity_type: EntityType;
  entity_local_id: string;
  // Denormalized for dependency checks (ping/visit/session_close rows).
  session_id: string | null;
  // A photo this row's server record references; the row may not sync until
  // the storage object exists (task rule 8).
  depends_photo_id: string | null;
  // The server-shaped payload. device_clock_offset_ms is stamped by the
  // worker at send time, not stored here.
  payload: Record<string, unknown>;
  created_at_device: number;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  status: OutboxStatus;
}

export interface OutboxStats {
  queued: number;
  inFlight: number;
  failedPermanent: number;
  oldestQueuedCreatedAt: number | null;
}

export interface OutboxStore {
  /** Queued rows whose backoff has elapsed, in created_at_device order. */
  listDue(nowMs: number, limit: number): Promise<OutboxRow[]>;
  /** True while a row of this identity is queued, in flight, or permanently
   *  failed — i.e. the server-side record cannot be assumed to exist. */
  hasUnresolved(entityType: EntityType, entityLocalId: string): Promise<boolean>;
  /** Like hasUnresolved but scoped to a session's child rows. Excludes
   *  failed_permanent: a poisoned ping must not block check-out forever
   *  (the anomaly is already surfaced). */
  hasPendingForSession(
    sessionId: string,
    types: EntityType[],
  ): Promise<boolean>;
  markInFlight(ids: string[]): Promise<void>;
  markAcked(ids: string[], atMs: number): Promise<void>;
  markFailed(
    id: string,
    error: string,
    opts: { permanent: boolean; atMs: number },
  ): Promise<void>;
  /** Rows stuck in_flight after a crash/kill go back to queued. */
  resetInFlight(): Promise<number>;
  stats(): Promise<OutboxStats>;
}

// One outcome vocabulary for every server interaction (REST push, photo
// upload). The worker maps it to outbox transitions:
//   ok        -> acked
//   auth      -> refresh token, one retry, else transient
//   conflict  -> transient (409: dependency not landed yet / dup race)
//   transient -> retry with backoff (5xx, network)
//   permanent -> failed_permanent + sync_anomaly (4xx other than 401/409)
export type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'auth' }
  | { kind: 'conflict'; detail: string }
  | { kind: 'transient'; detail: string }
  | { kind: 'permanent'; detail: string };

export interface ServerPort {
  /** Server wall-clock (ms epoch) from a cheap round-trip; null = unreachable. */
  serverNowMs(): Promise<number | null>;
  pushBatch(
    entityType: EntityType,
    payloads: Record<string, unknown>[],
  ): Promise<PushOutcome>;
  pushOne(
    entityType: EntityType,
    payload: Record<string, unknown>,
  ): Promise<PushOutcome>;
  refreshAuth(): Promise<boolean>;
}

export interface PhotoUploaderPort {
  upload(photoLocalId: string): Promise<PushOutcome>;
}

export interface SyncStatus {
  pending: number;
  lastSyncedAt: number | null;
  isOnline: boolean;
  oldestPendingAgeMinutes: number | null;
  failedPermanent: number;
  storagePressure: boolean;
}

export interface FlagReport {
  // Self-incriminating observations only — the exact set the RLS policy
  // flags_insert_self_report admits. Detector verdicts (teleport,
  // impossible_velocity, …) are the server's to raise and are rejected here
  // and at the database.
  flag_type:
    | 'sync_anomaly'
    | 'mock_attempt_blocked'
    | 'permission_revoked'
    | 'accuracy_degraded';
  severity: 'info' | 'warn' | 'critical';
  session_id: string | null;
  detail: Record<string, unknown>;
}

export interface SyncWorkerDeps {
  outbox: OutboxStore;
  server: ServerPort;
  photos: PhotoUploaderPort;
  clock: { nowMs(): number };
  isOnline(): boolean;
  /** Enqueues a self-reported integrity flag as its own outbox row.
   *  Must be a NO-OP (return false) when no agent is logged in. */
  reportFlag(report: FlagReport): Promise<boolean>;
  dbSizeBytes(): Promise<number | null>;
  publishStatus(status: SyncStatus): void;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
