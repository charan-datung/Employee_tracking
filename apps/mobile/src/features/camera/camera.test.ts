import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EDGE_PX,
  SelfieCaptureError,
  openFrontCameraStream,
  scaleToLongestEdge,
  stopStream,
  type MediaDevicesPort,
} from './camera.ts';

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function fakeStream(): { stream: MediaStream; stops: number[] } {
  const stops: number[] = [];
  const tracks = [0, 1].map((i) => ({
    stop: () => {
      stops.push(i);
    },
  }));
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, stops };
}

function devicesReturning(
  result: MediaStream | Error,
): { devices: MediaDevicesPort; calls: MediaStreamConstraints[] } {
  const calls: MediaStreamConstraints[] = [];
  return {
    calls,
    devices: {
      async getUserMedia(constraints) {
        calls.push(constraints);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test('requests the front camera with facingMode EXACT user, audio off', async () => {
  const { stream } = fakeStream();
  const { devices, calls } = devicesReturning(stream);
  await openFrontCameraStream(devices);
  assert.equal(calls.length, 1);
  const video = calls[0]?.video as {
    facingMode: { exact: string };
    width: { ideal: number };
  };
  assert.deepEqual(video.facingMode, { exact: 'user' });
  assert.equal(video.width.ideal, MAX_EDGE_PX);
  assert.equal(calls[0]?.audio, false);
});

test('NotAllowedError maps to permission_denied', async () => {
  const { devices } = devicesReturning(namedError('NotAllowedError'));
  await assert.rejects(openFrontCameraStream(devices), (e: unknown) => {
    assert.ok(e instanceof SelfieCaptureError);
    assert.equal(e.reason, 'permission_denied');
    return true;
  });
});

test('OverconstrainedError rejects with no_front_camera and NEVER retries looser', async () => {
  const { devices, calls } = devicesReturning(namedError('OverconstrainedError'));
  await assert.rejects(openFrontCameraStream(devices), (e: unknown) => {
    assert.ok(e instanceof SelfieCaptureError);
    assert.equal(e.reason, 'no_front_camera');
    return true;
  });
  // Exactly one getUserMedia call: no second attempt without `exact`, which
  // is the path that ends at the rear camera.
  assert.equal(calls.length, 1);
});

test('NotFoundError also maps to no_front_camera', async () => {
  const { devices } = devicesReturning(namedError('NotFoundError'));
  await assert.rejects(openFrontCameraStream(devices), (e: unknown) => {
    assert.ok(e instanceof SelfieCaptureError);
    assert.equal(e.reason, 'no_front_camera');
    return true;
  });
});

test('other failures map to camera_unavailable', async () => {
  const { devices } = devicesReturning(namedError('NotReadableError'));
  await assert.rejects(openFrontCameraStream(devices), (e: unknown) => {
    assert.ok(e instanceof SelfieCaptureError);
    assert.equal(e.reason, 'camera_unavailable');
    return true;
  });
});

test('stopStream stops every track and is null-safe and re-entrant', () => {
  const { stream, stops } = fakeStream();
  stopStream(stream);
  assert.deepEqual(stops, [0, 1]);
  stopStream(stream); // idempotent second call
  assert.deepEqual(stops, [0, 1, 0, 1]);
  stopStream(null); // no stream: no-op
});

test('a stubborn track does not block stopping the rest', () => {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          throw new Error('track wedged');
        },
      },
      {
        stop: () => {
          stopped.push('second');
        },
      },
    ],
  } as unknown as MediaStream;
  stopStream(stream);
  assert.deepEqual(stopped, ['second']);
});

test('scaleToLongestEdge: landscape, portrait, never upscales', () => {
  assert.deepEqual(scaleToLongestEdge(4000, 3000, 1280), { width: 1280, height: 960 });
  assert.deepEqual(scaleToLongestEdge(3000, 4000, 1280), { width: 960, height: 1280 });
  assert.deepEqual(scaleToLongestEdge(1000, 800, 1280), { width: 1000, height: 800 });
  assert.deepEqual(scaleToLongestEdge(1280, 720, 1280), { width: 1280, height: 720 });
  assert.deepEqual(scaleToLongestEdge(0, 0, 1280), { width: 0, height: 0 });
});
