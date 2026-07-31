import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CLIENTS_SCHEMA_SQL,
  CLIENT_WITH_DISTANCE_SQL,
  LIST_CLIENTS_ALPHABETICAL_SQL,
  LIST_CLIENTS_BY_DISTANCE_SQL,
  REPLACE_CLIENTS_SQL,
  SEARCH_CLIENTS_SQL,
  clientWithDistanceParams,
  listAlphabeticalParams,
  listByDistanceParams,
  searchParams,
  toFtsQuery,
} from './sql.ts';

// These run the REAL statements against real SQLite (node:sqlite, built in —
// no new dependency), so the haversine, the FTS5 table, the window function
// and every parameter position are verified, not assumed.

const VISITS_LOCAL = `
create table if not exists visits_local (
  id text primary key, session_id text, agent_id text, client_id text,
  arrived_at_device integer, outcome text
);`;

interface Row {
  id: string;
  display_name: string;
  distance_m: number | null;
  last_visit_at: number | null;
  last_visit_outcome: string | null;
  geofence_radius_m: number;
}

// Zapote branch area; distances chosen to be checkable by hand.
const HERE = { lat: 14.4512, lng: 120.9822 };

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(CLIENTS_SCHEMA_SQL);
  db.exec(VISITS_LOCAL);
  const ins = db.prepare(REPLACE_CLIENTS_SQL.insertClient);
  const fts = db.prepare(REPLACE_CLIENTS_SQL.insertFts);
  const rows: [string, string, string, string | null, number | null, number | null][] = [
    // id, name, ref, barangay, lat, lng
    ['c1', 'Zapote Fish Dealer', 'ODOO-P-10015', 'Zapote', 14.4553, 120.9768],
    ['c2', 'Pamplona Auto Parts', 'ODOO-P-10011', 'Pamplona Tres', 14.4485, 120.9801],
    ['c3', 'Talon Uno Rice Trading', 'ODOO-P-10009', 'Talon Uno', 14.4325, 120.9945],
    ['c4', 'Peña Sari-Sari Store', 'ODOO-P-99999', 'Almanza', null, null],
  ];
  for (const [id, name, ref, brgy, lat, lng] of rows) {
    ins.run(id, ref, name, 'coco_martin_group', null, brgy, 'Las Piñas', lat, lng, 120, 'approximate', 1, 1);
    fts.run(id, name, ref, brgy);
  }
  return db;
}

test('haversine in SQL matches a known distance', () => {
  const db = makeDb();
  // c2 is ~0.0027 deg south / 0.0021 deg west of HERE -> a few hundred metres.
  const row = db
    .prepare(CLIENT_WITH_DISTANCE_SQL)
    .get(...(clientWithDistanceParams(HERE, 'c2') as [number, number, number, string])) as unknown as Row;
  assert.ok(row.distance_m !== null);
  assert.ok(
    row.distance_m > 300 && row.distance_m < 450,
    `expected ~370m, got ${String(row.distance_m)}`,
  );
});

test('an unpinned client yields NULL distance, never 0', () => {
  const db = makeDb();
  const row = db
    .prepare(CLIENT_WITH_DISTANCE_SQL)
    .get(...(clientWithDistanceParams(HERE, 'c4') as [number, number, number, string])) as unknown as Row;
  assert.equal(row.distance_m, null);
});

test('list sorts by distance ascending with unpinned clients last', () => {
  const db = makeDb();
  const rows = db
    .prepare(LIST_CLIENTS_BY_DISTANCE_SQL)
    .all(...(listByDistanceParams(HERE, 50) as [number, number, number, number])) as unknown as Row[];
  assert.deepEqual(rows.map((r) => r.id), ['c2', 'c1', 'c3', 'c4']);
  const pinned = rows.filter((r) => r.distance_m !== null);
  for (let i = 1; i < pinned.length; i += 1) {
    const prev = pinned[i - 1];
    const cur = pinned[i];
    assert.ok(prev && cur && (prev.distance_m ?? 0) <= (cur.distance_m ?? 0), 'ascending');
  }
  assert.equal(rows[rows.length - 1]?.id, 'c4', 'unpinned last');
});

