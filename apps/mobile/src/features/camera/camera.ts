// =============================================================================
// Selfie capture core — getUserMedia ONLY. @capacitor/camera is BANNED here.
//
// Why: @capacitor/camera on Android fires a system camera Intent, handing
// control to whatever camera app the OEM ships. That app's UI is outside our
// control, some OEM camera apps expose a gallery shortcut, and we cannot
// enforce front-facing capture or prevent the agent from picking an existing
// image. For a fraud control, that is disqualifying. The same goes for any
// <input type="file"> — if you find one in this codebase, it is a bug
// (CLAUDE.md rule 6).
//
// getUserMedia works inside the WebView because capacitor.config.ts sets
// androidScheme 'https' (secure context). It needs the app-level
// <uses-permission android:name="android.permission.CAMERA"/> (already in
// AndroidManifest.xml); Capacitor's WebView permission bridge
// (BridgeWebChromeClient.onPermissionRequest) is what grants the page's
// camera request once the app holds the permission. VERIFY ON A REAL DEVICE
// per target Android version — if the bridge misbehaves there, STOP and
// report it. Do not fall back to @capacitor/camera under any circumstance.
// =============================================================================

export type SelfieErrorReason =
  | 'permission_denied'
  | 'no_front_camera'
  | 'camera_unavailable'
  | 'capture_failed';

export class SelfieCaptureError extends Error {
  readonly reason: SelfieErrorReason;

  constructor(reason: SelfieErrorReason, message: string) {
    super(message);
    this.name = 'SelfieCaptureError';
    this.reason = reason;
  }
}

// 2GB phones on LTE: a 4MB selfie will never sync. Longest edge 1280px at
// JPEG quality 0.6 keeps captures in the low-hundreds-of-KB range.
export const MAX_EDGE_PX = 1280;
export const JPEG_QUALITY = 0.6;

// facingMode EXACT — never `ideal`. `ideal` silently falls back to the rear
// camera on devices without a front one, and a rear-camera "selfie" defeats
// the control. If exact fails, we reject loudly instead.
export const SELFIE_CONSTRAINTS = {
  video: { facingMode: { exact: 'user' }, width: { ideal: MAX_EDGE_PX } },
  audio: false,
} as const satisfies MediaStreamConstraints;

export interface MediaDevicesPort {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface StoppableStream {
  getTracks(): { stop(): void }[];
}

// Opens the FRONT camera or throws SelfieCaptureError. Exactly one
// getUserMedia call: an OverconstrainedError (no front camera satisfying
// `exact: 'user'`) must NOT be retried with looser constraints — that path
// ends at the rear camera.
export async function openFrontCameraStream(
  devices: MediaDevicesPort,
): Promise<MediaStream> {
  try {
    return await devices.getUserMedia(SELFIE_CONSTRAINTS);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new SelfieCaptureError('permission_denied', 'camera permission denied');
    }
    if (name === 'OverconstrainedError' || name === 'NotFoundError') {
      throw new SelfieCaptureError(
        'no_front_camera',
        'no camera satisfies facingMode exact user',
      );
    }
    throw new SelfieCaptureError(
      'camera_unavailable',
      error instanceof Error ? error.message : 'camera unavailable',
    );
  }
}

// Idempotent, null-safe. Called on unmount, on capture, and on every error
// path: a leaked MediaStream keeps the Android camera-in-use indicator lit
// permanently and agents will assume they are being filmed all day.
export function stopStream(stream: StoppableStream | null): void {
  if (stream === null) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that refuses to stop must not block stopping the rest.
    }
  }
}

// Downscale so the longest edge is maxEdge. Never upscales.
export function scaleToLongestEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const factor = maxEdge / longest;
  return {
    width: Math.round(width * factor),
    height: Math.round(height * factor),
  };
}

// Grabs the current video frame, downscaled, as a JPEG blob. The frame is
// captured UNMIRRORED (the preview is mirrored via CSS for usability only —
// stored evidence keeps the true orientation).
export async function frameToJpegBlob(video: HTMLVideoElement): Promise<Blob> {
  const source = {
    width: video.videoWidth,
    height: video.videoHeight,
  };
  if (source.width === 0 || source.height === 0) {
    throw new SelfieCaptureError('capture_failed', 'video has no frames yet');
  }
  const target = scaleToLongestEdge(source.width, source.height, MAX_EDGE_PX);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new SelfieCaptureError('capture_failed', 'canvas 2d context unavailable');
  }
  ctx.drawImage(video, 0, 0, target.width, target.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (blob === null) {
    throw new SelfieCaptureError('capture_failed', 'JPEG encode failed');
  }
  return blob;
}
