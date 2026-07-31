import { App } from '@capacitor/app';
import { Device } from '@capacitor/device';

// =============================================================================
// DEVICE IDENTITY = ANDROID_ID (Settings.Secure.ANDROID_ID), via
// @capacitor/device getId(). On Android 8+ this is a 64-bit hex string unique
// to the {app-signing-key, user, device} combination.
//
// KNOWN LIMITS — read before "fixing" anything around device binding:
//
//   1. It CHANGES ON FACTORY RESET. An agent who resets their phone will come
//      up as a mismatched device and need a supervisor rebind. Expected, not
//      a bug.
//   2. It CHANGES IF THE APP SIGNING KEY CHANGES. Rotating the release
//      keystore casually will UNBIND EVERY AGENT IN THE FIELD AT ONCE and
//      flood supervisors with rebind requests. Do not rotate the keystore
//      without planning a rebind window.
//   3. It CAN BE MANIPULATED ON A ROOTED DEVICE. A rooted phone can spoof
//      ANDROID_ID per app.
//
// Consequence: this is a good control against CASUAL account sharing (handing
// your phone+password to a friend so they can check in for you), not against
// a determined rooted attacker. It is one layer — the selfie, GPS-integrity
// and velocity checks are the others. Layer it, don't rely on it.
// =============================================================================

export interface DeviceIdentity {
  androidId: string;
  deviceModel: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  webviewVersion: string | null;
  appVersion: string | null;
}

const trim = (value: string | undefined, max: number): string | null =>
  value ? value.slice(0, max) : null;

export async function readDeviceIdentity(): Promise<DeviceIdentity> {
  const [{ identifier }, info] = await Promise.all([
    Device.getId(),
    Device.getInfo(),
  ]);

  // App.getInfo() throws when running in a plain browser during development;
  // on device it returns the versionName from the APK.
  let appVersion: string | null = null;
  try {
    appVersion = (await App.getInfo()).version;
  } catch {
    appVersion = null;
  }

  return {
    androidId: identifier,
    deviceModel: trim(info.model, 120),
    manufacturer: trim(info.manufacturer, 120),
    osVersion: trim(info.osVersion, 60),
    // WebView fragmentation on 2GB Android 10-13 devices is a real bug
    // source; this is what server-side reports correlate against.
    webviewVersion: trim(info.webViewVersion, 60),
    appVersion: trim(appVersion ?? undefined, 60),
  };
}
