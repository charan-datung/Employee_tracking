import type { LocalPing } from '../location/types.ts';
import type { EnqueueInput } from './store.ts';
import type { SavedPhoto } from './photos.ts';

// Feature-facing enqueue API (the attendance feature calls these). Each call
// commits the local mirror row + the outbox row in ONE SQLite transaction and
// returns as soon as that commit lands — the UI never awaits the network
// (task rule 1). IDs are client-generated UUIDs; the server ignores
// duplicates on retry (task rule 2).

const iso = (ms: number): string => new Date(ms).toISOString();

export interface SessionOpenInput {
  sessionId: string;
  agentId: string;
  deviceId: string;
  branchId: string;
  openedAtDeviceMs: number;
  lat: number;
  lng: number;
  accuracyM: number;
  isMocked: boolean;
  deviceUptimeMs: number | null;
  photo: SavedPhoto;
}

export interface SessionCloseInput {
  sessionId: string;
  closedAtDeviceMs: number;
  lat: number;
  lng: number;
  accuracyM: number;
  isMocked: boolean;
  deviceUptimeMs: number | null;
  photo: SavedPhoto;
}

export interface VisitInput {
  visitId: string;
  sessionId: string;
  agentId: string;
  clientId: string;
  arrivedAtDeviceMs: number;
  lat: number;
  lng: number;
  accuracyM: number;
  isMocked: boolean;
  deviceUptimeMs: number | null;
  outcome: string | null;
  outcomeNotes: string | null;
  geofenceMissReason: string | null;
  photo: SavedPhoto | null;
}

