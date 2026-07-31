import type { PushOutcome } from './types.ts';

// Minimal TUS 1.0 client for Supabase Storage resumable uploads
// (https://tus.io/protocols/resumable-upload). Implemented over fetch instead
// of pulling in tus-js-client, keeping the dependency budget at zero: selfies
// are small, so this is one creation POST and usually one PATCH, with HEAD-
// based resume when an upload was interrupted.

export interface TusDeps {
  fetchFn: typeof fetch;
  getAccessToken(): Promise<string | null>;
  /** e.g. `${SUPABASE_URL}/storage/v1` */
  storageUrl: string;
  bucket: string;
  chunkBytes?: number;
}

export interface TusUploadRequest {
  objectPath: string;
  contentType: string;
  bytes: Uint8Array;
  /** Resume target from a previous attempt, if any. */
  uploadUrl: string | null;
}

export interface TusResult {
  outcome: PushOutcome;
  /** Persist and pass back next time to resume an interrupted upload. */
  uploadUrl: string | null;
}

const toB64 = (value: string): string => btoa(value);

function statusOutcome(status: number, detail: string): PushOutcome {
  if (status === 401) return { kind: 'auth' };
  if (status === 409) return { kind: 'conflict', detail };
  if (status >= 400 && status < 500) return { kind: 'permanent', detail };
  return { kind: 'transient', detail };
}

export function createTusUploader(deps: TusDeps) {
  const chunkBytes = deps.chunkBytes ?? 6 * 1024 * 1024;

  async function authHeaders(): Promise<Record<string, string> | null> {
    const token = await deps.getAccessToken();
    if (token === null) return null;
    return { Authorization: `Bearer ${token}`, 'Tus-Resumable': '1.0.0' };
  }

  async function createUpload(
    req: TusUploadRequest,
    headers: Record<string, string>,
  ): Promise<{ url: string } | { outcome: PushOutcome }> {
    const res = await deps.fetchFn(`${deps.storageUrl}/upload/resumable`, {
      method: 'POST',
      headers: {
        ...headers,
        'Upload-Length': String(req.bytes.byteLength),
        // x-upsert lets a retried creation for the same object path succeed
        // instead of 409ing — retries must never wedge an upload.
        'x-upsert': 'true',
        'Upload-Metadata': [
          `bucketName ${toB64(deps.bucket)}`,
          `objectName ${toB64(req.objectPath)}`,
          `contentType ${toB64(req.contentType)}`,
        ].join(','),
      },
    });
    if (res.status !== 201) {
      return { outcome: statusOutcome(res.status, `tus create ${res.status}`) };
    }
    const location = res.headers.get('Location');
    if (location === null) {
      return { outcome: { kind: 'transient', detail: 'tus create: no Location' } };
    }
    return {
      url: location.startsWith('http')
        ? location
        : `${deps.storageUrl}${location}`,
    };
  }

  async function currentOffset(
    url: string,
    headers: Record<string, string>,
  ): Promise<number | { outcome: PushOutcome }> {
    const res = await deps.fetchFn(url, { method: 'HEAD', headers });
    if (res.status === 404 || res.status === 410) {
      // The upload session expired server-side — caller recreates.
      return { outcome: { kind: 'transient', detail: `tus head ${res.status}` } };
    }
    if (!res.ok) return { outcome: statusOutcome(res.status, `tus head ${res.status}`) };
    const offset = Number(res.headers.get('Upload-Offset') ?? 'NaN');
    if (!Number.isFinite(offset)) {
      return { outcome: { kind: 'transient', detail: 'tus head: no offset' } };
    }
    return offset;
  }

  async function upload(req: TusUploadRequest): Promise<TusResult> {
    try {
      const headers = await authHeaders();
      if (headers === null) {
        return { outcome: { kind: 'auth' }, uploadUrl: req.uploadUrl };
      }

      let url = req.uploadUrl;
      let offset = 0;
      if (url !== null) {
        const head = await currentOffset(url, headers);
        if (typeof head === 'number') {
          offset = head;
        } else {
          // Expired/broken upload session: start over.
          url = null;
        }
      }
      if (url === null) {
        const created = await createUpload(req, headers);
        if ('outcome' in created) return { outcome: created.outcome, uploadUrl: null };
        url = created.url;
        offset = 0;
      }

      while (offset < req.bytes.byteLength) {
        const slice = req.bytes.subarray(offset, offset + chunkBytes);
        const res = await deps.fetchFn(url, {
          method: 'PATCH',
          headers: {
            ...headers,
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
          },
          body: slice as unknown as BodyInit,
        });
        if (res.status !== 204) {
          return {
            outcome: statusOutcome(res.status, `tus patch ${res.status}`),
            uploadUrl: url,
          };
        }
        const next = Number(res.headers.get('Upload-Offset') ?? 'NaN');
        offset = Number.isFinite(next) ? next : offset + slice.byteLength;
      }

      return { outcome: { kind: 'ok' }, uploadUrl: null };
    } catch (error) {
      return {
        outcome: {
          kind: 'transient',
          detail: error instanceof Error ? error.message : 'network failure',
        },
        uploadUrl: req.uploadUrl,
      };
    }
  }

  return { upload };
}