test('alphabetical fallback works before any position is known', () => {
  const db = makeDb();
  const rows = db
    .prepare(LIST_CLIENTS_ALPHABETICAL_SQL)
    .all(...(listAlphabeticalParams(50) as [number])) as unknown as Row[];
  assert.deepEqual(
    rows.map((r) => r.display_name),
    ['Pamplona Auto Parts', 'Peña Sari-Sari Store', 'Talon Uno Rice Trading', 'Zapote Fish Dealer'],
  );
  assert.equal(rows[0]?.distance_m, null);
});

test('last visit date and outcome join to the newest visit only', () => {
  const db = makeDb();
  const v = db.prepare(
    'insert into visits_local (id, session_id, agent_id, client_id, arrived_at_device, outcome) values (?,?,?,?,?,?)',
  );
  v.run('v1', 's1', 'a1', 'c2', 1_722_000_000_000, 'not_home');
  v.run('v2', 's1', 'a1', 'c2', 1_722_400_000_000, 'contacted_paid'); // newest
  v.run('v3', 's1', 'a1', 'c1', 1_722_100_000_000, 'contacted_promised');
  const rows = db
    .prepare(LIST_CLIENTS_BY_DISTANCE_SQL)
    .all(...(listByDistanceParams(HERE, 50) as [number, number, number, number])) as unknown as Row[];
  const c2 = rows.find((r) => r.id === 'c2');
  assert.equal(c2?.last_visit_outcome, 'contacted_paid');
  assert.equal(c2?.last_visit_at, 1_722_400_000_000);
  assert.equal(rows.find((r) => r.id === 'c4')?.last_visit_at, null);
});

test('FTS finds clients by name prefix and by account ref', () => {
  const db = makeDb();
  const byName = db
    .prepare(SEARCH_CLIENTS_SQL)
    .all(...(searchParams(HERE, toFtsQuery('pamp') ?? '', 20) as [number, number, number, string, number])) as unknown as Row[];
  assert.deepEqual(byName.map((r) => r.id), ['c2']);

  const byRef = db
    .prepare(SEARCH_CLIENTS_SQL)
    .all(...(searchParams(HERE, toFtsQuery('ODOO-P-10009') ?? '', 20) as [number, number, number, string, number])) as unknown as Row[];
  assert.deepEqual(byRef.map((r) => r.id), ['c3']);
});

test('FTS search still returns distance for ordering context', () => {
  const db = makeDb();
  const rows = db
    .prepare(SEARCH_CLIENTS_SQL)
    .all(...(searchParams(HERE, toFtsQuery('zapote') ?? '', 20) as [number, number, number, string, number])) as unknown as Row[];
  assert.equal(rows[0]?.id, 'c1');
  assert.ok((rows[0]?.distance_m ?? 0) > 0);
});

test('search with no known position binds NULLs instead of exploding', () => {
  const db = makeDb();
  const rows = db
    .prepare(SEARCH_CLIENTS_SQL)
    .all(...(searchParams(null, toFtsQuery('rice') ?? '', 20) as [null, null, null, string, number])) as unknown as Row[];
  assert.equal(rows[0]?.id, 'c3');
  assert.equal(rows[0]?.distance_m, null);
});

test('unicode folding finds Peña by typing Pena', () => {
  const db = makeDb();
  const rows = db
    .prepare(SEARCH_CLIENTS_SQL)
    .all(...(searchParams(HERE, toFtsQuery('pena') ?? '', 20) as [number, number, number, string, number])) as unknown as Row[];
  assert.deepEqual(rows.map((r) => r.id), ['c4']);
});

test('punctuation an agent types never breaks the MATCH query', () => {
  const db = makeDb();
  for (const raw of ["Aling Nene's", 'ODOO-P-10009', 'fish - dealer', '"quoted"', 'a OR b']) {
    const q = toFtsQuery(raw);
    assert.ok(q !== null, raw);
    assert.doesNotThrow(() => {
      db.prepare(SEARCH_CLIENTS_SQL).all(
        ...(searchParams(HERE, q, 20) as [number, number, number, string, number]),
      );
    }, `raw input must be safe: ${raw}`);
  }
});

test('toFtsQuery returns null for input with nothing searchable', () => {
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('***'), null);
  assert.equal(toFtsQuery(''), null);
});