export function createSyncApi(deps: {
  enqueue(input: EnqueueInput): Promise<void>;
  now(): number;
}) {
  async function enqueueSessionOpen(input: SessionOpenInput): Promise<void> {
    await deps.enqueue({
      entityType: 'session_open',
      entityLocalId: input.sessionId,
      sessionId: input.sessionId,
      dependsPhotoId: input.photo.photoLocalId,
      createdAtDevice: deps.now(),
      payload: {
        id: input.sessionId,
        agent_id: input.agentId,
        device_id: input.deviceId,
        open_branch_id: input.branchId,
        opened_at_device: iso(input.openedAtDeviceMs),
        open_lat: input.lat,
        open_lng: input.lng,
        open_accuracy_m: input.accuracyM,
        open_is_mocked: input.isMocked,
        open_photo_path: input.photo.storageObjectPath,
        open_photo_sha256: input.photo.sha256,
        open_device_uptime_ms: input.deviceUptimeMs,
      },
      mirrorStatements: [
        {
          statement: `insert into attendance_sessions_local
            (id, agent_id, device_id, opened_at_device, open_lat, open_lng,
             open_accuracy_m, open_is_mocked, open_photo_local_id,
             open_photo_sha256, open_branch_id, open_device_uptime_ms,
             status, created_at_device)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          values: [
            input.sessionId,
            input.agentId,
            input.deviceId,
            input.openedAtDeviceMs,
            input.lat,
            input.lng,
            input.accuracyM,
            input.isMocked ? 1 : 0,
            input.photo.photoLocalId,
            input.photo.sha256,
            input.branchId,
            input.deviceUptimeMs,
            deps.now(),
          ],
        },
        photoOutboxStatement(input.photo, deps.now()),
      ],
    });
  }

  async function enqueueSessionClose(input: SessionCloseInput): Promise<void> {
    await deps.enqueue({
      entityType: 'session_close',
      entityLocalId: input.sessionId,
      sessionId: input.sessionId,
      dependsPhotoId: input.photo.photoLocalId,
      createdAtDevice: deps.now(),
      payload: {
        id: input.sessionId,
        status: 'closed',
        closed_at_device: iso(input.closedAtDeviceMs),
        close_lat: input.lat,
        close_lng: input.lng,
        close_accuracy_m: input.accuracyM,
        close_is_mocked: input.isMocked,
        close_photo_path: input.photo.storageObjectPath,
        close_photo_sha256: input.photo.sha256,
        close_device_uptime_ms: input.deviceUptimeMs,
      },
      mirrorStatements: [
        {
          statement: `update attendance_sessions_local
            set status = 'closed', closed_at_device = ?, close_lat = ?,
                close_lng = ?, close_accuracy_m = ?, close_is_mocked = ?,
                close_photo_local_id = ?, close_photo_sha256 = ?,
                close_device_uptime_ms = ?
            where id = ?`,
          values: [
            input.closedAtDeviceMs,
            input.lat,
            input.lng,
            input.accuracyM,
            input.isMocked ? 1 : 0,
            input.photo.photoLocalId,
            input.photo.sha256,
            input.deviceUptimeMs,
            input.sessionId,
          ],
        },
        photoOutboxStatement(input.photo, deps.now()),
      ],
    });
  }

  async function enqueueVisit(input: VisitInput): Promise<void> {
    await deps.enqueue({
      entityType: 'visit',
      entityLocalId: input.visitId,
      sessionId: input.sessionId,
      dependsPhotoId: input.photo?.photoLocalId ?? null,
      createdAtDevice: deps.now(),
      payload: {
        id: input.visitId,
        session_id: input.sessionId,
        agent_id: input.agentId,
        client_id: input.clientId,
        arrived_at_device: iso(input.arrivedAtDeviceMs),
        arrive_lat: input.lat,
        arrive_lng: input.lng,
        arrive_accuracy_m: input.accuracyM,
        arrive_is_mocked: input.isMocked,
        arrive_device_uptime_ms: input.deviceUptimeMs,
        outcome: input.outcome,
        outcome_notes: input.outcomeNotes,
        geofence_miss_reason: input.geofenceMissReason,
        photo_path: input.photo?.storageObjectPath ?? null,
        photo_sha256: input.photo?.sha256 ?? null,
      },
      mirrorStatements: [
        {
          statement: `insert into visits_local
            (id, session_id, agent_id, client_id, arrived_at_device,
             arrive_lat, arrive_lng, arrive_accuracy_m, arrive_is_mocked,
             arrive_device_uptime_ms, outcome, outcome_notes,
             geofence_miss_reason, photo_local_id, photo_sha256,
             created_at_device)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            input.visitId,
            input.sessionId,
            input.agentId,
            input.clientId,
            input.arrivedAtDeviceMs,
            input.lat,
            input.lng,
            input.accuracyM,
            input.isMocked ? 1 : 0,
            input.deviceUptimeMs,
            input.outcome,
            input.outcomeNotes,
            input.geofenceMissReason,
            input.photo?.photoLocalId ?? null,
            input.photo?.sha256 ?? null,
            deps.now(),
          ],
        },
        ...(input.photo !== null
          ? [photoOutboxStatement(input.photo, deps.now())]
          : []),
      ],
    });
  }

  // "AALIS NA AKO". A PATCH of the already-inserted visit, write-once at the
  // database (policy visits_update_departure_own). departure_was_inferred and
  // dwell_seconds_server are server-owned and deliberately absent here.
  async function enqueueVisitDeparture(input: {
    visitId: string;
    sessionId: string;
    departedAtDeviceMs: number;
    lat: number;
    lng: number;
  }): Promise<void> {
    await deps.enqueue({
      entityType: 'visit_departure',
      entityLocalId: input.visitId,
      sessionId: input.sessionId,
      dependsPhotoId: null,
      createdAtDevice: deps.now(),
      payload: {
        id: input.visitId,
        departed_at_device: iso(input.departedAtDeviceMs),
        depart_lat: input.lat,
        depart_lng: input.lng,
      },
      mirrorStatements: [
        {
          statement: `update visits_local
            set departed_at_device = ?, depart_lat = ?, depart_lng = ?
            where id = ? and departed_at_device is null`,
          values: [input.departedAtDeviceMs, input.lat, input.lng, input.visitId],
        },
      ],
    });
  }

  async function enqueuePing(ping: LocalPing): Promise<void> {
    await deps.enqueue({
      entityType: 'ping',
      entityLocalId: ping.id,
      sessionId: ping.session_id,
      dependsPhotoId: null,
      createdAtDevice: deps.now(),
      payload: {
        id: ping.id,
        session_id: ping.session_id,
        agent_id: ping.agent_id,
        captured_at_device: iso(ping.captured_at_device),
        device_uptime_ms: ping.device_uptime_ms,
        lat: ping.lat,
        lng: ping.lng,
        accuracy_m: ping.accuracy_m,
        altitude_m: ping.altitude_m,
        altitude_accuracy_m: ping.altitude_accuracy_m,
        speed_mps: ping.speed_mps,
        bearing: ping.bearing,
        is_mocked: ping.is_mocked,
        battery_pct: ping.battery_pct,
        is_charging: ping.is_charging,
        source: ping.source,
      },
      mirrorStatements: [
        {
          statement: `insert into location_pings_local
            (id, session_id, agent_id, captured_at_device, device_uptime_ms,
             lat, lng, accuracy_m, altitude_m, altitude_accuracy_m, speed_mps,
             bearing, is_mocked, battery_pct, is_charging, source,
             created_at_device)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            ping.id,
            ping.session_id,
            ping.agent_id,
            ping.captured_at_device,
            ping.device_uptime_ms,
            ping.lat,
            ping.lng,
            ping.accuracy_m,
            ping.altitude_m,
            ping.altitude_accuracy_m,
            ping.speed_mps,
            ping.bearing,
            ping.is_mocked ? 1 : 0,
            ping.battery_pct,
            ping.is_charging === null ? null : ping.is_charging ? 1 : 0,
            ping.source,
            deps.now(),
          ],
        },
      ],
    });
  }

  return {
    enqueueSessionOpen,
    enqueueSessionClose,
    enqueueVisit,
    enqueueVisitDeparture,
    enqueuePing,
  };
}

// The photo's own outbox row rides in the same transaction as its parent's
// mirror row, so a photo can never be orphaned by a crash between writes.
// insert-or-ignore: check-in and check-out both reference their own photo,
// enqueued exactly once.
function photoOutboxStatement(
  photo: SavedPhoto,
  nowMs: number,
): { statement: string; values: unknown[] } {
  return {
    statement: `insert into outbox
      (id, entity_type, entity_local_id, session_id, depends_photo_id,
       payload_json, created_at_device, status)
     values (?, 'photo', ?, null, null, '{}', ?, 'queued')
     on conflict (entity_type, entity_local_id) do nothing`,
    values: [crypto.randomUUID(), photo.photoLocalId, nowMs],
  };
}
