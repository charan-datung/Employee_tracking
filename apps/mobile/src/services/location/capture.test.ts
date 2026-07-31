import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocationService } from './service.ts';
import {
  FakeGeolocation,
  instantTimeout,
  makeHarness,
  sample,
} from './fakes.ts';

test('HARD REJECT: one simulated sample poisons the whole capture', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => {
    cb(sample({ accuracy: 5 }));
    cb(sample({ accuracy: 4 }));
    cb(sample({ accuracy: 6, simulated: true })); // the poison
    cb(sample({ accuracy: 3 }));
    cb(sample({ accuracy: 5 }));
  };
  const { deps } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'mocked');
  assert.equal(geo.removedIds.length, 1, 'watcher must be removed');
});

test('mocked takes precedence even over insufficient samples', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => cb(sample({ simulated: true }));
  const { deps } = makeHarness(geo, { sleep: instantTimeout });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'visit_arrive',
  });
  assert.equal(!result.ok && result.reason, 'mocked');
  assert.equal(geo.removedIds.length, 1);
});

test('HARD REJECT: best accuracy above the ceiling, with the measured value', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => {
    cb(sample({ accuracy: 220.7 }));
    cb(sample({ accuracy: 180.44 })); // best, still too coarse
    cb(sample({ accuracy: 305.1 }));
  };
  const { deps } = makeHarness(geo, { sleep: instantTimeout });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(!result.ok && result.reason, 'accuracy_degraded');
  assert.equal(!result.ok && result.measured_accuracy_m, 180.4);
  assert.equal(geo.removedIds.length, 1);
});

test('HARD REJECT: fewer than 2 samples gives no jitter signal', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => cb(sample());
  const { deps } = makeHarness(geo, { sleep: instantTimeout });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_out',
  });
  assert.equal(!result.ok && result.reason, 'insufficient_samples');
  assert.equal(!result.ok && result.sample_count, 1);
  assert.equal(geo.removedIds.length, 1);
});

test('zero samples before timeout also rejects as insufficient', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { sleep: instantTimeout });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(!result.ok && result.reason, 'insufficient_samples');
  assert.equal(geo.removedIds.length, 1);
});

test('permission_denied from the pre-check opens NO watcher and never prompts', async () => {
  const geo = new FakeGeolocation();
  const { deps } = makeHarness(geo, { checkPermission: async () => 'denied' });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(!result.ok && result.reason, 'permission_denied');
  assert.equal(geo.addWatcherOptions.length, 0, 'no watcher, no prompt');
  assert.equal(geo.removedIds.length, 0);
});

test('NOT_AUTHORIZED from the watcher maps to permission_denied and removes it', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) =>
    cb(undefined, { code: 'NOT_AUTHORIZED', message: 'no' });
  const { deps } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
    requestPermission: true, // UI has explained; watcher may prompt
  });
  assert.equal(!result.ok && result.reason, 'permission_denied');
  assert.equal(geo.removedIds.length, 1);
});

test('watcher error (non-permission) rejects as unavailable, watcher removed', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) =>
    cb(undefined, { code: 'GPS_OFF', message: 'location services disabled' });
  const { deps } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(!result.ok && result.reason, 'unavailable');
  assert.equal(geo.removedIds.length, 1);
});

test('addWatcher throwing natively rejects as unavailable without a leak', async () => {
  const geo = new FakeGeolocation();
  geo.failNextAddWatcher = true;
  const { deps } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.equal(!result.ok && result.reason, 'unavailable');
  assert.equal(geo.removedIds.length, 0, 'nothing was opened, nothing to remove');
  assert.equal(geo.active.size, 0);
});

test('an exception mid-collection still removes the watcher (finally path)', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => {
    cb(sample());
    cb(sample());
  };
  const { deps } = makeHarness(geo, {
    sleep: async () => {
      throw new Error('timer subsystem exploded');
    },
  });
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
    sampleCount: 5, // not reached — the race hits the throwing sleep
  });
  assert.equal(!result.ok && result.reason, 'unavailable');
  assert.equal(geo.removedIds.length, 1, 'finally must remove the watcher');
  assert.equal(geo.active.size, 0);
});

test('success: best sample wins, integrity signals computed, watcher removed once', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => {
    cb(sample({ latitude: 14.45, longitude: 120.98, accuracy: 12.2 }));
    cb(sample({ latitude: 14.45004, longitude: 120.98, accuracy: 8.41 })); // best
    cb(sample({ latitude: 14.45002, longitude: 120.98003, accuracy: 9.9 }));
    cb(sample({ latitude: 14.45001, longitude: 120.98001, accuracy: 15.0 }));
    cb(sample({ latitude: 14.45003, longitude: 120.98002, accuracy: 11.1 }));
  };
  const { deps, clock } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'visit_arrive',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.lat, 14.45004);
  assert.equal(result.accuracy_m, 8.41);
  assert.equal(result.is_mocked, false, 'simulated=false is still persisted');
  assert.equal(result.sample_count, 5);
  assert.ok(result.jitter_m > 2 && result.jitter_m < 10, `jitter ${result.jitter_m}`);
  assert.ok(result.accuracy_variance > 0);
  assert.equal(result.null_sensor_count, 0);
  assert.equal(result.battery_pct, 80);
  assert.equal(result.is_charging, false);
  assert.equal(result.captured_at_device, clock.value);
  assert.equal(result.device_uptime_ms, 123_456);
  assert.equal(geo.removedIds.length, 1);
  // Foreground one-shot must NEVER create the foreground service.
  assert.equal(geo.addWatcherOptions[0]?.backgroundMessage, undefined);
  assert.equal(geo.addWatcherOptions[0]?.requestPermissions, true);
  assert.equal(geo.addWatcherOptions[0]?.stale, false);
});

test('spoof-shaped data is observed, NOT rejected client-side: the server decides', async () => {
  const geo = new FakeGeolocation();
  const frozen = sample({
    latitude: 14.46,
    longitude: 120.99,
    accuracy: 5.0, // suspiciously round and constant
    altitude: null,
    speed: null,
    bearing: null,
  });
  geo.onAddWatcher = (_o, cb) => {
    for (let i = 0; i < 5; i += 1) cb({ ...frozen });
  };
  const { deps } = makeHarness(geo);
  const result = await createLocationService(deps).captureVerifiedFix({
    purpose: 'check_in',
  });
  assert.ok(result.ok, 'client must not reject on derived signals');
  if (!result.ok) return;
  assert.equal(result.jitter_m, 0);
  assert.equal(result.accuracy_variance, 0);
  assert.equal(result.null_sensor_count, 3);
});
