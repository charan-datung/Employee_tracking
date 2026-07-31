import { Directory, Filesystem } from '@capacitor/filesystem';
import { STORAGE_BUCKET_PHOTOS } from '@datung/shared';
import { base64ToBytes, sha256Hex } from './crypto.ts';
import type { SqlPort } from './db.ts';
import type { createTusUploader } from './tus.ts';
import type { PhotoUploaderPort, PushOutcome } from './types.ts';

// Photos live on the app-private filesystem (Directory.Data — inside the app
// sandbox, no manifest permission needed) and upload to Supabase Storage as
// resumable TUS uploads, separately from their parent record. The parent's
// outbox row depends on the photo row, so a record is only ever marked synced
// once its storage object exists (task rule 8). SHA-256 is computed locally
// and verified server-side against the object.

export interface SavedPhoto {
  photoLocalId: string;
  sha256: string;
  storageObjectPath: string;
  byteSize: number;
}

interface PhotoRow {
  id: string;
  file_path: string;
  storage_object_path: string;
  content_type: string;
  upload_url: string | null;
  uploaded: number;
}

export function createPhotoStore(
  sql: SqlPort,
  deps: { randomUUID(): string; now(): number },
) {
  async function savePhotoLocal(input: {
    agentId: string;
    kind: 'check_in' | 'check_out' | 'visit';
    base64Data: string;
    contentType?: string;
  }): Promise<SavedPhoto> {
    const id = deps.randomUUID();
    const bytes = base64ToBytes(input.base64Data);
    const sha256 = await sha256Hex(bytes);
    const filePath = `photos/${id}.jpg`;
    const storageObjectPath = `${input.agentId}/${id}.jpg`;

    await Filesystem.writeFile({
      path: filePath,
      data: input.base64Data,
      directory: Directory.Data,
      recursive: true,
    });

    await sql.run(
      `insert into photos_local
         (id, kind, file_path, sha256, byte_size, storage_object_path,
          content_type, created_at_device)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        filePath,
        sha256,
        bytes.byteLength,
        storageObjectPath,
        input.contentType ?? 'image/jpeg',
        deps.now(),
      ],
    );

    return { photoLocalId: id, sha256, storageObjectPath, byteSize: bytes.byteLength };
  }

  function createUploader(
    tus: ReturnType<typeof createTusUploader>,
  ): PhotoUploaderPort {
    return {
      async upload(photoLocalId): Promise<PushOutcome> {
        const rows = await sql.query<PhotoRow>(
          `select * from photos_local where id = ?`,
          [photoLocalId],
        );
        const photo = rows[0];
        if (photo === undefined) {
          return { kind: 'permanent', detail: 'photo row missing' };
        }
        if (photo.uploaded === 1) return { kind: 'ok' };

        let base64: string;
        try {
          const file = await Filesystem.readFile({
            path: photo.file_path,
            directory: Directory.Data,
          });
          base64 = typeof file.data === 'string' ? file.data : '';
        } catch {
          // The file is gone (cleared storage?) — unrecoverable, surfaced as
          // a permanent failure, never silently skipped.
          return { kind: 'permanent', detail: 'photo file missing on disk' };
        }

        const result = await tus.upload({
          objectPath: photo.storage_object_path,
          contentType: photo.content_type,
          bytes: base64ToBytes(base64),
          uploadUrl: photo.upload_url,
        });

        if (result.outcome.kind === 'ok') {
          await sql.run(
            `update photos_local set uploaded = 1, upload_url = null where id = ?`,
            [photoLocalId],
          );
        } else {
          // Persist the TUS session so an interrupted upload resumes instead
          // of restarting.
          await sql.run(`update photos_local set upload_url = ? where id = ?`, [
            result.uploadUrl,
            photoLocalId,
          ]);
        }
        return result.outcome;
      },
    };
  }

  return { savePhotoLocal, createUploader, bucket: STORAGE_BUCKET_PHOTOS };
}
