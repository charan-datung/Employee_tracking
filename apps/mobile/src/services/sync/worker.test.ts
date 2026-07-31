import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncWorker, BATCH_SIZE, BACKOFF_CAP_MS } from './worker.ts';
import { backoffDelayMs } from './worker.ts';
import { makeSyncHarness, lastStatus } from './fakes.ts';

const T0 = 1_722_400_000_000;

test('airplane mode: 30 queued writes wait, then sync in one batch on reconnect', async () => {
  const h = makeSyncHarness();
  for (let i = 0; i < 30; i += 1) {
    h.outbox.add({
      entityType: 'ping',
      entityLocalId: `p${i}`,
      sessionId: 's-acked', // session not in outbox => already on server
      createdAtDevice: T0 + i,
    });
  }
  h.online.value = false;
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.server.pushes.length, 0, 'nothing pushed offline');
  assert.equal(lastStatus(h).pending, 30);
  assert.equal(lastStatus(h).isOnline, false);

  h.online.value = true;
  await worker.runOnce();
  assert.equal(h.server.pushes.length, 1, '30 rows fit one batch of 50');
  assert.equal(h.server.pushes[0]?.payloads.length, 30);
  assert.equal(lastStatus(h).pending, 0);
  assert.ok(lastStatus(h).lastSyncedAt !== null);
});

test('batches cap at 50 in created_at_device order', async () => {
  const h = makeSyncHarness();
  for (let i = 0; i < 120; i += 1) {
    h.outbox.add({
      entityType: 'ping',
      entityLocalId: `p${i}`,
      sessionId: 's-acked',
      createdAtDevice: T0 + i,
    });
  }
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  // Candidate window is 200, so all 120 drain in one pass: 50 + 50 + 20.
  assert.deepEqual(
    h.server.pushes.map((p) => p.payloads.length),
    [BATCH_SIZE, BATCH_SIZE, 20],
  );
  const sent = h.server.pushes.flatMap((p) => p.payloads.map((x) => x['id']));
  assert.deepEqual(sent, [...Array(120).keys()].map((i) => `p${i}`));
});

test('out-of-order delivery: children enqueued first still wait for session_open', async () => {
  const h = makeSyncHarness();
  // Enqueued BEFORE the session (older created_at_device) — ordering luck
  // would push them first; the dependency check must not.
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 'S', createdAtDevice: T0 });
  h.outbox.add({ entityType: 'visit', entityLocalId: 'v1', sessionId: 'S', createdAtDevice: T0 + 1 });
  h.outbox.add({ entityType: 'session_open', entityLocalId: 'S', sessionId: 'S', createdAtDevice: T0 + 2 });

  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.deepEqual(
    h.server.pushes.map((p) => p.entityType),
    ['session_open'],
    'first drain: only the session may go',
  );

  await worker.runOnce();
  assert.deepEqual(
    h.server.pushes.map((p) => p.entityType),
    ['session_open', 'ping', 'visit'],
    'second drain: children follow, in created order',
  );
});

test('duplicate submission: rows re-sent after a mid-sync kill do not duplicate', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p2', sessionId: 's-acked', createdAtDevice: T0 + 1 });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.server.storedIds.size, 2);

  // App killed mid-sync AFTER the server stored the rows but BEFORE the ack
  // landed locally: rows are stuck in_flight on restart.
  for (const row of h.outbox.rows) row.status = 'in_flight';
  const worker2 = createSyncWorker(h.deps);
  await worker2.init(); // crash recovery: in_flight -> queued
  assert.ok(h.outbox.rows.every((r) => r.status === 'queued'));

  await worker2.runOnce();
  // Re-sent (client cannot know) — but the server's on-conflict-do-nothing
  // keeps exactly one copy per client-generated UUID.
  assert.equal(h.server.storedIds.size, 2, 'no duplicates server-side');
  assert.ok(h.outbox.rows.every((r) => r.status === 'acked'));
});

