import type {
  EntityType,
  OutboxRow,
  PushOutcome,
  SyncStatus,
  SyncWorkerDeps,
} from './types.ts';

export const BATCH_SIZE = 50;
export const CANDIDATE_WINDOW = 200;

// Retry backoff per row: 2s / 8s / 30s / 2m / 10m, capped at 30m.
export const BACKOFF_SCHEDULE_MS = [2_000, 8_000, 30_000, 120_000, 600_000] as const;
export const BACKOFF_CAP_MS = 1_800_000;

export function backoffDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  return BACKOFF_SCHEDULE_MS[attemptCount - 1] ?? BACKOFF_CAP_MS;
}

// Storage pressure thresholds (task rule 7). Crossing either raises a
// blocking in-app warning and a sync_anomaly flag. Unsynced records are NEVER
// auto-purged — an over-full outbox is an ops problem, not a delete trigger.
export const OUTBOX_PRESSURE_ROWS = 5_000;
export const DB_PRESSURE_BYTES = 200 * 1024 * 1024;

// Entity types whose server rows carry device_clock_offset_ms.
const STAMP_OFFSET: ReadonlySet<EntityType> = new Set([
  'session_open',
  'session_close',
  'visit',
  'ping',
]);

const META_LAST_SYNCED_AT = 'last_synced_at';

export interface SyncWorker {
  /** Crash recovery: rows stuck in_flight go back to queued. Call once at
   *  startup BEFORE the first runOnce. */
  init(): Promise<void>;
  /** One drain pass. Serialized: concurrent calls coalesce. */
  runOnce(): Promise<void>;
  /** Recompute + publish status without touching the network. */
  publish(): Promise<void>;
}

