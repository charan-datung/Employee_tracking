import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  maxPairwiseDistanceM,
  populationVariance,
  round,
} from './geo.ts';

test('haversineMeters: 0.001 deg of latitude is ~111m', () => {
  const d = haversineMeters(14.45, 120.98, 14.451, 120.98);
  assert.ok(d > 105 && d < 117, `expected ~111m, got ${d}`);
});

test('haversineMeters: identical points are 0m', () => {
  assert.equal(haversineMeters(14.45, 120.98, 14.45, 120.98), 0);
});

test('maxPairwiseDistanceM: identical samples give exactly 0 (the spoof signature)', () => {
  const p = { latitude: 14.45, longitude: 120.98 };
  assert.equal(maxPairwiseDistanceM([p, p, p, p, p]), 0);
});

test('maxPairwiseDistanceM: returns the largest leg, not the last', () => {
  const points = [
    { latitude: 14.45, longitude: 120.98 }, // A
    { latitude: 14.4501, longitude: 120.98 }, // ~11m from A
    { latitude: 14.4506, longitude: 120.98 }, // ~67m from A — the max pair
  ];
  const d = maxPairwiseDistanceM(points);
  assert.ok(d > 60 && d < 74, `expected ~67m, got ${d}`);
});

test('populationVariance: constant values give 0, spread gives variance', () => {
  assert.equal(populationVariance([5, 5, 5, 5]), 0);
  assert.equal(populationVariance([4, 6]), 1);
  assert.equal(populationVariance([]), 0);
});

test('round rounds to the given decimals', () => {
  assert.equal(round(180.4567, 1), 180.5);
  assert.equal(round(0.005, 2), 0.01);
});
