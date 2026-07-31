import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NoOpenSessionError,
  PING_MIN_INTERVAL_MS,
  TRACKING_NOTIFICATION_MESSAGE,
  TRACKING_NOTIFICATION_TITLE,
  WATCHER_DISTANCE_FILTER_M,
  createLocationService,
} from './service.ts';
import { FakeGeolocation, makeHarness, sample } from './fakes.ts';
import type { OpenSessionRef } from './types.ts';

const OPEN: OpenSessionRef = { id: 'session-1', agentId: 'agent-1' };

// THE MODULE INVARIANT (CLAUDE.md rule 4): no open session, no watcher.
test('startIntervalTracking throws NoOpenSessionError when no session is open', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { getOpenSession: async () => null });
  const svc = createLocationService(deps);
  await assert.rejects(svc.startIntervalTracking('session-1'), NoOpenSessionError);
  assert.equal(geo.addWatcherOptions.length, 0, 'no watcher may be opened');
  assert.equal(svc.isTracking(), false);
});

test('startIntervalTracking throws when the requested session is not the open one', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { getOpenSession: async () => OPEN });
  const svc = createLocationService(deps);
  await assert.rejects(svc.startIntervalTracking('some-other-session'), NoOpenSessionError);
  assert.equal(geo.addWatcherOptions.length, 0);
});

test('tracking watcher carries the honest foreground-service notification', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { getOpenSession: async () => OPEN });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  const opts = geo.addWatcherOptions[0];
  assert.equal(opts?.backgroundMessage, TRACKING_NOTIFICATION_MESSAGE);
  assert.equal(opts?.backgroundMessage, 'Naka-check in ka. Sinusubaybayan ang lokasyon.');
  assert.equal(opts?.backgroundTitle, TRACKING_NOTIFICATION_TITLE);
  assert.equal(opts?.stale, false);
  assert.equal(opts?.distanceFilter, WATCHER_DISTANCE_FILTER_M);
  assert.equal(svc.isTracking(), true);
});

test('pings are throttled: one per 5 minutes OR one per 50m of movement', async () => {
  const geo = new FakeGeolocation();
  const { deps, pings, clock } = makeHarness(geo, {
    getOpenSession: async () => OPEN,
  });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  const cb = geo.lastCallback();
  const base = { latitude: 14.45, longitude: 120.98 };

  cb(sample(base)); // first sample always persists
  await svc.settle();
  assert.equal(pings.length, 1);

  clock.value += 60_000; // +1 min, moved ~10m: throttled
  cb(sample({ latitude: base.latitude + 0.00009, longitude: base.longitude }));
  await svc.settle();
  assert.equal(pings.length, 1, 'within 5min and under 50m: skipped');

  clock.value += 60_000; // +2 min total, but moved ~60m: persists
  cb(sample({ latitude: base.latitude + 0.00054, longitude: base.longitude }));
  await svc.settle();
  assert.equal(pings.length, 2, '50m of movement beats the 5min timer');

  clock.value += PING_MIN_INTERVAL_MS + 1_000; // stationary but 5min elapsed
  cb(sample({ latitude: base.latitude + 0.00054, longitude: base.longitude }));
  await svc.settle();
  assert.equal(pings.length, 3, '5 minutes elapsed while stationary: persists');
});

test('persisted pings carry the observation shape', async () => {
  const geo = new FakeGeolocation();
  const { deps, pings } = makeHarness(geo, { getOpenSession: async () => OPEN });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  geo.lastCallback()(sample({ time: 1_722_400_123_000 }));
  await svc.settle();
  const ping = pings[0];
  assert.ok(ping);
  assert.equal(ping.session_id, OPEN.id);
  assert.equal(ping.agent_id, OPEN.agentId);
  assert.equal(ping.source, 'interval');
  assert.equal(ping.is_mocked, false);
  assert.equal(ping.captured_at_device, 1_722_400_123_000);
  assert.equal(ping.battery_pct, 80);
  assert.equal(ping.device_uptime_ms, 123_456);
  assert.equal(ping.id, 'uuid-1');
});

test('simulated interval samples are NEVER persisted; the event is surfaced', async () => {
  const geo = new FakeGeolocation();
  const { deps, pings, events } = makeHarness(geo, {
    getOpenSession: async () => OPEN,
  });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  geo.lastCallback()(sample({ simulated: true }));
  await svc.settle();
  assert.equal(pings.length, 0);
  assert.equal(events[0]?.type, 'mock_sample_blocked');
});

test('interval samples worse than 100m accuracy are dropped (rule 5)', async () => {
  const geo = new FakeGeolocation();
  const { deps, pings, events } = makeHarness(geo, {
    getOpenSession: async () => OPEN,
  });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  geo.lastCallback()(sample({ accuracy: 150.3 }));
  await svc.settle();
  assert.equal(pings.length, 0);
  assert.equal(events[0]?.type, 'low_accuracy_sample_dropped');
});

test('stopIntervalTracking removes the watcher and late samples are ignored', async () => {
  const geo = new FakeGeolocation();
  const { deps, pings } = makeHarness(geo, { getOpenSession: async () => OPEN });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  const cb = geo.lastCallback();
  await svc.stopIntervalTracking();
  assert.equal(geo.removedIds.length, 1);
  assert.equal(svc.isTracking(), false);
  cb(sample()); // native race: a sample delivered after removal
  await svc.settle();
  assert.equal(pings.length, 0, 'no session bound — sample discarded');
});

test('stopIntervalTracking is a safe no-op when not tracking', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo);
  const svc = createLocationService(deps);
  await svc.stopIntervalTracking();
  assert.equal(geo.removedIds.length, 0);
});

test('re-arming the same session is idempotent: one watcher only', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { getOpenSession: async () => OPEN });
  const svc = createLocationService(deps);
  await svc.startIntervalTracking(OPEN.id);
  await svc.startIntervalTracking(OPEN.id);
  assert.equal(geo.addWatcherOptions.length, 1);
  assert.equal(geo.removedIds.length, 0);
});

test('rearmTrackingIfSessionOpen arms only when a session survived restart', async () => {
  const geoOpen = new FakeGeolocation();
  const withOpen = makeHarness(geoOpen, { getOpenSession: async () => OPEN });
  const svcOpen = createLocationService(withOpen.deps);
  assert.equal(await svcOpen.rearmTrackingIfSessionOpen(), true);
  assert.equal(svcOpen.isTracking(), true);

  const geoNone = new FakeGeolocation();
  const withNone = makeHarness(geoNone, { getOpenSession: async () => null });
  const svcNone = createLocationService(withNone.deps);
  assert.equal(await svcNone.rearmTrackingIfSessionOpen(), false);
  assert.equal(geoNone.addWatcherOptions.length, 0, 'rule 4: silence');
});