export function createSyncWorker(deps: SyncWorkerDeps): SyncWorker {
  let running: Promise<void> | null = null;
  let lastSyncedAt: number | null = null;
  let storagePressure = false;
  let pressureReported = false;

  async function buildStatus(): Promise<SyncStatus> {
    const stats = await deps.outbox.stats();
    const now = deps.clock.nowMs();
    return {
      pending: stats.queued + stats.inFlight,
      lastSyncedAt,
      isOnline: deps.isOnline(),
      oldestPendingAgeMinutes:
        stats.oldestQueuedCreatedAt === null
          ? null
          : Math.max(0, Math.round((now - stats.oldestQueuedCreatedAt) / 60_000)),
      failedPermanent: stats.failedPermanent,
      storagePressure,
    };
  }

  async function publish(): Promise<void> {
    deps.publishStatus(await buildStatus());
  }

  // Dependency ordering (task rule 4) — explicit checks, not ordering luck:
  //   photo, flag       -> no dependencies
  //   session_open      -> its check-in photo uploaded
  //   ping              -> its session_open acked
  //   visit             -> its session_open acked + its photo uploaded
  //   session_close     -> session_open acked + no queued/in-flight ping or
  //                        visit of that session (RLS only accepts child rows
  //                        into an OPEN server session, so children go first)
  //                        + its check-out photo uploaded
  async function isEligible(row: OutboxRow): Promise<boolean> {
    const photoBlocked = async (): Promise<boolean> =>
      row.depends_photo_id !== null &&
      (await deps.outbox.hasUnresolved('photo', row.depends_photo_id));

    switch (row.entity_type) {
      case 'photo':
      case 'flag':
        return true;
      case 'session_open':
        return !(await photoBlocked());
      case 'ping':
        return (
          row.session_id !== null &&
          !(await deps.outbox.hasUnresolved('session_open', row.session_id))
        );
      case 'visit':
        return (
          row.session_id !== null &&
          !(await deps.outbox.hasUnresolved('session_open', row.session_id)) &&
          !(await photoBlocked())
        );
      case 'session_close':
        return (
          row.session_id !== null &&
          !(await deps.outbox.hasUnresolved('session_open', row.session_id)) &&
          !(await deps.outbox.hasPendingForSession(row.session_id, [
            'ping',
            'visit',
          ])) &&
          !(await photoBlocked())
        );
    }
  }

  // Batches of up to 50 in created_at_device order; a chunk holds consecutive
  // rows of one entity type. session_close (PATCH) and photo (upload) go one
  // at a time.
  function chunk(rows: OutboxRow[]): OutboxRow[][] {
    const chunks: OutboxRow[][] = [];
    let current: OutboxRow[] = [];
    for (const row of rows) {
      const single =
        row.entity_type === 'session_close' || row.entity_type === 'photo';
      const head = current[0];
      if (
        head === undefined ||
        head.entity_type !== row.entity_type ||
        single ||
        current.length >= BATCH_SIZE
      ) {
        if (current.length > 0) chunks.push(current);
        current = [row];
      } else {
        current.push(row);
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  function stamp(
    row: OutboxRow,
    clockOffsetMs: number,
  ): Record<string, unknown> {
    // CLOCK TAMPER DETECTION (task rule 5): every record of a batch carries
    // the offset measured against the server on this drain. uptime is already
    // inside the payload, stored at capture time.
    return STAMP_OFFSET.has(row.entity_type)
      ? { ...row.payload, device_clock_offset_ms: clockOffsetMs }
      : row.payload;
  }

  async function failChunk(
    rows: OutboxRow[],
    error: string,
    permanent: boolean,
  ): Promise<void> {
    const at = deps.clock.nowMs();
    for (const row of rows) {
      await deps.outbox.markFailed(row.id, error, { permanent, atMs: at });
    }
  }

  async function reportPermanent(row: OutboxRow, detail: string): Promise<void> {
    // A 4xx other than 401/409 will never succeed on retry. The row is KEPT
    // forever (never dropped silently) and surfaced to the console.
    await deps.reportFlag({
      flag_type: 'sync_anomaly',
      severity: 'critical',
      session_id: row.session_id,
      detail: {
        kind: 'permanent_sync_failure',
        entity_type: row.entity_type,
        entity_local_id: row.entity_local_id,
        error: detail,
      },
    });
  }

  async function pushChunk(
    rows: OutboxRow[],
    clockOffsetMs: number,
    authRetried: { done: boolean },
  ): Promise<void> {
    const head = rows[0];
    if (head === undefined) return;
    await deps.outbox.markInFlight(rows.map((r) => r.id));

    let outcome: PushOutcome;
    if (head.entity_type === 'photo') {
      outcome = await deps.photos.upload(head.entity_local_id);
    } else {
      outcome = await deps.server.pushBatch(
        head.entity_type,
        rows.map((r) => stamp(r, clockOffsetMs)),
      );
    }

    if (outcome.kind === 'auth' && !authRetried.done) {
      // 401 -> refresh token, ONE retry (task rule 6).
      authRetried.done = true;
      const refreshed = await deps.server.refreshAuth();
      if (refreshed) {
        outcome =
          head.entity_type === 'photo'
            ? await deps.photos.upload(head.entity_local_id)
            : await deps.server.pushBatch(
                head.entity_type,
                rows.map((r) => stamp(r, clockOffsetMs)),
              );
      }
    }

    switch (outcome.kind) {
      case 'ok': {
        const at = deps.clock.nowMs();
        await deps.outbox.markAcked(rows.map((r) => r.id), at);
        lastSyncedAt = at;
        await deps.setMeta(META_LAST_SYNCED_AT, String(at));
        return;
      }
      case 'auth':
        await failChunk(rows, '401 unauthorized', false);
        return;
      case 'conflict':
        await failChunk(rows, outcome.detail, false);
        return;
      case 'transient':
        await failChunk(rows, outcome.detail, false);
        return;
      case 'permanent': {
        if (rows.length === 1) {
          const row = rows[0];
          if (row !== undefined) {
            await deps.outbox.markFailed(row.id, outcome.detail, {
              permanent: true,
              atMs: deps.clock.nowMs(),
            });
            await reportPermanent(row, outcome.detail);
          }
          return;
        }
        // A batch is all-or-nothing server-side; isolate the poison row(s) by
        // replaying item-by-item so good rows are not condemned with the bad.
        for (const row of rows) {
          const single = await deps.server.pushOne(
            head.entity_type,
            stamp(row, clockOffsetMs),
          );
          if (single.kind === 'ok') {
            const at = deps.clock.nowMs();
            await deps.outbox.markAcked([row.id], at);
            lastSyncedAt = at;
          } else if (single.kind === 'permanent') {
            await deps.outbox.markFailed(row.id, single.detail, {
              permanent: true,
              atMs: deps.clock.nowMs(),
            });
            await reportPermanent(row, single.detail);
          } else {
            const detail = single.kind === 'auth' ? '401 unauthorized' : single.detail;
            await deps.outbox.markFailed(row.id, detail, {
              permanent: false,
              atMs: deps.clock.nowMs(),
            });
          }
        }
        return;
      }
    }
  }

  async function checkStoragePressure(): Promise<void> {
    const stats = await deps.outbox.stats();
    const backlog = stats.queued + stats.inFlight + stats.failedPermanent;
    const dbBytes = (await deps.dbSizeBytes()) ?? 0;
    const pressured =
      backlog > OUTBOX_PRESSURE_ROWS || dbBytes > DB_PRESSURE_BYTES;
    storagePressure = pressured;
    if (pressured && !pressureReported) {
      pressureReported = await deps.reportFlag({
        flag_type: 'sync_anomaly',
        severity: 'critical',
        session_id: null,
        detail: {
          kind: 'storage_pressure',
          outbox_rows: backlog,
          db_bytes: dbBytes,
        },
      });
    }
    if (!pressured) pressureReported = false;
  }

  async function drain(): Promise<void> {
    // Pressure is checked BEFORE any early return: the agent who has been in
    // airplane mode for days is exactly the one who needs the warning.
    await checkStoragePressure();
    if (!deps.isOnline()) {
      await publish();
      return;
    }
    // Measure the clock offset for this drain on a real round-trip; also
    // doubles as the reachability probe.
    const serverNow = await deps.server.serverNowMs();
    if (serverNow === null) {
      await publish();
      return;
    }
    const clockOffsetMs = serverNow - deps.clock.nowMs();

    const due = await deps.outbox.listDue(deps.clock.nowMs(), CANDIDATE_WINDOW);
    const eligible: OutboxRow[] = [];
    for (const row of due) {
      if (await isEligible(row)) eligible.push(row);
    }

    const authRetried = { done: false };
    for (const rows of chunk(eligible)) {
      if (!deps.isOnline()) break;
      await pushChunk(rows, clockOffsetMs, authRetried);
    }

    await checkStoragePressure();
    await publish();
  }

  return {
    init: async () => {
      await deps.outbox.resetInFlight();
      const stored = await deps.getMeta(META_LAST_SYNCED_AT);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) lastSyncedAt = parsed;
      }
      await publish();
    },
    runOnce: () => {
      // Coalesce: a drain already in progress serves the trigger.
      if (running === null) {
        running = drain().finally(() => {
          running = null;
        });
      }
      return running;
    },
    publish,
  };
}
