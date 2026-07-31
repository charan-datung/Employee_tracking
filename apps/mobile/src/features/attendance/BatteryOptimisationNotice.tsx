import { useEffect, useState } from 'react';
import { Device } from '@capacitor/device';
import { kvStore } from '../../lib/kvStore.ts';
import { openAppSettings } from '../../services/location/plugins.ts';
import { oemBatteryGuide, type OemBatteryGuide } from './oemBattery.ts';

// One-time instruction shown after the first check-in. OEM battery killers
// (MIUI, ColorOS, Funtouch, realme UI) stop the foreground service despite
// Android's own rules; the resulting trail gaps are detected server-side, but
// only the agent can fix the phone. Instructions are keyed off
// Device.getInfo().manufacturer because every vendor buries this differently.

const SEEN_KEY = 'datung.battery_notice.seen';

export async function markBatteryNoticeSeen(): Promise<void> {
  await kvStore.set(SEEN_KEY, '1');
}

export async function hasSeenBatteryNotice(): Promise<boolean> {
  return (await kvStore.get(SEEN_KEY)) === '1';
}

export function BatteryOptimisationNotice({ onDone }: { onDone(): void }) {
  const [guide, setGuide] = useState<OemBatteryGuide | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const info = await Device.getInfo();
        setGuide(oemBatteryGuide(info.manufacturer ?? null));
      } catch {
        setGuide(oemBatteryGuide(null));
      }
    })();
  }, []);

  if (guide === null) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white px-6 pb-8 pt-12">
      <div className="mx-auto max-w-md">
        <h1 className="text-2xl font-bold text-gray-900">
          Isang beses lang ito.
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-gray-700">
          Para hindi mapatay ng phone mo ang location tracking habang naka-check
          in ka, kailangang i-allow ang Datung Field na tumakbo sa background.
          Kung mapatay ito, magkakaroon ng butas sa record mo at maaaring
          tanungin ka ng supervisor mo.
        </p>

        <div className="mt-6 rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-emerald-700">
            {guide.brandLabel}
          </p>
          <ol className="mt-3 list-decimal space-y-2.5 pl-5 text-[15px] leading-relaxed text-gray-800">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>

        <button
          type="button"
          onClick={() => void openAppSettings()}
          className="mt-5 h-14 w-full rounded-xl border border-emerald-600 text-lg font-semibold text-emerald-700"
        >
          Buksan ang Settings
        </button>
        <button
          type="button"
          onClick={() => {
            void markBatteryNoticeSeen();
            onDone();
          }}
          className="mt-3 h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white active:bg-emerald-700"
        >
          Tapos na
        </button>
      </div>
    </div>
  );
}
