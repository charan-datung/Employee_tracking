import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbePermissionCheck } from './permission.ts';
import { FakeGeolocation, instantTimeout, sample } from './fakes.ts';

const hangingSleep = (): Promise<void> => new Promise<void>(() => undefined);

test('probe never prompts: requestPermissions is false, stale is true', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => cb(sample());
  const check = createProbePermissionCheck(geo, hangingSleep);
  await check();
  assert.equal(geo.addWatcherOptions[0]?.requestPermissions, false);
  assert.equal(geo.addWatcherOptions[0]?.stale, true);
});

test('NOT_AUTHORIZED error means denied, and the probe watcher is removed', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) =>
    cb(undefined, { code: 'NOT_AUTHORIZED', message: 'denied' });
  const check = createProbePermissionCheck(geo, hangingSleep);
  assert.equal(await check(), 'denied');
  assert.equal(geo.removedIds.length, 1);
  assert.equal(geo.active.size, 0);
});

test('a delivered location means granted, watcher removed', async () => {
  const geo = new FakeGeolocation();
  geo.onAddWatcher = (_o, cb) => cb(sample());
  const check = createProbePermissionCheck(geo, hangingSleep);
  assert.equal(await check(), 'granted');
  assert.equal(geo.removedIds.length, 1);
});

test('silence until timeout means unknown, watcher still removed', async () => {
  const geo = new FakeGeolocation();
  const check = createProbePermissionCheck(geo, instantTimeout);
  assert.equal(await check(), 'unknown');
  assert.equal(geo.removedIds.length, 1);
  assert.equal(geo.active.size, 0);
});

test('addWatcher failure degrades to unknown without leaking', async () => {
  const geo = new FakeGeolocation();
  geo.failNextAddWatcher = true;
  const check = createProbePermissionCheck(geo, instantTimeout);
  assert.equal(await check(), 'unknown');
  assert.equal(geo.removedIds.length, 0);
});
