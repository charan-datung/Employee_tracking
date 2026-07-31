// SQL for the offline client book.
//
// DISTANCE IS COMPUTED IN SQL, NOT IN JS/TS (CLAUDE.md: "Never compute
// distance in JS or TS. Not once."). The haversine below runs inside SQLite
// via its built-in math functions. Two reasons it exists on the device at all:
//
//   1. The client list must sort by distance with ZERO connectivity, and the
//      agent's current position never leaves the device.
//   2. The visit gate must decide offline which screen to show.
//
// Neither number is ever stored or sent. arrive_distance_from_client_m and
// is_within_geofence are computed server-side by visits_stamp_arrival_facts()
// from PostGIS, and `authenticated` is not granted those columns — so the
// server's number is the only fact that exists.
//
// Placeholders are positional `?` (what @capacitor-community/sqlite binds).
// The distance expression appears EXACTLY ONCE per statement — ORDER BY uses
// the output alias — so the parameter order stays trivial. Build parameter
// arrays with the exported helpers, never by hand, and note that every
// statement here is executed against real SQLite in sql.test.ts.

export const CLIENTS_SCHEMA_SQL = `
create table if not exists clients_local (
  id text primary key,
  external_ref text,
  display_name text not null,
  account_type text not null,
  address_text text,
  barangay text,
  city text,
  lat real,
  lng real,
  geofence_radius_m integer not null default 120,
  geocode_confidence text not null default 'unverified',
  is_active integer not null default 1,
  synced_at integer not null
);
create index if not exists clients_local_active_idx on clients_local (is_active);
-- Standalone FTS5 (not external-content): the sync is a full replace, so both
-- tables are rewritten in one transaction and cannot drift. unicode61 folds
-- diacritics, which matters for names like Peña.
create virtual table if not exists clients_fts using fts5(
  client_id UNINDEXED,
  display_name,
  external_ref,
  barangay,
  tokenize='unicode61'
);
`;

// Metres from (?lat, ?lng) to a client row — mean-Earth-radius haversine run
// by SQLite. Binding order within this fragment: lat, lat, lng.
// NULL when the client has no pin: unknown distance must read as unknown,
// never as zero.
const DISTANCE_M_EXPR = `
  case
    when c.lat is null or c.lng is null then null
    else 6371008.8 * 2 * asin(min(1.0, sqrt(
      pow(sin(radians(c.lat - ?) / 2), 2) +
      cos(radians(?)) * cos(radians(c.lat)) *
      pow(sin(radians(c.lng - ?) / 2), 2)
    )))
  end
`;

const LAST_VISIT_CTE = `
  last_visit as (
    select client_id, arrived_at_device, outcome,
           row_number() over (
             partition by client_id order by arrived_at_device desc
           ) as rn
    from visits_local
  )
`;

const CLIENT_COLUMNS = `
  c.id, c.external_ref, c.display_name, c.account_type, c.address_text,
  c.barangay, c.city, c.lat, c.lng, c.geofence_radius_m,
  c.geocode_confidence,
  lv.arrived_at_device as last_visit_at,
  lv.outcome as last_visit_outcome
`;

// Distance-ascending, unpinned clients last. Recomputed only when the caller
// supplies a fresh position (pull-to-refresh), never on a timer — continuous
// recomputation costs battery for no benefit.
export const LIST_CLIENTS_BY_DISTANCE_SQL = `
with ${LAST_VISIT_CTE}
select ${CLIENT_COLUMNS}, ${DISTANCE_M_EXPR} as distance_m
from clients_local c
left join last_visit lv on lv.client_id = c.id and lv.rn = 1
where c.is_active = 1
order by distance_m is null, distance_m asc, c.display_name asc
limit ?
`;

// No position known yet (first login before any verified fix).
export const LIST_CLIENTS_ALPHABETICAL_SQL = `
with ${LAST_VISIT_CTE}
select ${CLIENT_COLUMNS}, null as distance_m
from clients_local c
left join last_visit lv on lv.client_id = c.id and lv.rn = 1
where c.is_active = 1
order by c.display_name asc
limit ?
`;

// Local FTS search by name and account ref. No network call, ever.
export const SEARCH_CLIENTS_SQL = `
with ${LAST_VISIT_CTE}
select ${CLIENT_COLUMNS}, ${DISTANCE_M_EXPR} as distance_m
from clients_fts f
join clients_local c on c.id = f.client_id
left join last_visit lv on lv.client_id = c.id and lv.rn = 1
where clients_fts match ? and c.is_active = 1
order by rank
limit ?
`;

// The single row the visit gate needs, with its distance from where the agent
// is standing right now.
export const CLIENT_WITH_DISTANCE_SQL = `
select c.id, c.display_name, c.barangay, c.geofence_radius_m,
       c.geocode_confidence, ${DISTANCE_M_EXPR} as distance_m
from clients_local c
where c.id = ?
`;

export interface Position {
  lat: number;
  lng: number;
}

// Parameter builders — the only supported way to bind these statements.
export function listByDistanceParams(pos: Position, limit: number): unknown[] {
  return [pos.lat, pos.lat, pos.lng, limit];
}
export function listAlphabeticalParams(limit: number): unknown[] {
  return [limit];
}
export function searchParams(
  pos: Position | null,
  ftsQuery: string,
  limit: number,
): unknown[] {
  // With no known position the expression still binds, yielding a distance
  // from (0,0) that the caller discards — so bind NULLs, which make the CASE
  // return NULL for every row.
  return [pos?.lat ?? null, pos?.lat ?? null, pos?.lng ?? null, ftsQuery, limit];
}
export function clientWithDistanceParams(
  pos: Position | null,
  clientId: string,
): unknown[] {
  return [pos?.lat ?? null, pos?.lat ?? null, pos?.lng ?? null, clientId];
}

export const REPLACE_CLIENTS_SQL = {
  clearClients: 'delete from clients_local',
  clearFts: 'delete from clients_fts',
  insertClient: `
    insert into clients_local
      (id, external_ref, display_name, account_type, address_text, barangay,
       city, lat, lng, geofence_radius_m, geocode_confidence, is_active,
       synced_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertFts: `
    insert into clients_fts (client_id, display_name, external_ref, barangay)
    values (?, ?, ?, ?)`,
} as const;

// FTS5 MATCH treats punctuation and bare operators as syntax; an agent typing
// "Aling Nene's" or "-" must not blow up the query. Strip everything that is
// not a letter or digit, then prefix-match each remaining token.
export function toFtsQuery(raw: string): string | null {
  const tokens = raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
