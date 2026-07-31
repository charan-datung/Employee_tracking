import type { GeocodeConfidence } from '@datung/shared';
import { sqlPort } from '../../services/sync/db.ts';
import {
  CLIENT_WITH_DISTANCE_SQL,
  LIST_CLIENTS_ALPHABETICAL_SQL,
  LIST_CLIENTS_BY_DISTANCE_SQL,
  SEARCH_CLIENTS_SQL,
  clientWithDistanceParams,
  listAlphabeticalParams,
  listByDistanceParams,
  searchParams,
  toFtsQuery,
  type Position,
} from './sql.ts';

// Reads over the offline client book. Every one of these works with zero
// connectivity; none of them touch the network.

export interface ClientListItem {
  id: string;
  external_ref: string | null;
  display_name: string;
  account_type: string;
  address_text: string | null;
  barangay: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number;
  geocode_confidence: GeocodeConfidence;
  last_visit_at: number | null;
  last_visit_outcome: string | null;
  distance_m: number | null;
}

const DEFAULT_LIMIT = 300;

export async function listClients(
  position: Position | null,
  limit = DEFAULT_LIMIT,
): Promise<ClientListItem[]> {
  return position === null
    ? sqlPort.query<ClientListItem>(
        LIST_CLIENTS_ALPHABETICAL_SQL,
        listAlphabeticalParams(limit),
      )
    : sqlPort.query<ClientListItem>(
        LIST_CLIENTS_BY_DISTANCE_SQL,
        listByDistanceParams(position, limit),
      );
}

export async function searchClients(
  rawQuery: string,
  position: Position | null,
  limit = DEFAULT_LIMIT,
): Promise<ClientListItem[]> {
  const fts = toFtsQuery(rawQuery);
  if (fts === null) return listClients(position, limit);
  return sqlPort.query<ClientListItem>(
    SEARCH_CLIENTS_SQL,
    searchParams(position, fts, limit),
  );
}

export interface ClientForGate {
  id: string;
  display_name: string;
  barangay: string | null;
  geofence_radius_m: number;
  geocode_confidence: GeocodeConfidence;
  /** Provisional, device-side, for UI gating only — the server recomputes. */
  distance_m: number | null;
}

export async function getClientWithDistance(
  clientId: string,
  position: Position | null,
): Promise<ClientForGate | null> {
  const rows = await sqlPort.query<ClientForGate>(
    CLIENT_WITH_DISTANCE_SQL,
    clientWithDistanceParams(position, clientId),
  );
  return rows[0] ?? null;
}

export async function countClients(): Promise<number> {
  const rows = await sqlPort.query<{ n: number }>(
    'select count(*) as n from clients_local where is_active = 1',
  );
  return rows[0]?.n ?? 0;
}