test('409 conflict is transient: backoff then retry succeeds', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.server.scriptedBatch.push({ kind: 'conflict', detail: '409 fk' });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  const row = h.outbox.byLocalId('p1');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.attempt_count, 1);

  // Inside the 2s backoff window: not retried.
  h.clock.value += 1_000;
  await worker.runOnce();
  assert.equal(h.server.storedIds.size, 0);

  // Past the backoff: retried and acked.
  h.clock.value += 2_000;
  await worker.runOnce();
  assert.equal(row?.status, 'acked');
});

test('backoff schedule is 2s/8s/30s/2m/10m capped at 30m', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 99].map(backoffDelayMs),
    [2_000, 8_000, 30_000, 120_000, 600_000, BACKOFF_CAP_MS, BACKOFF_CAP_MS, BACKOFF_CAP_MS],
  );
});

test('permanent 4xx: poison row isolated, kept forever, surfaced as sync_anomaly', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p2', sessionId: 's-acked', createdAtDevice: T0 + 1 });
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p3', sessionId: 's-acked', createdAtDevice: T0 + 2 });
  // The batch 400s; item-by-item replay isolates p2 as the poison row.
  h.server.scriptedBatch.push({ kind: 'permanent', detail: '400 bad payload' });
  h.server.scriptedOne.push({ kind: 'ok' });
  h.server.scriptedOne.push({ kind: 'permanent', detail: '400 bad payload' });
  h.server.scriptedOne.push({ kind: 'ok' });

  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();

  assert.equal(h.outbox.byLocalId('p1')?.status, 'acked');
  assert.equal(h.outbox.byLocalId('p2')?.status, 'failed_permanent');
  assert.equal(h.outbox.byLocalId('p3')?.status, 'acked');
  assert.ok(
    h.outbox.rows.some((r) => r.entity_local_id === 'p2'),
    'the failed row is KEPT, never dropped',
  );
  const anomaly = h.flags.find(
    (f) => f.detail['kind'] === 'permanent_sync_failure',
  );
  assert.ok(anomaly, 'sync_anomaly raised for the console');
  assert.equal(anomaly.flag_type, 'sync_anomaly');
  assert.equal(anomaly.detail['entity_local_id'], 'p2');
  assert.equal(lastStatus(h).failedPermanent, 1);
});

test('401: refresh token then ONE retry within the drain', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.server.scriptedBatch.push({ kind: 'auth' });
  h.server.refreshResults.push(true);
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.server.refreshCalls, 1);
  assert.equal(h.outbox.byLocalId('p1')?.status, 'acked');
});

test('401 with failed refresh stays queued for the next drain', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.server.scriptedBatch.push({ kind: 'auth' });
  h.server.refreshResults.push(false);
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  const row = h.outbox.byLocalId('p1');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.attempt_count, 1);
});

test('clock tamper: offset measured per drain is stamped on every stamped record', async () => {
  const h = makeSyncHarness();
  h.server.serverOffsetMs = 120_000; // device clock is 2 minutes behind
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 's-acked', createdAtDevice: T0 });
  h.outbox.add({
    entityType: 'flag',
    entityLocalId: 'f1',
    createdAtDevice: T0 + 1,
    payload: { id: 'f1', flag_type: 'sync_anomaly' },
  });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  const ping = h.server.pushes.find((p) => p.entityType === 'ping');
  assert.equal(ping?.payloads[0]?.['device_clock_offset_ms'], 120_000);
  const flag = h.server.pushes.find((p) => p.entityType === 'flag');
  assert.equal(
    flag?.payloads[0]?.['device_clock_offset_ms'],
    undefined,
    'flags have no offset column',
  );
});

