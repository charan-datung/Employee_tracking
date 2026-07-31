import type { SqlPort } from './db.ts';
import type {
  EntityType,
  OutboxRow,
  OutboxStats,
  OutboxStore,
} from './types.ts';
import { backoffDelayMs } from './worker.ts';

// SQLite-backed OutboxStore + the enqueue API the feature code calls.
// RULE 1: every write hits SQLite first and returns as soon as the local
// transaction commits. Nothing in this module touches the network.

interface OutboxSqlRow {
  id: string;
  entity_type: EntityType;
  entity_local_id: string;
  session_id: string | null;
  depends_photo_id: string | null;
  payload_json: string;
  created_at_device: number;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  status: OutboxRow['status'];
}

function toRow(sql: OutboxSqlRow): OutboxRow {
  return {
    ...sql,
    payload: JSON.parse(sql.payload_json) as Record<string, unknown>,
  };
}

export interface EnqueueInput {
  entityType: EntityType;
  entityLocalId: string;
  sessionId: string | null;
  dependsPhotoId: string | null;
  payload: Record<string, unknown>;
  createdAtDevice: number;
  /** Extra statements committed in the SAME transaction (the mirror row). */
  mirrorStatements?: { statement: string; values: unknown[] }[];
}

export function createSqliteOutbox(sql: SqlPort, randomUUID: () => string) {
  const store: OutboxStore = {
    async listDue(nowMs, limit) {
      const rows = await sql.query<OutboxSqlRow>(
        `select * from outbox where status = 'queued'
         order by created_at_device asc limit 500`,
      );
      return rows
        .filter(
          (r) =>
            r.last_attempt_at === null ||
            r.last_attempt_at + backoffDelayMs(r.attempt_count) <= nowMs,
        )
        .slice(0, limit)
        .map(toRow);
    },

    async hasUnresolved(entityType, entityLocalId) {
      const rows = await sql.query<{ n: number }>(
        `select count(*) as n from outbox
         where entity_type = ? and entity_local_id = ?
           and status in ('queued', 'in_flight', 'failed_permanent')`,
        [entityType, entityLocalId],
      );
      return (rows[0]?.n ?? 0) > 0;
    },

    async hasPendingForSession(sessionId, types) {
      const placeholders = types.map(() => '?').join(',');
      const rows = await sql.query<{ n: number }>(
        `select count(*) as n from outbox
         where session_id = ? and entity_type in (${placeholders})
           and status in ('queued', 'in_flight')`,
        [sessionId, ...types],
      );
      return (rows[0]?.n ?? 0) > 0;
    },

    async markInFlight(ids) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      await sql.run(
        `update outbox set status = 'in_flight' where id in (${placeholders})`,
        ids,
      );
    },

    async markAcked(ids, atMs) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      await sql.run(
        `update outbox set status = 'acked', last_attempt_at = ?, last_error = null
         where id in (${placeholders})`,
        [atMs, ...ids],
      );
    },

    async markFailed(id, error, opts) {
      await sql.run(
        `update outbox
         set status = ?, attempt_count = attempt_count + 1,
             last_attempt_at = ?, last_error = ?
         where id = ?`,
        [opts.permanent ? 'failed_permanent' : 'queued', opts.atMs, error, id],
      );
    },

    async resetInFlight() {
      const rows = await sql.query<{ n: number }>(
        `select count(*) as n from outbox where status = 'in_flight'`,
      );
      await sql.run(
        `update outbox set status = 'queued' where status = 'in_flight'`,
      );
      return rows[0]?.n ?? 0;
    },

    async stats() {
      const rows = await sql.query<{ status: string; n: number; oldest: number | null }>(
        `select status, count(*) as n, min(created_at_device) as oldest
         from outbox group by status`,
      );
      const stats: OutboxStats = {
        queued: 0,
        inFlight: 0,
        failedPermanent: 0,
        oldestQueuedCreatedAt: null,
      };
      for (const row of rows) {
        if (row.status === 'queued') {
          stats.queued = row.n;
          stats.oldestQueuedCreatedAt = row.oldest;
        } else if (row.status === 'in_flight') {
          stats.inFlight = row.n;
          if (
            row.oldest !== null &&
            (stats.oldestQueuedCreatedAt === null ||
              row.oldest < stats.oldestQueuedCreatedAt)
          ) {
            stats.oldestQueuedCreatedAt = row.oldest;
          }
        } else if (row.status === 'failed_permanent') {
          stats.failedPermanent = row.n;
        }
      }
      return stats;
    },
  };

  // Mirror row + outbox row commit in ONE SQLite transaction; the caller gets
  // control back as soon as the local commit lands (never awaits network).
  async function enqueue(input: EnqueueInput): Promise<void> {
    await sql.runSet([
      ...(input.mirrorStatements ?? []),
      {
        statement: `insert into outbox
          (id, entity_type, entity_local_id, session_id, depends_photo_id,
           payload_json, created_at_device, status)
         values (?, ?, ?, ?, ?, ?, ?, 'queued')`,
        values: [
          randomUUID(),
          input.entityType,
          input.entityLocalId,
          input.sessionId,
          input.dependsPhotoId,
          JSON.stringify(input.payload),
          input.createdAtDevice,
        ],
      },
    ]);
  }

  async function getMeta(key: string): Promise<string | null> {
    const rows = await sql.query<{ value: string }>(
      `select value from meta where key = ?`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async function setMeta(key: string, value: string): Promise<void> {
    await sql.run(
      `insert into meta (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [key, value],
    );
  }

  // Acked rows may be pruned after a retention window — they exist on the
  // server. failed_permanent rows are NEVER deleted (task rule 6).
  async function pruneAcked(olderThanMs: number): Promise<void> {
    await sql.run(
      `delete from outbox where status = 'acked' and last_attempt_at < ?`,
      [olderThanMs],
    );
  }

  return { store, enqueue, getMeta, setMeta, pruneAcked };
}
