import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64ToBytes, bytesToBase64, sha256Hex } from './crypto.ts';

test('sha256Hex matches the known vector for "abc"', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(
    await sha256Hex(bytes),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('base64 round-trip preserves bytes', () => {
  const original = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(original))], [...original]);
});
