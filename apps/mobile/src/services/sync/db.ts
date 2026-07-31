import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';

// SQLite connection lifecycle. The @capacitor-community/sqlite plugin makes
// it easy to leak connections; the rules encoded here:
//   * ONE connection, opened once, memoized behind a single promise —
//     concurrent callers share the same open attempt.
//   * checkConnectionsConsistency + isConnection + retrieveConnection guard
//     against the "connection already exists" error after a WebView reload
//     (the JS side forgets, the native side remembers).
//   * On web, initWebStore MUST complete before createConnection, and writes
//     are flushed with saveToStore (jeep-sqlite keeps the DB in wasm memory).

const DB_NAME = 'datung_field';

export interface SqlPort {
  run(statement: string, values?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<T[]>;
  /** All statements in ONE transaction — used for mirror-row + outbox pairs. */
  runSet(set: { statement: string; values: unknown[] }[]): Promise<void>;
  dbSizeBytes(): Promise<number | null>;
}

const sqlite = new SQLiteConnection(CapacitorSQLite);
const isWeb = Capacitor.getPlatform() === 'web';

async function ensureWebStore(): Promise<void> {
  // Browser dev (`npm run dev`): the plugin's web implementation lives in the
  // jeep-sqlite custom element backed by sql.js wasm. The wasm file must be
  // served at /assets/sql-wasm.wasm — the copy:sqlwasm npm script puts it
  // there (gitignored; dev-only, native builds use real SQLite).
  const jeepLoader = await import('jeep-sqlite/loader');
  jeepLoader.defineCustomElements(window);
  if (document.querySelector('jeep-sqlite') === null) {
    document.body.appendChild(document.createElement('jeep-sqlite'));
  }
  await customElements.whenDefined('jeep-sqlite');
  await sqlite.initWebStore();
}

async function openConnection(): Promise<SQLiteDBConnection> {
  if (isWeb) await ensureWebStore();

  // Recover a native-side connection the JS side has forgotten about.
  const consistency = await sqlite.checkConnectionsConsistency();
  const existing = (await sqlite.isConnection(DB_NAME, false)).result === true;
  const db =
    consistency.result === true && existing
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await migrate(db);
  return db;
}

let connectionPromise: Promise<SQLiteDBConnection> | null = null;

function getDb(): Promise<SQLiteDBConnection> {
  connectionPromise ??= openConnection().catch((error: unknown) => {
    connectionPromise = null; // allow a retry after a failed open
    throw error;
  });
  return connectionPromise;
}

// ---------------------------------------------------------------------------
// Schema. Local tables mirror the server's client-writable columns, plus the
// outbox and bookkeeping. Versioned via PRAGMA user_version.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
create table if not exists attendance_sessions_local (
  id text primary key,
  agent_id text not null,
  device_id text not null,
  opened_at_device integer not null,
  open_lat real not null,
  open_lng real not null,
  open_accuracy_m real not null,
  open_is_mocked integer not null,
  open_photo_local_id text,
  open_photo_sha256 text,
  open_branch_id text not null,
  open_device_uptime_ms integer,
  closed_at_device integer,
  close_lat real,
  close_lng real,
  close_accuracy_m real,
  close_is_mocked integer,
  close_photo_local_id text,
  close_photo_sha256 text,
  close_device_uptime_ms integer,
  status text not null default 'open',
  created_at_device integer not null
);
create table if not exists visits_local (
  id text primary key,
  session_id text not null,
  agent_id text not null,
  client_id text not null,
  arrived_at_device integer not null,
  arrive_lat real not null,
  arrive_lng real not null,
  arrive_accuracy_m real not null,
  arrive_is_mocked integer not null,
  arrive_device_uptime_ms integer,
  departed_at_device integer,
  depart_lat real,
  depart_lng real,
  outcome text,
  outcome_notes text,
  geofence_miss_reason text,
  photo_local_id text,
  photo_sha256 text,
  created_at_device integer not null
);
create table if not exists location_pings_local (
  id text primary key,
  session_id text not null,
  agent_id text not null,
  captured_at_device integer not null,
  device_uptime_ms integer,
  lat real not null,
  lng real not null,
  accuracy_m real not null,
  altitude_m real,
  altitude_accuracy_m real,
  speed_mps real,
  bearing real,
  is_mocked integer not null,
  battery_pct integer,
  is_charging integer,
  source text not null,
  created_at_device integer not null
);
create table if not exists photos_local (
  id text primary key,
  kind text not null,
  file_path text not null,
  sha256 text not null,
  byte_size integer not null,
  storage_object_path text not null,
  content_type text not null default 'image/jpeg',
  upload_url text,
  uploaded integer not null default 0,
  created_at_device integer not null
);
create table if not exists outbox (
  id text primary key,
  entity_type text not null,
  entity_local_id text not null,
  session_id text,
  depends_photo_id text,
  payload_json text not null,
  created_at_device integer not null,
  attempt_count integer not null default 0,
  last_attempt_at integer,
  last_error text,
  status text not null default 'queued',
  unique (entity_type, entity_local_id)
);
create index if not exists outbox_status_created_idx on outbox (status, created_at_device);
create index if not exists outbox_session_idx on outbox (session_id);
create table if not exists meta (
  key text primary key,
  value text not null
);
`;

async function migrate(db: SQLiteDBConnection): Promise<void> {
  const res = await db.query('PRAGMA user_version;');
  const row = res.values?.[0] as { user_version?: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await db.execute(SCHEMA_V1, true);
    await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION};`, false);
    if (isWeb) await sqlite.saveToStore(DB_NAME);
  }
}

export const sqlPort: SqlPort = {
  async run(statement, values = []) {
    const db = await getDb();
    await db.run(statement, values as never[]);
    if (isWeb) await sqlite.saveToStore(DB_NAME);
  },
  async query<T>(statement: string, values: unknown[] = []) {
    const db = await getDb();
    const res = await db.query(statement, values as never[]);
    return (res.values ?? []) as T[];
  },
  async runSet(set) {
    const db = await getDb();
    await db.executeSet(
      set.map((s) => ({ statement: s.statement, values: s.values as never[] })),
      true, // one transaction
    );
    if (isWeb) await sqlite.saveToStore(DB_NAME);
  },
  async dbSizeBytes() {
    try {
      const db = await getDb();
      const pages = await db.query('PRAGMA page_count;');
      const size = await db.query('PRAGMA page_size;');
      const pageCount = Number(Object.values(pages.values?.[0] ?? {})[0]);
      const pageSize = Number(Object.values(size.values?.[0] ?? {})[0]);
      return Number.isFinite(pageCount) && Number.isFinite(pageSize)
        ? pageCount * pageSize
        : null;
    } catch {
      return null;
    }
  },
};
