import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTusUploader } from './tus.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyLength: number | null;
}

function makeFetch(
  script: ((call: Call) => Response)[],
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body as Uint8Array | undefined;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      bodyLength: body?.byteLength ?? null,
    };
    calls.push(call);
    const handler = script.shift();
    if (handler === undefined) throw new Error('unexpected fetch call');
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const res = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });

const deps = (fetchFn: typeof fetch) => ({
  fetchFn,
  getAccessToken: async () => 'jwt-token',
  storageUrl: 'https://x.supabase.co/storage/v1',
  bucket: 'field-photos',
});

test('fresh upload: create then single PATCH', async () => {
  const bytes = new Uint8Array(1000).fill(7);
  const { fetchFn, calls } = makeFetch([
    () => res(201, { Location: '/upload/resumable/abc123' }),
    () => res(204, { 'Upload-Offset': '1000' }),
  ]);
  const result = await createTusUploader(deps(fetchFn)).upload({
    objectPath: 'agent-1/photo-1.jpg',
    contentType: 'image/jpeg',
    bytes,
    uploadUrl: null,
  });
  assert.equal(result.outcome.kind, 'ok');
  assert.equal(result.uploadUrl, null);

  const create = calls[0];
  assert.ok(create);
  assert.equal(create.method, 'POST');
  assert.equal(create.headers['Upload-Length'], '1000');
  assert.ok(
    create.headers['Upload-Metadata']?.includes(
      `objectName ${btoa('agent-1/photo-1.jpg')}`,
    ),
  );
  assert.ok(create.headers['Upload-Metadata']?.includes(`bucketName ${btoa('field-photos')}`));

  const patch = calls[1];
  assert.ok(patch);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, 'https://x.supabase.co/storage/v1/upload/resumable/abc123');
  assert.equal(patch.headers['Upload-Offset'], '0');
  assert.equal(patch.bodyLength, 1000);
});

test('resume: HEAD finds the offset, PATCH sends only the remainder', async () => {
  const bytes = new Uint8Array(1000).fill(7);
  const { fetchFn, calls } = makeFetch([
    () => res(200, { 'Upload-Offset': '400' }),
    () => res(204, { 'Upload-Offset': '1000' }),
  ]);
  const result = await createTusUploader(deps(fetchFn)).upload({
    objectPath: 'agent-1/photo-1.jpg',
    contentType: 'image/jpeg',
    bytes,
    uploadUrl: 'https://x.supabase.co/storage/v1/upload/resumable/abc123',
  });
  assert.equal(result.outcome.kind, 'ok');
  const patch = calls[1];
  assert.ok(patch);
  assert.equal(patch.headers['Upload-Offset'], '400');
  assert.equal(patch.bodyLength, 600, 'only the un-uploaded remainder is sent');
});

test('expired upload session on HEAD falls back to a fresh creation', async () => {
  const bytes = new Uint8Array(10);
  const { fetchFn, calls } = makeFetch([
    () => res(404),
    () => res(201, { Location: '/upload/resumable/new' }),
    () => res(204, { 'Upload-Offset': '10' }),
  ]);
  const result = await createTusUploader(deps(fetchFn)).upload({
    objectPath: 'a/p.jpg',
    contentType: 'image/jpeg',
    bytes,
    uploadUrl: 'https://x.supabase.co/storage/v1/upload/resumable/dead',
  });
  assert.equal(result.outcome.kind, 'ok');
  assert.equal(calls[1]?.method, 'POST');
});

test('401 maps to auth so the worker can refresh and retry', async () => {
  const { fetchFn } = makeFetch([() => res(401)]);
  const result = await createTusUploader(deps(fetchFn)).upload({
    objectPath: 'a/p.jpg',
    contentType: 'image/jpeg',
    bytes: new Uint8Array(10),
    uploadUrl: null,
  });
  assert.equal(result.outcome.kind, 'auth');
});

test('network failure is transient and preserves the resume URL', async () => {
  const fetchFn = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const result = await createTusUploader(deps(fetchFn)).upload({
    objectPath: 'a/p.jpg',
    contentType: 'image/jpeg',
    bytes: new Uint8Array(10),
    uploadUrl: 'https://x.supabase.co/storage/v1/upload/resumable/abc',
  });
  assert.equal(result.outcome.kind, 'transient');
  assert.equal(result.uploadUrl, 'https://x.supabase.co/storage/v1/upload/resumable/abc');
});
