import { useCallback, useEffect, useRef, useState } from 'react';
import { savePhotoLocal, type SavedPhoto } from '../../services/sync/index.ts';
import { bytesToBase64 } from '../../services/sync/crypto.ts';
import {
  SelfieCaptureError,
  frameToJpegBlob,
  openFrontCameraStream,
  stopStream,
  type SelfieErrorReason,
} from './camera.ts';

// Full-screen selfie capture over getUserMedia. See camera.ts for why
// @capacitor/camera and <input type="file"> are banned (CLAUDE.md rule 6).
//
// MediaStream lifecycle: released on unmount, on capture (the indicator goes
// dark during review), and on every error path — all through one idempotent
// release() so no exit can leak the camera.

const errorCopy: Record<SelfieErrorReason, string> = {
  permission_denied:
    'Kailangan ng camera para sa selfie. I-allow ang camera permission at pindutin ang Subukan Ulit.',
  no_front_camera:
    'Walang front camera na nakita sa device na ito. Hindi puwedeng gumamit ng likod na camera para sa selfie — tawagan ang supervisor mo.',
  camera_unavailable:
    'Hindi mabuksan ang camera. Isara ang ibang app na gumagamit ng camera at subukan ulit.',
  capture_failed: 'Hindi na-save ang kuha. Pakisubukan ulit.',
};

type Phase =
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'review'; blob: Blob; previewUrl: string }
  | { kind: 'saving'; previewUrl: string }
  | { kind: 'error'; reason: SelfieErrorReason };

export interface SelfieCaptureViewProps {
  title: string;
  agentId: string;
  kind: 'check_in' | 'check_out' | 'visit';
  onCaptured(photo: SavedPhoto): void | Promise<void>;
  onCancel(): void;
}

export function SelfieCaptureView(props: SelfieCaptureViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });

  const release = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    try {
      const stream = await openFrontCameraStream(navigator.mediaDevices);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video === null) {
        // Unmounted while the permission prompt was up.
        stopStream(stream);
        streamRef.current = null;
        return;
      }
      video.srcObject = stream;
      await video.play();
      setPhase({ kind: 'live' });
    } catch (error) {
      release();
      setPhase({
        kind: 'error',
        reason:
          error instanceof SelfieCaptureError
            ? error.reason
            : 'camera_unavailable',
      });
    }
  }, [release]);

  useEffect(() => {
    void start();
    return release; // unmount: the camera indicator must go dark
  }, [start, release]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (video === null) return;
    try {
      const blob = await frameToJpegBlob(video);
      release(); // frame is ours — stop filming immediately
      setPhase({ kind: 'review', blob, previewUrl: URL.createObjectURL(blob) });
    } catch (error) {
      release();
      setPhase({
        kind: 'error',
        reason:
          error instanceof SelfieCaptureError ? error.reason : 'capture_failed',
      });
    }
  }, [release]);

  const retake = useCallback(async () => {
    if (phase.kind === 'review') URL.revokeObjectURL(phase.previewUrl);
    await start();
  }, [phase, start]);

  const confirm = useCallback(async () => {
    if (phase.kind !== 'review') return;
    setPhase({ kind: 'saving', previewUrl: phase.previewUrl });
    try {
      // SQLite-first pipeline: the blob goes to the app-private filesystem,
      // SHA-256 is computed (crypto.subtle), and the photos_local row is
      // written — the sync worker uploads later. Nothing here awaits network.
      const bytes = new Uint8Array(await phase.blob.arrayBuffer());
      const saved = await savePhotoLocal({
        agentId: props.agentId,
        kind: props.kind,
        base64Data: bytesToBase64(bytes),
        contentType: 'image/jpeg',
      });
      URL.revokeObjectURL(phase.previewUrl);
      await props.onCaptured(saved);
    } catch {
      URL.revokeObjectURL(phase.previewUrl);
      setPhase({ kind: 'error', reason: 'capture_failed' });
    }
  }, [phase, props]);

  const cancel = useCallback(() => {
    if (phase.kind === 'review' || phase.kind === 'saving') {
      URL.revokeObjectURL(phase.previewUrl);
    }
    release();
    props.onCancel();
  }, [phase, release, props]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <header className="flex items-center justify-between px-5 pb-2 pt-12">
        <h1 className="text-lg font-semibold text-white">{props.title}</h1>
        <button
          type="button"
          onClick={cancel}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white"
          aria-label="Isara"
        >
          ✕
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden">
        {/* Preview is mirrored for usability; the captured JPEG is NOT. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`h-full w-full -scale-x-100 object-cover ${
            phase.kind === 'live' ? '' : 'invisible'
          }`}
        />

        {(phase.kind === 'review' || phase.kind === 'saving') && (
          <img
            src={phase.previewUrl}
            alt="Selfie preview"
            className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
          />
        )}

        {phase.kind === 'live' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {/* Face-sized oval guide; the box-shadow dims everything outside it. */}
            <div
              className="h-[55%] w-[70%] max-w-[320px] rounded-[50%] border-2 border-white/80"
              style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }}
            />
            <p className="absolute bottom-6 px-8 text-center text-sm text-white/90">
              Ilagay ang mukha mo sa loob ng oval. Siguraduhing maliwanag.
            </p>
          </div>
        )}

        {phase.kind === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-white/80">Binubuksan ang camera…</p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-8 text-center">
            <p className="text-base text-white">{errorCopy[phase.reason]}</p>
            {phase.reason !== 'no_front_camera' && (
              <button
                type="button"
                onClick={() => void start()}
                className="h-12 rounded-xl bg-white px-8 text-base font-semibold text-gray-900"
              >
                Subukan Ulit
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-center gap-4 px-6 pb-10 pt-4">
        {phase.kind === 'live' && (
          <button
            type="button"
            onClick={() => void capture()}
            aria-label="Kuhanan"
            className="h-20 w-20 rounded-full border-4 border-white bg-white/20 active:bg-white/40"
          />
        )}
        {(phase.kind === 'review' || phase.kind === 'saving') && (
          <>
            <button
              type="button"
              onClick={() => void retake()}
              disabled={phase.kind === 'saving'}
              className="h-14 flex-1 rounded-xl border border-white/40 text-lg font-semibold text-white disabled:opacity-40"
            >
              Ulitin
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={phase.kind === 'saving'}
              className="h-14 flex-1 rounded-xl bg-emerald-500 text-lg font-semibold text-white disabled:opacity-60"
            >
              {phase.kind === 'saving' ? 'Sine-save…' : 'Gamitin'}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
