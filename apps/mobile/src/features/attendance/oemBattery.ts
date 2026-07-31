// Per-OEM battery-optimisation instructions.
//
// Android's foreground service is supposed to be exempt from battery
// optimisation. On stock Android it is. On the Chinese OEM skins that
// dominate the Philippine mid-range — MIUI, ColorOS, Funtouch, Realme UI —
// it is not: aggressive proprietary killers stop foreground services anyway,
// and every vendor buries the opt-out in a different screen under a different
// name. An agent whose service is killed looks like a gap in the GPS trail,
// which the server flags (P9) — but the fix has to happen on the phone, so
// the instructions must be exact per brand.
//
// Pure data + lookup: no plugin imports, unit-tested.

export type OemKey =
  | 'xiaomi'
  | 'oppo'
  | 'vivo'
  | 'realme'
  | 'samsung'
  | 'huawei'
  | 'transsion'
  | 'generic';

export interface OemBatteryGuide {
  key: OemKey;
  brandLabel: string;
  /** Ordered, imperative, Taglish. Rendered as a numbered list. */
  steps: string[];
}

// Sub-brands ship the same skin as their parent and hide the setting in the
// same place, so they resolve to the same guide.
const BRAND_ALIASES: Record<string, OemKey> = {
  xiaomi: 'xiaomi',
  redmi: 'xiaomi',
  poco: 'xiaomi',
  'mi': 'xiaomi',
  oppo: 'oppo',
  oneplus: 'oppo',
  vivo: 'vivo',
  iqoo: 'vivo',
  realme: 'realme',
  samsung: 'samsung',
  huawei: 'huawei',
  honor: 'huawei',
  infinix: 'transsion',
  tecno: 'transsion',
  itel: 'transsion',
};

const GUIDES: Record<OemKey, OemBatteryGuide> = {
  xiaomi: {
    key: 'xiaomi',
    brandLabel: 'Xiaomi / Redmi / POCO (MIUI)',
    steps: [
      'Buksan ang Settings → Apps → Manage apps → Datung Field.',
      'Pindutin ang "Battery saver" at piliin ang "No restrictions".',
      'Balik sa Datung Field, i-ON ang "Autostart".',
      'Sa Recents (mga bukas na app), pindutin nang matagal ang Datung Field at pindutin ang padlock 🔒 para hindi ito ma-clear.',
    ],
  },
  oppo: {
    key: 'oppo',
    brandLabel: 'OPPO / OnePlus (ColorOS)',
    steps: [
      'Buksan ang Settings → Battery → App Battery Management (o "Power Saving").',
      'Hanapin ang Datung Field at i-ON ang "Allow background activity" / "Allow foreground activity".',
      'Balik sa Settings → Apps → Startup Manager (o "Auto Startup") at i-ON ang Datung Field.',
      'Sa Recents, i-lock 🔒 ang Datung Field.',
    ],
  },
  vivo: {
    key: 'vivo',
    brandLabel: 'vivo / iQOO (Funtouch OS)',
    steps: [
      'Buksan ang Settings → Battery → Background power consumption management.',
      'Piliin ang Datung Field at payagan ang "High background power consumption".',
      'Buksan ang i Manager → App manager → Autostart manager at i-ON ang Datung Field.',
      'Sa Recents, i-lock 🔒 ang Datung Field.',
    ],
  },
  realme: {
    key: 'realme',
    brandLabel: 'realme (realme UI)',
    steps: [
      'Buksan ang Settings → Battery → App Battery Management.',
      'Piliin ang Datung Field, i-OFF ang "Smart control" at i-ON ang "Allow background running".',
      'Buksan ang Settings → Apps → Startup Manager at i-ON ang Datung Field.',
      'Sa Recents, i-lock 🔒 ang Datung Field.',
    ],
  },
  samsung: {
    key: 'samsung',
    brandLabel: 'Samsung (One UI)',
    steps: [
      'Buksan ang Settings → Battery and device care → Battery.',
      'Pindutin ang "Background usage limits" at siguraduhing WALA ang Datung Field sa "Sleeping apps" at "Deep sleeping apps".',
      'Balik sa Settings → Apps → Datung Field → Battery at piliin ang "Unrestricted".',
    ],
  },
  huawei: {
    key: 'huawei',
    brandLabel: 'Huawei / HONOR (EMUI)',
    steps: [
      'Buksan ang Settings → Battery → App launch.',
      'Hanapin ang Datung Field at i-OFF ang "Manage automatically".',
      'I-ON ang tatlo: Auto-launch, Secondary launch, at Run in background.',
    ],
  },
  transsion: {
    key: 'transsion',
    brandLabel: 'Infinix / TECNO / itel',
    steps: [
      'Buksan ang Settings → Battery → Background app management (o "Power Marathon").',
      'Payagan ang Datung Field na tumakbo sa background.',
      'Buksan ang Phone Master / Power Master → Autostart at i-ON ang Datung Field.',
      'Sa Recents, i-lock 🔒 ang Datung Field.',
    ],
  },
  generic: {
    key: 'generic',
    brandLabel: 'Android',
    steps: [
      'Buksan ang Settings → Apps → Datung Field → Battery.',
      'Piliin ang "Unrestricted" (o "Don\'t optimise").',
      'Sa Recents, i-lock ang Datung Field kung may ganitong option ang phone mo.',
    ],
  },
};

export function oemBatteryGuide(manufacturer: string | null): OemBatteryGuide {
  const normalized = (manufacturer ?? '').trim().toLowerCase();
  if (normalized.length === 0) return GUIDES.generic;
  const direct = BRAND_ALIASES[normalized];
  if (direct !== undefined) {
    const guide = GUIDES[direct];
    return guide;
  }
  // Some devices report "Xiaomi Communications Co., Ltd" or "realme Chongqing".
  for (const [alias, key] of Object.entries(BRAND_ALIASES)) {
    if (normalized.includes(alias)) return GUIDES[key];
  }
  return GUIDES.generic;
}