test('session_close waits for pings/visits, then goes alone', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 'S', createdAtDevice: T0 });
  h.outbox.add({ entityType: 'session_close', entityLocalId: 'S', sessionId: 'S', createdAtDevice: T0 + 1 });

  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.deepEqual(h.server.pushes.map((p) => p.entityType), ['ping']);
  assert.equal(h.outbox.byLocalId('S')?.status, 'queued', 'close held back');

  await worker.runOnce();
  assert.deepEqual(h.server.pushes.map((p) => p.entityType), ['ping', 'session_close']);
  assert.equal(h.server.pushes[1]?.payloads.length, 1, 'close is a single-row chunk');
});

test('a failed_permanent ping does NOT block check-out forever', async () => {
  const h = makeSyncHarness();
  h.outbox.add({
    entityType: 'ping',
    entityLocalId: 'p-poison',
    sessionId: 'S',
    createdAtDevice: T0,
    status: 'failed_permanent',
  });
  h.outbox.add({ entityType: 'session_close', entityLocalId: 'S', sessionId: 'S', createdAtDevice: T0 + 1 });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.outbox.byLocalId('S')?.status, 'acked');
});

test('a record never syncs before its photo exists in storage', async () => {
  const h = makeSyncHarness();
  h.outbox.add({ entityType: 'photo', entityLocalId: 'ph1', createdAtDevice: T0 });
  h.outbox.add({
    entityType: 'session_open',
    entityLocalId: 'S',
    sessionId: 'S',
    dependsPhotoId: 'ph1',
    createdAtDevice: T0 + 1,
  });
  // First drain: photo upload FAILS transiently -> session_open must wait.
  h.photos.scripted.push({ kind: 'transient', detail: 'network' });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.outbox.byLocalId('S')?.status, 'queued');
  assert.equal(h.server.pushes.length, 0);

  // Photo backoff elapses, upload succeeds, then the record follows.
  h.clock.value += 3_000;
  await worker.runOnce();
  assert.deepEqual(h.photos.uploads, ['ph1']);
  await worker.runOnce();
  assert.equal(h.outbox.byLocalId('S')?.status, 'acked');
});

test('storage pressure raises the blocking status + one sync_anomaly, purges nothing', async () => {
  const h = makeSyncHarness();
  for (let i = 0; i < 5_001; i += 1) {
    h.outbox.add({
      entityType: 'ping',
      entityLocalId: `p${i}`,
      sessionId: 's-acked',
      createdAtDevice: T0 + i,
    });
  }
  h.online.value = false; // stuck offline — exactly the dangerous case
  const worker = createSyncWorker(h.deps);
  await worker.init();
  const before = h.outbox.rows.length;
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(lastStatus(h).storagePressure, true);
  const pressureFlags = h.flags.filter((f) => f.detail['kind'] === 'storage_pressure');
  assert.equal(pressureFlags.length, 1, 'reported once, not per drain');
  assert.ok(h.outbox.rows.length >= before, 'nothing auto-purged');
});

test('oldestPendingAgeMinutes feeds the red pill threshold', async () => {
  const h = makeSyncHarness();
  h.outbox.add({
    entityType: 'ping',
    entityLocalId: 'p1',
    sessionId: 's-acked',
    createdAtDevice: T0 - 5 * 60 * 60 * 1000, // queued 5 hours ago
  });
  h.online.value = false;
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(lastStatus(h).oldestPendingAgeMinutes, 300);
});

test('children are blocked while their session_open is failed_permanent', async () => {
  const h = makeSyncHarness();
  h.outbox.add({
    entityType: 'session_open',
    entityLocalId: 'S',
    sessionId: 'S',
    createdAtDevice: T0,
    status: 'failed_permanent',
  });
  h.outbox.add({ entityType: 'ping', entityLocalId: 'p1', sessionId: 'S', createdAtDevice: T0 + 1 });
  const worker = createSyncWorker(h.deps);
  await worker.init();
  await worker.runOnce();
  assert.equal(h.server.pushes.length, 0, 'orphan ping must not insert');
  assert.equal(h.outbox.byLocalId('p1')?.status, 'queued');
});
